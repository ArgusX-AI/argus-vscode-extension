import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setEnvVarPersistent } from './env-utils';

const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'SubagentStart', 'SubagentStop',
  'Notification', 'InstructionsLoaded',
  'PreCompact', 'PostCompact', 'PermissionRequest',
];

/**
 * Write Claude Code HTTP hooks to ~/.claude/settings.json.
 * Returns true if new hooks were written, false if already configured.
 */
export async function configureClaudeHooks(serverUrl: string): Promise<boolean> {
  const claudeDir = join(homedir(), '.claude');
  const settingsFile = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const hooks: Record<string, unknown> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [{
      hooks: [{
        type: 'http',
        url: `${serverUrl}/hooks/${event}`,
        headers: { 'X-Argus-User': process.platform === 'win32' ? '$USERNAME' : '$USER' },
        allowedEnvVars: ['USER', 'USERNAME'],
      }],
    }];
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    } catch {
      // Corrupted settings, start fresh
    }
  }

  // Check if hooks are already configured for this server
  const existingHooks = settings.hooks as Record<string, unknown> | undefined;
  if (existingHooks) {
    const firstHook = existingHooks['SessionStart'] as Array<{ hooks: Array<{ url: string }> }> | undefined;
    if (firstHook?.[0]?.hooks?.[0]?.url?.includes(serverUrl)) {
      return false;
    }
  }

  settings.hooks = { ...existingHooks, ...hooks };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

/**
 * Set ANTHROPIC_BASE_URL persistently across shells.
 */
export async function configureClaudeEnvVar(serverUrl: string): Promise<void> {
  await setEnvVarPersistent('ANTHROPIC_BASE_URL', serverUrl);
}
