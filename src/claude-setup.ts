import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { normalizeArgusBaseUrl, setEnvVarPersistent } from './env-utils';

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

  // Check if hooks are already configured for this server (strict base match, not substring)
  const existingHooks = settings.hooks as Record<string, unknown> | undefined;
  if (existingHooks) {
    const firstHook = existingHooks['SessionStart'] as Array<{ hooks: Array<{ url: string }> }> | undefined;
    const u = firstHook?.[0]?.hooks?.[0]?.url;
    const base = normalizeArgusBaseUrl(serverUrl);
    if (u && (u === base || u.startsWith(`${base}/`))) {
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

/**
 * Remove HTTP hooks whose URL targets this Argus server (from ~/.claude/settings.json).
 * Returns true if the file was modified.
 */
export function removeClaudeHooksForServer(serverBaseUrl: string): boolean {
  const normalized = normalizeArgusBaseUrl(serverBaseUrl);
  if (!normalized) { return false; }

  const claudeDir = join(homedir(), '.claude');
  const settingsFile = join(claudeDir, 'settings.json');
  if (!existsSync(settingsFile)) { return false; }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
  } catch {
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') { return false; }

  const prefix = `${normalized}/`;
  let changed = false;

  for (const key of Object.keys(hooks)) {
    const block = hooks[key];
    if (!Array.isArray(block)) { continue; }

    const newBlock: unknown[] = [];
    for (const entry of block) {
      if (!entry || typeof entry !== 'object') {
        newBlock.push(entry);
        continue;
      }
      const e = entry as { hooks?: unknown[] };
      if (!Array.isArray(e.hooks)) {
        newBlock.push(entry);
        continue;
      }
      const filtered = e.hooks.filter((h: unknown) => {
        if (!h || typeof h !== 'object') { return true; }
        const hook = h as { type?: string; url?: string };
        if (hook.type !== 'http' || typeof hook.url !== 'string') { return true; }
        const u = hook.url;
        if (u === normalized || u.startsWith(prefix)) {
          changed = true;
          return false;
        }
        return true;
      });
      if (filtered.length === 0) {
        changed = true;
        continue;
      }
      if (filtered.length !== e.hooks.length) { changed = true; }
      newBlock.push({ ...e, hooks: filtered });
    }

    if (newBlock.length === 0) {
      delete hooks[key];
      changed = true;
    } else {
      hooks[key] = newBlock as unknown[];
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
    changed = true;
  }

  if (!changed) { return false; }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return true;
}
