import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { validateUrl, normalizeArgusBaseUrl } from './env-utils';

const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'sessionEnd',
  'beforeSubmitPrompt',
  'afterAgentResponse', 'afterAgentThought',
  'preToolUse', 'postToolUse',
  'beforeShellExecution', 'afterShellExecution',
  'beforeMCPExecution', 'afterMCPExecution',
  'afterFileEdit',
  'stop',
  'preCompact',
  'subagentStart', 'subagentStop',
];

const BRIDGE_SCRIPT_SH = `#!/usr/bin/env bash
# Cursor hook bridge — forwards Cursor hook events to Argus via HTTP.
EVENT_NAME="$1"
SERVER_URL="$2"
PAYLOAD=$(cat)
USER="\${USER:-\${USERNAME:-unknown}}"
curl -s -X POST "$SERVER_URL/hooks/CursorRequest" \\
  -H "Content-Type: application/json" \\
  -H "X-Argus-User: $USER" \\
  -H "X-Argus-Source: cursor" \\
  -H "X-Cursor-Hook-Event: $EVENT_NAME" \\
  -d "$PAYLOAD" \\
  -o /dev/null --max-time 5 2>/dev/null &
echo '{"continue": true}'
exit 0
`;

const BRIDGE_SCRIPT_PS1 = `# Cursor hook bridge — forwards Cursor hook events to Argus via HTTP.
param(
    [Parameter(Position = 0, Mandatory)]
    [string]$EventName,
    [Parameter(Position = 1, Mandatory)]
    [string]$ServerUrl
)
$payload = [Console]::In.ReadToEnd()
$user = if ($env:USERNAME) { $env:USERNAME } else { "unknown" }
try {
    Invoke-RestMethod -Uri "$ServerUrl/hooks/CursorRequest" \`
        -Method Post -ContentType "application/json" \`
        -Headers @{ "X-Argus-User" = $user; "X-Argus-Source" = "cursor"; "X-Cursor-Hook-Event" = $EventName } \`
        -Body $payload -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}
Write-Output '{"continue": true}'
exit 0
`;

function installBridgeScript(): string {
  const bridgeDir = join(homedir(), '.argus', 'bin');
  mkdirSync(bridgeDir, { recursive: true });

  if (process.platform === 'win32') {
    const bridgePath = join(bridgeDir, 'cursor-hook-bridge.ps1');
    writeFileSync(bridgePath, BRIDGE_SCRIPT_PS1, 'utf-8');
    return bridgePath;
  }

  const bridgePath = join(bridgeDir, 'cursor-hook-bridge.sh');
  writeFileSync(bridgePath, BRIDGE_SCRIPT_SH, 'utf-8');
  chmodSync(bridgePath, 0o755);
  return bridgePath;
}

function buildHookCommand(bridgePath: string, eventName: string, serverUrl: string): string {
  if (process.platform === 'win32') {
    return `powershell -ExecutionPolicy Bypass -File "${bridgePath}" ${eventName} ${serverUrl}`;
  }
  return `bash "${bridgePath}" ${eventName} ${serverUrl}`;
}

function isAlreadyConfigured(settings: Record<string, unknown>, serverUrl: string): boolean {
  const hooks = settings.hooks as Record<string, Array<{ command?: string }>> | undefined;
  if (!hooks?.['sessionStart']?.[0]?.command) { return false; }
  return hooks['sessionStart'][0].command.includes(serverUrl);
}

/**
 * Configure Cursor hooks in ~/.cursor/hooks.json.
 * Merges with existing hooks — preserves non-Argus hooks.
 * Returns true if new hooks were written, false if already configured.
 */
export async function configureCursorHooks(serverUrl: string): Promise<boolean> {
  validateUrl(serverUrl);
  const bridgePath = installBridgeScript();

  const cursorDir = join(homedir(), '.cursor');
  const hooksFile = join(cursorDir, 'hooks.json');

  mkdirSync(cursorDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(hooksFile)) {
    try {
      settings = JSON.parse(readFileSync(hooksFile, 'utf-8'));
    } catch {
      // Corrupted or empty file, start fresh
    }
  }

  if (isAlreadyConfigured(settings, serverUrl)) {
    return false;
  }

  const existingHooks = settings.hooks as Record<string, unknown> | undefined;
  const newHooks: Record<string, unknown[]> = {};
  for (const event of CURSOR_HOOK_EVENTS) {
    newHooks[event] = [{ command: buildHookCommand(bridgePath, event, serverUrl) }];
  }

  settings.version = 1;
  settings.hooks = { ...existingHooks, ...newHooks };
  writeFileSync(hooksFile, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

/**
 * Remove Argus hooks from ~/.cursor/hooks.json for the given server URL.
 * Returns true if the file was modified.
 */
export function removeCursorHooksForServer(serverBaseUrl: string): boolean {
  const normalized = normalizeArgusBaseUrl(serverBaseUrl);
  if (!normalized) { return false; }

  const hooksFile = join(homedir(), '.cursor', 'hooks.json');
  if (!existsSync(hooksFile)) { return false; }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(hooksFile, 'utf-8'));
  } catch {
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') { return false; }

  let changed = false;

  for (const key of Object.keys(hooks)) {
    const block = hooks[key];
    if (!Array.isArray(block)) { continue; }

    const filtered = block.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') { return true; }
      const e = entry as { command?: string };
      if (typeof e.command !== 'string') { return true; }
      if (e.command.includes(normalized)) {
        changed = true;
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      delete hooks[key];
    } else {
      hooks[key] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  if (!changed) { return false; }
  writeFileSync(hooksFile, JSON.stringify(settings, null, 2) + '\n');
  return true;
}
