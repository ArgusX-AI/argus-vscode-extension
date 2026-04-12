import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

/**
 * Validate that a URL is safe for shell interpolation.
 * Only allows http/https URLs with no shell metacharacters.
 */
export function validateUrl(url: string): void {
  if (!/^https?:\/\/[a-zA-Z0-9.\-_:\/]+$/.test(url)) {
    throw new Error(`Invalid URL: "${url}" contains disallowed characters`);
  }
}

/** Strip trailing slashes for stable Argus base URL comparison. */
export function normalizeArgusBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Env names Argus reads/clears via persistent store (defense in depth for shell/PowerShell). */
const KNOWN_PERSISTENT_ENV = /^(ANTHROPIC_BASE_URL|OPENAI_BASE_URL|GOOGLE_GEMINI_BASE_URL)$/;

function stripShellQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function readUnixProfileEnv(varName: string): string | undefined {
  const home = homedir();
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, '.profile'),
    join(home, '.config', 'fish', 'config.fish'),
  ];
  const bashRe = new RegExp(`^\\s*export\\s+${esc}=(.*)$`, 'm');
  const fishRe = new RegExp(`^\\s*set\\s+-gx\\s+${esc}\\s+(\\S+)`, 'm');
  for (const p of paths) {
    if (!existsSync(p)) { continue; }
    const c = readFileSync(p, 'utf-8');
    let m = c.match(bashRe);
    if (m) { return stripShellQuotes(m[1]); }
    m = c.match(fishRe);
    if (m) { return stripShellQuotes(m[1]); }
  }
  return undefined;
}

/**
 * Read a user-persisted env value (Windows User scope or common shell profiles).
 */
export function getPersistentEnvVar(varName: string): string | undefined {
  if (!KNOWN_PERSISTENT_ENV.test(varName)) {
    return undefined;
  }
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('${varName}', 'User')"`,
        { encoding: 'utf-8' }
      ).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return process.env[varName];
    }
  }
  return readUnixProfileEnv(varName) ?? process.env[varName];
}

/** True if the persisted value equals the expected URL (ignoring trailing slashes). */
export function argusEnvVarMatches(varName: string, expectedUrl: string): boolean {
  const cur = getPersistentEnvVar(varName);
  if (!cur) { return false; }
  return normalizeArgusBaseUrl(cur) === normalizeArgusBaseUrl(expectedUrl);
}

/**
 * Remove a user-persisted environment variable (opposite of setEnvVarPersistent).
 */
export async function removeEnvVarPersistent(varName: string): Promise<void> {
  if (!KNOWN_PERSISTENT_ENV.test(varName)) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execSync(
        'powershell -command "' +
        `[System.Environment]::SetEnvironmentVariable('${varName}', $null, 'User'); ` +
        'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class WinEnvRm { [DllImport(\\\"user32.dll\\\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult); }\'; ' +
        '$r = [UIntPtr]::Zero; [WinEnvRm]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, \'Environment\', 2, 5000, [ref]$r)"',
        { stdio: 'ignore' }
      );
    } catch { /* best effort */ }
    delete process.env[varName];
    return;
  }

  const home = homedir();
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bashExportLine = new RegExp(`^\\s*export\\s+${esc}=.*$\\n?`, 'gm');
  const fishLine = new RegExp(`^\\s*set\\s+-gx\\s+${esc}\\s+.*$\\n?`, 'gm');

  const profilePaths = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, '.profile'),
    join(home, '.config', 'fish', 'config.fish'),
  ];

  for (const path of profilePaths) {
    if (!existsSync(path)) { continue; }
    const content = readFileSync(path, 'utf-8');
    if (!content.includes(varName)) { continue; }
    const isFish = path.endsWith('config.fish');
    const next = content
      .replace(isFish ? fishLine : bashExportLine, '')
      .replace(/\n{3,}/g, '\n\n');
    writeFileSync(path, next);
  }

  if (process.platform === 'darwin') {
    try {
      execSync(`launchctl unsetenv ${varName}`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  delete process.env[varName];
}

/**
 * Persist an environment variable across shells and sessions.
 * Windows: user-level env var + WM_SETTINGCHANGE broadcast.
 * macOS/Linux: appends to shell profiles. macOS also uses launchctl.
 * All platforms: sets process.env for the current process.
 */
export async function setEnvVarPersistent(varName: string, value: string): Promise<void> {
  validateUrl(value);

  if (process.platform === 'win32') {
    try {
      execSync(
        `powershell -command "` +
        `[System.Environment]::SetEnvironmentVariable('${varName}', '${value}', 'User'); ` +
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WinEnv { [DllImport(\\\"user32.dll\\\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult); }'; ` +
        `$r = [UIntPtr]::Zero; [WinEnv]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)"`,
        { stdio: 'ignore' }
      );
    } catch {
      // Fallback: just set for current process
    }
    process.env[varName] = value;
    return;
  }

  // macOS / Linux: update all common shell profiles that exist
  const home = homedir();
  const bashExport = `export ${varName}="${value}"`;
  const fishExport = `set -gx ${varName} "${value}"`;
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const varRegex = new RegExp(`^.*${escaped}[= ].*$`, 'gm');

  const profiles: Array<{ path: string; line: string; regex: RegExp }> = [
    { path: join(home, '.bashrc'), line: bashExport, regex: varRegex },
    { path: join(home, '.zshrc'), line: bashExport, regex: varRegex },
    { path: join(home, '.profile'), line: bashExport, regex: varRegex },
    { path: join(home, '.config', 'fish', 'config.fish'), line: fishExport, regex: varRegex },
  ];

  for (const { path, line, regex } of profiles) {
    if (!existsSync(path)) { continue; }
    const content = readFileSync(path, 'utf-8');
    if (content.includes(varName)) {
      writeFileSync(path, content.replace(regex, line));
    } else {
      writeFileSync(path, content + `\n# Argus AI Observability\n${line}\n`);
    }
  }

  // macOS: set via launchctl for GUI-launched terminals
  if (process.platform === 'darwin') {
    try {
      execSync(`launchctl setenv ${varName} "${value}"`, { stdio: 'ignore' });
    } catch { /* ignore */ }
  }

  process.env[varName] = value;
}
