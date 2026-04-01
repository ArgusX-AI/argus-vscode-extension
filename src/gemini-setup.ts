import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { setEnvVarPersistent, validateUrl } from './env-utils';

const GEMINI_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd',
  'BeforeTool', 'AfterTool',
  'BeforeAgent', 'AfterAgent',
  'BeforeModel', 'AfterModel',
  'Notification',
];

// Canonical bridge script content — kept in sync with scripts/gemini-hook-bridge.ps1
const BRIDGE_SCRIPT_PS1 = `# Gemini CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
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
        -Headers @{ "X-Argus-User" = $user; "X-Argus-Source" = "gemini-cli" } \`
        -Body $payload -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}
Write-Output '{}'
exit 0
`;

// Canonical bridge script content — kept in sync with scripts/gemini-hook-bridge.sh
const BRIDGE_SCRIPT_SH = `#!/usr/bin/env bash
# Gemini CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
EVENT_NAME="$1"
SERVER_URL="$2"
PAYLOAD=$(cat)
USER="\${USER:-\${USERNAME:-unknown}}"
curl -s -X POST "$SERVER_URL/hooks/$EVENT_NAME" \\
  -H "Content-Type: application/json" \\
  -H "X-Argus-User: $USER" \\
  -H "X-Argus-Source: gemini-cli" \\
  -d "$PAYLOAD" \\
  -o /dev/null --max-time 5 2>/dev/null || true
echo '{}'
exit 0
`;

/**
 * Install the Gemini hook bridge script to ~/.argus/bin/.
 * Returns the absolute path to the installed bridge script.
 */
export function installBridgeScript(): string {
  const bridgeDir = join(homedir(), '.argus', 'bin');
  mkdirSync(bridgeDir, { recursive: true });

  if (process.platform === 'win32') {
    const bridgePath = join(bridgeDir, 'gemini-hook-bridge.ps1');
    writeFileSync(bridgePath, BRIDGE_SCRIPT_PS1, 'utf-8');
    return bridgePath;
  }

  const bridgePath = join(bridgeDir, 'gemini-hook-bridge.sh');
  writeFileSync(bridgePath, BRIDGE_SCRIPT_SH, 'utf-8');
  chmodSync(bridgePath, 0o755);
  return bridgePath;
}

/**
 * Detect which PowerShell executable is available on Windows.
 * Prefers pwsh (PowerShell 7+), falls back to powershell (5.1).
 * Result is memoized to avoid spawning a child process per hook event.
 */
let cachedPwsh: string | null = null;
function detectPowerShell(): string {
  if (cachedPwsh) { return cachedPwsh; }
  try {
    execSync('pwsh -Version', { stdio: 'ignore' });
    cachedPwsh = 'pwsh';
  } catch {
    cachedPwsh = 'powershell';
  }
  return cachedPwsh;
}

/**
 * Build the command string for a Gemini CLI hook event.
 * The serverUrl is validated before this function is called.
 */
function buildHookCommand(bridgePath: string, eventName: string, serverUrl: string): string {
  if (process.platform === 'win32') {
    const pwsh = detectPowerShell();
    return `${pwsh} -ExecutionPolicy Bypass -File "${bridgePath}" ${eventName} ${serverUrl}`;
  }
  return `bash "${bridgePath}" ${eventName} ${serverUrl}`;
}

/**
 * Strip UTF-8 BOM (0xEF 0xBB 0xBF) from a file if present.
 * PowerShell 5.1 writes UTF-8 with BOM, which Gemini CLI rejects.
 */
function stripBom(filePath: string): void {
  const raw = readFileSync(filePath);
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    writeFileSync(filePath, raw.subarray(3));
  }
}

/**
 * Check if Gemini hooks are already configured for a given server URL.
 */
function isAlreadyConfigured(settings: Record<string, unknown>, serverUrl: string): boolean {
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ name?: string; command?: string }> }>> | undefined;
  if (!hooks?.['SessionStart']?.[0]?.hooks) { return false; }
  return hooks['SessionStart'][0].hooks.some(
    h => h.name === 'argus' && h.command?.includes(serverUrl)
  );
}

/**
 * Configure Gemini CLI hooks in ~/.gemini/settings.json.
 * Returns true if new hooks were written, false if already configured.
 */
export async function configureGeminiCliHooks(serverUrl: string): Promise<boolean> {
  validateUrl(serverUrl);
  const bridgePath = installBridgeScript();

  const geminiDir = join(homedir(), '.gemini');
  const settingsFile = join(geminiDir, 'settings.json');

  mkdirSync(geminiDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      let content = readFileSync(settingsFile, 'utf-8');
      // Strip BOM character if present before parsing
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }
      settings = JSON.parse(content);
    } catch {
      // Corrupted or empty settings, start fresh
    }
  }

  if (isAlreadyConfigured(settings, serverUrl)) {
    return false;
  }

  // Build new hooks, then merge with any existing hooks (preserve non-Argus hooks)
  const existingHooks = settings.hooks as Record<string, unknown> | undefined;
  const newHooks: Record<string, unknown> = {};
  for (const event of GEMINI_HOOK_EVENTS) {
    newHooks[event] = [{
      matcher: '*',
      hooks: [{
        name: 'argus',
        type: 'command',
        command: buildHookCommand(bridgePath, event, serverUrl),
      }],
    }];
  }

  settings.hooks = { ...existingHooks, ...newHooks };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');

  // Defensive BOM strip (in case file was previously written by PowerShell)
  if (process.platform === 'win32') {
    stripBom(settingsFile);
  }

  return true;
}

/**
 * Set GOOGLE_GEMINI_BASE_URL persistently across shells.
 */
export async function configureGeminiEnvVar(serverUrl: string): Promise<void> {
  await setEnvVarPersistent('GOOGLE_GEMINI_BASE_URL', serverUrl + '/google');
}
