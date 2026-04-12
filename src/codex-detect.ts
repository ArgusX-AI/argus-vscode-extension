import * as vscode from 'vscode';
import { execSync } from 'child_process';

export interface CodexStatus {
  /** True if the Codex CLI is installed and in PATH. */
  cliInstalled: boolean;
  cliVersion: string | null;
  /** True if the OpenAI VS Code extension (openai.chatgpt) is installed. */
  extensionInstalled: boolean;
  extensionVersion: string | null;
  /** True if CLI hooks are supported on this platform (disabled on Windows). */
  hooksSupported: boolean;
}

/**
 * Detect OpenAI Codex CLI and VS Code extension.
 */
export function detectCodex(): CodexStatus {
  // Check VS Code extension
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  const extensionVersion = (ext?.packageJSON as Record<string, unknown>)?.version as string | undefined;

  // Check CLI
  let cliInstalled = false;
  let cliVersion: string | null = null;
  try {
    const output = execSync('codex --version', {
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    cliInstalled = true;
    // Parse version from output (e.g., "codex 1.2.3" or just "1.2.3")
    const match = output.match(/(\d+\.\d+\.\d+)/);
    cliVersion = match ? match[1] : output;
  } catch {
    // CLI not installed or not in PATH
  }

  return {
    cliInstalled,
    cliVersion,
    extensionInstalled: !!ext,
    extensionVersion: extensionVersion ?? null,
    hooksSupported: process.platform !== 'win32',
  };
}
