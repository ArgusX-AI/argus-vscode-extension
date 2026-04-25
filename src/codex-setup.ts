/**
 * OpenAI Codex capture setup — orchestrates multi-layer capture.
 *
 * Layer 0: Rollout JSONL watcher (PRIMARY) — read-only file tailing
 * Layer 1: OTEL telemetry (SECONDARY) — local OTLP HTTP server
 * Layer 2: CLI hooks (macOS/Linux only) — bridge script in ~/.codex/hooks.json
 *
 * SAFETY: This module NEVER modifies sandbox settings or OPENAI_BASE_URL.
 * The config writer only touches the [otel] block in config.toml.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { validateUrl } from './env-utils';
import { detectCodex } from './codex-detect';
import { startCodexOtelCapture, stopCodexOtelCapture, getCodexOtelStats } from './codex-otel';
import { startCodexRolloutWatcher, stopCodexRolloutWatcher, getCodexRolloutStats } from './codex-rollout';
import { isDebugDumpEnabled, dumpProcessedEvent } from './codex-debug-dump';

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
 * Safe config.toml writer — ONLY touches the [otel] block.
 * NEVER modifies sandbox_mode, [windows], or any sandbox-related keys.
 */
function configureCodexOtelConfig(port: number, logger: (msg: string) => void): boolean {
  const codexDir = join(homedir(), '.codex');
  const configFile = join(codexDir, 'config.toml');

  mkdirSync(codexDir, { recursive: true });

  let originalContent = '';
  if (existsSync(configFile)) {
    try {
      originalContent = readFileSync(configFile, 'utf-8');

      const backupPath = configFile + '.bak';
      if (!existsSync(backupPath)) {
        copyFileSync(configFile, backupPath);
        logger(`[codex] Backed up config.toml to ${backupPath}`);
      }
    } catch {
      // Start fresh if unreadable
    }
  }

  const targetEndpoint = `http://127.0.0.1:${port}`;

  // Migration: older Argus versions wrote `exporter = "otlp-http"` as a string
  // key inside [otel], which conflicts with [otel.exporter."otlp-http"] table
  // header and breaks Codex's TOML parser. stripOtelBlock handles this
  // implicitly, but log when we encounter it for diagnostics.
  if (/^exporter\s*=\s*"otlp-http"/m.test(originalContent)) {
    logger('[codex] detected stale exporter="otlp-http" key from older Argus — will rewrite');
  }

  if (
    originalContent.includes(`endpoint = "${targetEndpoint}"`) &&
    originalContent.includes('protocol = "json"')
  ) {
    logger('[codex] OTEL config already points to our endpoint (json protocol)');
    return false;
  }

  const newContent = replaceOtelBlock(originalContent, port);

  assertNoSandboxMutation(originalContent, newContent);

  writeFileSync(configFile, newContent, 'utf-8');
  logger(`[codex] OTEL configured in ${configFile} → ${targetEndpoint}`);

  verifyWrittenConfig(configFile, port, logger);
  return true;
}

function replaceOtelBlock(content: string, port: number): string {
  const otelLines = [
    '[otel]',
    'log_user_prompt = true',
    '',
    '[otel.exporter."otlp-http"]',
    `endpoint = "http://127.0.0.1:${port}"`,
    'protocol = "json"',
  ];

  const stripped = stripOtelBlock(content);
  const trimmed = stripped.trimEnd();
  const separator = trimmed.length > 0 ? '\n\n' : '';
  return trimmed + separator + otelLines.join('\n') + '\n';
}

function stripOtelBlock(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let insideOtelBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (isOtelSectionHeader(trimmed)) {
      insideOtelBlock = true;
      continue;
    }

    if (insideOtelBlock && isSectionHeader(trimmed) && !isOtelSectionHeader(trimmed)) {
      insideOtelBlock = false;
    }

    if (!insideOtelBlock) {
      result.push(line);
    }
  }

  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  if (result.length > 0) {
    result.push('');
  }

  return result.join('\n');
}

function isSectionHeader(line: string): boolean {
  return /^\[.+\]$/.test(line);
}

function isOtelSectionHeader(line: string): boolean {
  return line === '[otel]' || line.startsWith('[otel.');
}

/**
 * Hard safety guard: throws if a write would change any line containing "sandbox".
 */
function assertNoSandboxMutation(original: string, updated: string): void {
  const originalSandbox = original.split('\n').filter(l => /sandbox/i.test(l));
  const updatedSandbox = updated.split('\n').filter(l => /sandbox/i.test(l));

  if (originalSandbox.length !== updatedSandbox.length) {
    throw new Error(
      `codex-config safety violation: sandbox line count changed ` +
      `(${originalSandbox.length} → ${updatedSandbox.length}). Aborting config write.`
    );
  }

  for (let i = 0; i < originalSandbox.length; i++) {
    if (originalSandbox[i] !== updatedSandbox[i]) {
      throw new Error(
        `codex-config safety violation: sandbox line modified. Aborting config write.`
      );
    }
  }
}

function verifyWrittenConfig(configFile: string, port: number, logger: (msg: string) => void): void {
  try {
    const verify = readFileSync(configFile, 'utf-8');
    const hasOtelHeader = /^\s*\[otel\]\s*$/m.test(verify);
    const hasEndpoint = verify.includes(`endpoint = "http://127.0.0.1:${port}"`);
    const hasProtocol = verify.includes('protocol = "json"');
    const openBrackets = (verify.match(/\[/g) ?? []).length;
    const closeBrackets = (verify.match(/\]/g) ?? []).length;
    if (!hasOtelHeader || !hasEndpoint || !hasProtocol || openBrackets !== closeBrackets) {
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
      if (isDebugDumpEnabled()) {
        dumpProcessedEvent({ _source: source, ...payload });
      }
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
      const req = mod.request(options, (res: { statusCode?: number; resume: () => void }) => {
        res.resume();
      });
      req.on('error', () => {});
      req.write(body);
      req.end();
    };

  // Layer 0: Rollout JSONL watcher (PRIMARY — always works, no config dep)
  const rolloutOk = startCodexRolloutWatcher(makeSender('rollout'), logger, user);
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

  // NOTE: Layer 3 (OPENAI_BASE_URL proxy) intentionally removed.
  // Setting OPENAI_BASE_URL interferes with Codex's API routing and
  // is unnecessary — rollout + OTEL capture everything we need.

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
