import * as vscode from 'vscode';

interface GeminiCodeAssistStatus {
  installed: boolean;
  version: string | null;
}

/**
 * Detect whether the Gemini Code Assist VS Code extension is installed.
 *
 * Gemini Code Assist does not expose a hooks API like Gemini CLI.
 * Observability is limited to proxy-based capture via GOOGLE_GEMINI_BASE_URL
 * (if the extension respects it) and presence detection.
 *
 * Enterprise users with Gemini Code Assist Enterprise can enable
 * Cloud Logging for full observability. If/when Gemini Code Assist
 * adds a hooks API, this module should be updated to use it.
 */
export function detectGeminiCodeAssist(): GeminiCodeAssistStatus {
  const ext = vscode.extensions.getExtension('google.geminicodeassist');
  if (!ext) {
    return { installed: false, version: null };
  }
  const version = (ext.packageJSON as Record<string, unknown>)?.version as string | undefined;
  return { installed: true, version: version ?? null };
}
