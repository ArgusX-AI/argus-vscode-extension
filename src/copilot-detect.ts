import * as vscode from 'vscode';

export interface CopilotStatus {
  /** True if either github.copilot or github.copilot-chat is installed. */
  installed: boolean;
  coreInstalled: boolean;
  chatInstalled: boolean;
  version: string | null;
}

/**
 * Detect whether any GitHub Copilot VS Code extension is installed.
 * Modern Copilot Chat (v0.40+) can run standalone without the core extension.
 */
export function detectCopilot(): CopilotStatus {
  const copilot = vscode.extensions.getExtension('github.copilot');
  const chat = vscode.extensions.getExtension('github.copilot-chat');
  const coreVersion = (copilot?.packageJSON as Record<string, unknown>)?.version as string | undefined;
  const chatVersion = (chat?.packageJSON as Record<string, unknown>)?.version as string | undefined;
  return {
    installed: !!copilot || !!chat,
    coreInstalled: !!copilot,
    chatInstalled: !!chat,
    version: coreVersion ?? chatVersion ?? null,
  };
}
