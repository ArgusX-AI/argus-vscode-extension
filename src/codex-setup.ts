/**
 * OpenAI Codex capture setup — orchestrates multi-layer capture.
 *
 * Layer 1: OTEL telemetry (all platforms, PRIMARY) — local OTLP HTTP server
 * Layer 2: CLI hooks (macOS/Linux only) — bridge script in ~/.codex/hooks.json
 * Layer 3: Proxy via OPENAI_BASE_URL (all platforms) — routes API calls through Argus
 *
 * NOTE: Codex CLI hooks are currently disabled on Windows.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { setEnvVarPersistent, validateUrl } from './env-utils';
import { detectCodex } from './codex-detect';
import { startCodexOtelCapture, stopCodexOtelCapture, getCodexOtelStats } from './codex-otel';
import { startCodexRolloutWatcher, stopCodexRolloutWatcher, getCodexRolloutStats } from './codex-rollout';

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
];

// Bridge scripts — reuse the same pattern as Gemini CLI

const BRIDGE_SCRIPT_PS1 = `# Codex CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
param(
    [Parameter(Position = 0, Mandatory)]
    [string]$EventName,
    [Parameter(Position = 1, Mandatory)]
    [string]$ServerUrl
)
$payload = [Console]::In.ReadToEnd()
$user = if ($env:USERNAME) { $env:USERNAME } else { "unknown" }
try {
    Invoke-RestMethod -Uri "$ServerUrl/hooks/$EventName" \`
        -Method Post -ContentType "application/json" \`
        -Headers @{ "X-Argus-User" = $user; "X-Argus-Source" = "codex" } \`
        -Body $payload -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}
Write-Output '{}'
exit 0
`;

const BRIDGE_SCRIPT_SH = `#!/usr/bin/env bash
# Codex CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
EVENT_NAME="$1"
SERVER_URL="$2"
PAYLOAD=$(cat)
USER="\${USER:-\${USERNAME:-unknown}}"
curl -s -X POST "$SERVER_URL/hooks/$EVENT_NAME" \\
  -H "Content-Type: application/json" \\
  -H "X-Argus-User: $USER" \\
  -H "X-Argus-Source: codex" \\
  -d "$PAYLOAD" \\
  -o /dev/null --max-time 5 2>/dev/null || true
echo '{}'
exit 0
`;

/**
 * Install the Codex hook bridge script to ~/.argus/bin/.
 */
function installBridgeScript(): string {
  const bridgeDir = join(homedir(), '.argus', 'bin');
  mkdirSync(bridgeDir, { recursive: true });

  if (process.platform === 'win32') {
    const bridgePath = join(bridgeDir, 'codex-hook-bridge.ps1');
    writeFileSync(bridgePath, BRIDGE_SCRIPT_PS1, 'utf-8');
    return bridgePath;
  }

  const bridgePath = join(bridgeDir, 'codex-hook-bridge.sh');
  writeFileSync(bridgePath, BRIDGE_SCRIPT_SH, 'utf-8');
  chmodSync(bridgePath, 0o755);
  return bridgePath;
}

/**
 * Detect available PowerShell executable on Windows.
 */
let cachedPwsh: string | null = null;
function detectPowerShell(): string {
  if (cachedPwsh) return cachedPwsh;
  try {
    execSync('pwsh -Version', { stdio: 'ignore' });
    cachedPwsh = 'pwsh';
  } catch {
    cachedPwsh = 'powershell';
  }
  return cachedPwsh;
}

function buildHookCommand(bridgePath: string, eventName: string, serverUrl: string): string {
  if (process.platform === 'win32') {
    const pwsh = detectPowerShell();
    return `${pwsh} -ExecutionPolicy Bypass -File "${bridgePath}" ${eventName} ${serverUrl}`;
  }
  return `bash "${bridgePath}" ${eventName} ${serverUrl}`;
}

/**
 * Configure Codex CLI hooks in ~/.codex/hooks.json.
 * Returns true if new hooks were written, false if already configured.
 */
function configureCodexCliHooks(serverUrl: string, logger: (msg: string) => void): boolean {
  // Hooks are disabled on Windows
  if (process.platform === 'win32') {
    logger('[codex] CLI hooks are currently disabled on Windows. Skipping hook configuration.');
    return false;
  }

  const bridgePath = installBridgeScript();
  const codexDir = join(homedir(), '.codex');
  const hooksFile = join(codexDir, 'hooks.json');

  mkdirSync(codexDir, { recursive: true });

  let hooks: Record<string, unknown> = {};
  if (existsSync(hooksFile)) {
    try {
      let content = readFileSync(hooksFile, 'utf-8');
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      hooks = JSON.parse(content);
    } catch {
      // Corrupted or empty, start fresh
    }
  }

  // Check if already configured
  const existing = hooks as Record<string, Array<{ hooks?: Array<{ name?: string; command?: string }> }>>;
  if (existing['SessionStart']?.[0]?.hooks?.some(h => h.name === 'argus' && h.command?.includes(serverUrl))) {
    logger('[codex] CLI hooks already configured');
    return false;
  }

  // Build new hooks
  const newHooks: Record<string, unknown> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    newHooks[event] = [{
      matcher: '*',
      hooks: [{
        name: 'argus',
        type: 'command',
        command: buildHookCommand(bridgePath, event, serverUrl),
      }],
    }];
  }

  const mergedHooks = { ...hooks, ...newHooks };
  writeFileSync(hooksFile, JSON.stringify(mergedHooks, null, 2), 'utf-8');
  logger(`[codex] CLI hooks configured in ${hooksFile} for ${CODEX_HOOK_EVENTS.length} events`);
  return true;
}

/**
 * Normalize Codex sandbox settings so the Windows admin sandbox does not
 * block the VS Code extension host. The elevated sandbox requires UAC
 * elevation to provision local helper users and silently fails under the
 * non-interactive extension host (openai/codex#14808). Forcing
 * workspace-write + unelevated Windows sandbox skips that code path while
 * keeping file-write isolation and leaves OTEL capture intact.
 *
 * Returns updated content plus whether anything changed. Respects a
 * pre-existing top-level `sandbox_mode` key — only the known-broken
 * `[windows] sandbox = "elevated"` value is rewritten.
 */
function normalizeCodexSandboxConfig(content: string): { content: string; changed: boolean } {
  let next = content;
  let changed = false;

  if (!/^\s*sandbox_mode\s*=/m.test(next)) {
    next = `sandbox_mode = "workspace-write"\n` + next;
    changed = true;
  }

  const windowsElevated = /(\[windows\][^\[]*?sandbox\s*=\s*")elevated(")/;
  if (windowsElevated.test(next)) {
    next = next.replace(windowsElevated, '$1unelevated$2');
    changed = true;
  }

  return { content: next, changed };
}

/**
 * Configure Codex OTEL in ~/.codex/config.toml.
 * Injects/replaces the [otel] section to point to our local OTLP server,
 * and normalizes sandbox settings so the Windows admin sandbox doesn't
 * block the extension host.
 */
function configureCodexOtelConfig(port: number, logger: (msg: string) => void): boolean {
  const codexDir = join(homedir(), '.codex');
  const configFile = join(codexDir, 'config.toml');

  mkdirSync(codexDir, { recursive: true });

  const otelSection = `[otel]
exporter = "otlp-http"
log_user_prompt = true

[otel.exporter.otlp-http]
endpoint = "http://127.0.0.1:${port}"
`;

  let content = '';
  if (existsSync(configFile)) {
    try {
      content = readFileSync(configFile, 'utf-8');

      // Back up original before modifying
      const backupPath = configFile + '.bak';
      if (!existsSync(backupPath)) {
        copyFileSync(configFile, backupPath);
        logger(`[codex] Backed up config.toml to ${backupPath}`);
      }
    } catch {
      // Start fresh if unreadable
    }
  }

  const sandboxNormalized = normalizeCodexSandboxConfig(content);
  content = sandboxNormalized.content;
  if (sandboxNormalized.changed) {
    logger('[codex] normalized sandbox config → workspace-write / windows=unelevated');
  }

  const otelAlreadyOurs = content.includes(`endpoint = "http://127.0.0.1:${port}"`);

  if (!otelAlreadyOurs) {
    const otelRegex = /\[otel\][\s\S]*?(?=\n\[[^\]]*\](?!\.)|\s*$)/;
    const otelExporterRegex = /\[otel\.exporter[^\]]*\][\s\S]*?(?=\n\[[^\]]*\](?!\.)|\s*$)/g;

    if (otelRegex.test(content)) {
      content = content.replace(otelRegex, '');
      content = content.replace(otelExporterRegex, '');
      content = content.replace(/\n{3,}/g, '\n\n').trim();
      content += '\n\n' + otelSection;
    } else {
      content = content.trim() + (content.trim() ? '\n\n' : '') + otelSection;
    }
  } else if (!sandboxNormalized.changed) {
    logger('[codex] OTEL config already points to our endpoint');
    return false;
  }

  writeFileSync(configFile, content, 'utf-8');
  if (otelAlreadyOurs) {
    logger(`[codex] sandbox config updated in ${configFile}`);
  } else {
    logger(`[codex] OTEL configured in ${configFile} → http://127.0.0.1:${port}`);
  }

  // Validate the file we just wrote — catch malformed TOML before Codex
  // silently ignores it. We don't ship a full TOML parser, so we do a cheap
  // structural check: re-read, ensure the `[otel]` header and our endpoint
  // line are present on distinct lines, and bracket counts are balanced.
  try {
    const verify = readFileSync(configFile, 'utf-8');
    const hasOtelHeader = /^\s*\[otel\]\s*$/m.test(verify);
    const hasEndpoint = verify.includes(`endpoint = "http://127.0.0.1:${port}"`);
    const openBrackets = (verify.match(/\[/g) ?? []).length;
    const closeBrackets = (verify.match(/\]/g) ?? []).length;
    if (!hasOtelHeader || !hasEndpoint || openBrackets !== closeBrackets) {
      logger(
        `[codex] WARNING: config.toml validation failed — ` +
        `hasOtelHeader=${hasOtelHeader} hasEndpoint=${hasEndpoint} ` +
        `brackets=${openBrackets}/${closeBrackets}. ` +
        `Rollout watcher will still capture events.`,
      );
    }
  } catch (err) {
    logger(`[codex] WARNING: could not re-read config.toml for validation: ${err instanceof Error ? err.message : String(err)}`);
  }

  return true;
}

/**
 * Log a warning if OTEL stays silent for 60 seconds — useful signal that the
 * user is running Codex < 0.105 (where `exec` / `mcp-server` emit nothing) or
 * that config.toml was overwritten by another tool.
 */
let otelHealthTimer: NodeJS.Timeout | null = null;
function scheduleOtelHealthWarning(logger: (msg: string) => void): void {
  if (otelHealthTimer) clearTimeout(otelHealthTimer);
  otelHealthTimer = setTimeout(() => {
    otelHealthTimer = null;
    const stats = getCodexOtelStats();
    const rollout = getCodexRolloutStats();
    if (stats.totalHttpRequests === 0) {
      logger(
        `[codex] WARNING: OTEL receiver has 0 HTTP requests after 60s. ` +
        `Check \`codex --version\` (>= 0.105 required for \`exec\` / \`mcp-server\` OTEL). ` +
        `Rollout watcher events emitted: ${rollout.eventsEmitted} — primary capture is ${rollout.active ? 'active' : 'INACTIVE'}.`,
      );
    } else {
      logger(`[codex] OTEL health check OK — ${stats.totalHttpRequests} requests received`);
    }
  }, 60_000);
  // Don't keep the extension host alive just for this timer.
  if (typeof otelHealthTimer.unref === 'function') otelHealthTimer.unref();
}

/**
 * Main setup entry point — orchestrates all capture layers.
 */
export async function setupCodexCapture(
  serverUrl: string,
  user: string,
  logger: (msg: string) => void = () => {},
  debug = false,
): Promise<boolean> {
  validateUrl(serverUrl);

  const status = detectCodex();
  logger(
    `[codex] Detection: cli=${status.cliInstalled}(${status.cliVersion ?? '-'}) ` +
    `ext=${status.extensionInstalled}(${status.extensionVersion ?? '-'}) ` +
    `hooks=${status.hooksSupported}`,
  );

  if (!status.cliInstalled && !status.extensionInstalled) {
    logger('[codex] Neither Codex CLI nor VS Code extension detected — skipping capture');
    return false;
  }

  // Shared sender — posts any payload to /hooks/CodexRequest with a source tag
  // so the server can dedupe between rollout and OTEL events.
  const makeSender = (source: 'rollout' | 'otel') =>
    (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      const url = new URL(`${serverUrl}/hooks/CodexRequest`);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Argus-User': user,
          'X-Argus-Source': 'codex',
          'X-Argus-Codex-Source': source,
        },
        timeout: 5000,
      };

      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const req = mod.request(options, (res: { resume: () => void }) => { res.resume(); });
      req.on('error', () => { /* fire and forget */ });
      req.write(body);
      req.end();
    };

  // Layer 0: Rollout JSONL watcher (PRIMARY — always works, no config dep)
  const rolloutOk = startCodexRolloutWatcher(makeSender('rollout'), logger);
  logger(`[codex] Layer 0 (rollout-watcher): ${rolloutOk ? 'on' : 'off'}`);

  // Layer 1: OTEL telemetry (secondary — structural gaps documented in plan)
  const otelOk = await startCodexOtelCapture(makeSender('otel'), logger);
  if (otelOk) {
    const stats = getCodexOtelStats();
    logger(`[codex] Layer 1 (otlp-receiver): on (port ${stats.serverPort})`);

    // Configure config.toml AFTER the server is bound and listening.
    // startCodexOtelCapture already awaits server.listen callback before
    // returning, so the port is guaranteed bound here.
    configureCodexOtelConfig(stats.serverPort, logger);

    // Health watchdog — if OTEL stays silent for 60s after Codex is detected,
    // warn the user. Codex < 0.105 has known OTEL gaps for `exec`/`mcp-server`.
    scheduleOtelHealthWarning(logger);
  } else {
    logger('[codex] Layer 1 (otlp-receiver): failed');
  }

  // Layer 2: CLI hooks (non-Windows only)
  if (status.cliInstalled && status.hooksSupported) {
    try {
      const configured = configureCodexCliHooks(serverUrl, logger);
      if (configured) {
        logger('[codex] Layer 2 (CLI hooks) configured');
      } else {
        logger('[codex] Layer 2 (CLI hooks) already set up');
      }
    } catch (err) {
      logger(`[codex] Layer 2 (CLI hooks) error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!status.hooksSupported) {
    logger('[codex] Layer 2 (CLI hooks) skipped — not supported on Windows');
  }

  // Layer 3: Proxy via OPENAI_BASE_URL
  if (status.cliInstalled) {
    try {
      await setEnvVarPersistent('OPENAI_BASE_URL', serverUrl + '/openai');
      logger(`[codex] Layer 3 (proxy) OPENAI_BASE_URL set to ${serverUrl}/openai`);
    } catch (err) {
      logger(`[codex] Layer 3 (proxy) error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return true;
}

/**
 * Teardown — stop OTEL capture and the rollout watcher.
 */
export async function teardownCodexCapture(): Promise<void> {
  if (otelHealthTimer) {
    clearTimeout(otelHealthTimer);
    otelHealthTimer = null;
  }
  stopCodexRolloutWatcher();
  stopCodexOtelCapture();
}
