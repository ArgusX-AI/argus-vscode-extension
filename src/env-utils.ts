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
