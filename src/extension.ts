import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { configureClaudeHooks, configureClaudeEnvVar } from './claude-setup';
import { configureGeminiCliHooks, configureGeminiEnvVar } from './gemini-setup';
import { detectGeminiCodeAssist } from './gemini-code-assist';
import { setupCopilotCapture, teardownCopilotCapture } from './copilot-setup';
import { getInterceptStats, sendTestEvent } from './copilot-intercept';
import { getDiagnosticsStats, probeLmApiTransport } from './copilot-diagnostics';
import { startLmMonitor, stopLmMonitor, getLmStatus } from './copilot-lm-monitor';
import { getLmInterceptStats } from './copilot-lm-intercept';
import { getOtelStats } from './copilot-otel';

function httpRequest(urlStr: string, options: { timeout?: number } = {}): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(urlStr, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          json: () => Promise.resolve(JSON.parse(data)),
        });
      });
    });
    if (options.timeout) {
      req.setTimeout(options.timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
    }
    req.on('error', reject);
  });
}

let statusBarItem: vscode.StatusBarItem;
let connected = false;
let connectionInProgress = false;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  // Set OTEL env vars FIRST — before Copilot Chat reads them.
  // These take precedence over VS Code settings per Copilot's docs.
  process.env.COPILOT_OTEL_ENABLED = 'true';
  process.env.COPILOT_OTEL_CAPTURE_CONTENT = 'true';

  // Create output channel FIRST and log immediately — this is the primary diagnostic
  outputChannel = vscode.window.createOutputChannel('Argus');
  outputChannel.appendLine(`[Argus] Extension activating... (v0.20.0)`);
  outputChannel.appendLine(`[Argus] VS Code: ${vscode.version}, Node: ${process.version}, Platform: ${process.platform}`);
  outputChannel.appendLine(`[Argus] fetch available: ${typeof globalThis.fetch}, pid: ${process.pid}`);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'argus.showStatus';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('argus.connect', connectToServer),
    vscode.commands.registerCommand('argus.disconnect', disconnectFromServer),
    vscode.commands.registerCommand('argus.openDashboard', openDashboard),
    vscode.commands.registerCommand('argus.showStatus', showStatus),
    vscode.commands.registerCommand('argus.showCopilotLog', () => outputChannel.show()),
    vscode.commands.registerCommand('argus.testCopilotCapture', async () => {
      const stats = getInterceptStats();
      const lm = getLmStatus();
      if (!stats.active) {
        vscode.window.showWarningMessage('Argus: Copilot interception is not active.');
        return;
      }
      const ok = await sendTestEvent();
      if (ok) {
        vscode.window.showInformationMessage(
          `Argus: Test event sent to server. Intercepted: ${stats.totalIntercepted}, ` +
          `Proto fallbacks: ${stats.protoFallbackCount}, LM: ${lm.available ? lm.modelIds.join(', ') : 'not detected'}`
        );
      } else {
        vscode.window.showErrorMessage('Argus: Failed to send test event. Check output channel for details.');
      }
    }),
    vscode.commands.registerCommand('argus.copilotStatus', () => {
      const stats = getInterceptStats();
      const diag = getDiagnosticsStats();
      const lm = getLmStatus();
      const lmIntercept = getLmInterceptStats();
      const lines = [
        `Active: ${stats.active}`,
        `Total intercepted: ${stats.totalIntercepted}`,
        `Proto fallbacks: ${stats.protoFallbackCount}`,
        `TLS proto intercepts: ${stats.tlsProtoInterceptCount}`,
        `Diagnostics active: ${diag.active}`,
        `Diagnostics intercepts: ${diag.interceptCount}`,
        `Diagnostics channels: ${diag.channels.join(', ') || 'none'}`,
        `Domains seen: ${stats.domainsSeen.join(', ') || 'none'}`,
        `Server: ${stats.serverUrl}`,
        `LM available: ${lm.available}`,
        `LM models: ${lm.modelIds.join(', ') || 'none'}`,
        `--- OTEL Capture (Primary Chat Capture) ---`,
        `OTEL active: ${getOtelStats().active}`,
        `OTEL captures: ${getOtelStats().captureCount}`,
        `OTEL file: ${getOtelStats().otelFilePath}`,
        `OTEL file offset: ${getOtelStats().fileOffset}`,
        `--- LM Intercept (Fallback) ---`,
        `LM intercept active: ${lmIntercept.active}`,
        `LM intercept location: ${lmIntercept.patchLocation ?? 'none'}`,
        `LM intercept count: ${lmIntercept.interceptCount}`,
      ];
      outputChannel.appendLine(`\n--- Copilot Status ---\n${lines.join('\n')}\n---`);
      outputChannel.show();
    }),
    vscode.commands.registerCommand('argus.probeLmTransport', async () => {
      outputChannel.appendLine('\n--- LM Transport Probe ---');
      outputChannel.show();
      const result = await probeLmApiTransport((msg) => {
        outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
      });
      outputChannel.appendLine(`[probe] Result: ${result}`);
      outputChannel.appendLine('--- End Probe ---\n');
      vscode.window.showInformationMessage(`Argus LM Probe: ${result}`);
    }),
  );

  // Apply Copilot interception patches IMMEDIATELY during activation.
  const config = vscode.workspace.getConfiguration('argus');
  const enableCopilot = config.get<boolean>('enableCopilot', true);
  const serverUrl = config.get<string>('serverUrl', 'http://54.196.154.205:4080');
  const rawUser = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  const debug = config.get<boolean>('copilotDebugMode', false);

  outputChannel.appendLine(`[Argus] Config: enableCopilot=${enableCopilot}, serverUrl=${serverUrl}, user=${rawUser}, debug=${debug}`);

  const logger = (msg: string) => {
    outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  };

  if (enableCopilot) {
    try {
      outputChannel.appendLine('[Argus] Starting Copilot capture setup...');
      setupCopilotCapture(serverUrl, rawUser, logger, debug).then((ok) => {
        if (ok) {
          outputChannel.appendLine('[Argus] Copilot interception ACTIVE');
          startLmMonitor(logger);
        } else {
          outputChannel.appendLine('[Argus] Copilot not detected — interception skipped. Starting LM monitor as fallback.');
          startLmMonitor(logger);
        }
      }).catch((err) => {
        outputChannel.appendLine(`[Argus] Copilot setup promise error: ${err}`);
      });
    } catch (copilotErr) {
      outputChannel.appendLine(`[Argus] Copilot setup sync error: ${copilotErr}`);
    }
  } else {
    outputChannel.appendLine('[Argus] Copilot capture disabled in settings');
  }

  // Auto-connect on startup (deferred to not block activation)
  if (config.get<boolean>('autoConnect', true)) {
    // Use setTimeout to defer — ensures activation returns quickly
    setTimeout(connectToServer, 0);
  }
}

async function connectToServer() {
  if (connectionInProgress) { return; }
  connectionInProgress = true;

  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = config.get<string>('serverUrl', 'http://54.196.154.205:4080');

  if (!serverUrl) {
    vscode.window.showErrorMessage('Argus: No server URL configured. Set argus.serverUrl in settings.');
    connectionInProgress = false;
    return;
  }

  updateStatusBar('connecting');

  try {
    // 1. Check server health
    const response = await httpRequest(`${serverUrl}/api/health`, { timeout: 5000 });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    // 2. Configure Claude Code hooks
    const claudeConfigured = await configureClaudeHooks(serverUrl);

    // 3. Set ANTHROPIC_BASE_URL
    await configureClaudeEnvVar(serverUrl);

    // 4. Configure Gemini CLI hooks (non-fatal)
    let geminiCliConfigured = false;
    const enableGeminiCli = config.get<boolean>('enableGeminiCli', true);
    if (enableGeminiCli) {
      try {
        geminiCliConfigured = await configureGeminiCliHooks(serverUrl);
        await configureGeminiEnvVar(serverUrl);
      } catch (geminiErr) {
        console.log('[Argus] Gemini CLI setup skipped:', geminiErr);
      }
    }

    // 5. Detect Gemini Code Assist
    const enableGeminiCodeAssist = config.get<boolean>('enableGeminiCodeAssist', true);
    const geminiCodeAssist = enableGeminiCodeAssist ? detectGeminiCodeAssist() : { installed: false, version: null };

    // 6. Copilot interception was already started in activate() — just check status
    const enableCopilot = config.get<boolean>('enableCopilot', true);
    const copilotConfigured = enableCopilot; // Already set up in activate()

    connected = true;
    updateStatusBar('connected');

    // 7. Build success message
    const configured: string[] = [];
    if (claudeConfigured) { configured.push('Claude Code'); }
    if (geminiCliConfigured) { configured.push('Gemini CLI'); }
    if (copilotConfigured) { configured.push('GitHub Copilot'); }

    const parts: string[] = [`Argus connected to ${serverUrl}`];
    if (configured.length > 0) {
      parts.push(`Hooks configured: ${configured.join(', ')}`);
    }
    if (geminiCodeAssist.installed) {
      parts.push('Gemini Code Assist detected (proxy observability)');
    }

    vscode.window.showInformationMessage(
      parts.join('. ') + '.',
      'Open Dashboard'
    ).then(action => {
      if (action === 'Open Dashboard') {
        openDashboard();
      }
    });
  } catch (err) {
    connected = false;
    updateStatusBar('error');
    const msg = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showErrorMessage(`Failed to connect to Argus: ${msg}`);
  } finally {
    connectionInProgress = false;
  }
}

async function disconnectFromServer() {
  try { stopLmMonitor(); } catch { /* best effort */ }
  try { await teardownCopilotCapture(); } catch { /* best effort */ }
  connected = false;
  updateStatusBar('disconnected');
  vscode.window.showInformationMessage('Argus disconnected');
}

function openDashboard() {
  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = config.get<string>('serverUrl', 'http://54.196.154.205:4080');
  vscode.env.openExternal(vscode.Uri.parse(serverUrl));
}

async function showStatus() {
  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = config.get<string>('serverUrl', 'http://54.196.154.205:4080');

  if (!connected) {
    const action = await vscode.window.showInformationMessage(
      `Argus is not connected. Server: ${serverUrl}`,
      'Connect', 'Open Settings'
    );
    if (action === 'Connect') {
      connectToServer();
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'argus');
    }
    return;
  }

  try {
    const [healthRes, onboardingRes] = await Promise.all([
      httpRequest(`${serverUrl}/api/health`).then(r => r.json()) as Promise<Record<string, unknown>>,
      httpRequest(`${serverUrl}/api/onboarding/status`).then(r => r.json()) as Promise<Record<string, unknown>>,
    ]);

    const info = [
      `Server: ${serverUrl}`,
      `Status: Connected`,
      `Sessions: ${(onboardingRes as Record<string, unknown>).sessionCount ?? 0}`,
      `Requests: ${(onboardingRes as Record<string, unknown>).requestCount ?? 0}`,
      `Users: ${(onboardingRes as Record<string, unknown>).userCount ?? 0}`,
    ];

    const action = await vscode.window.showInformationMessage(
      info.join(' | '),
      'Open Dashboard', 'Disconnect'
    );

    if (action === 'Open Dashboard') {
      openDashboard();
    } else if (action === 'Disconnect') {
      disconnectFromServer();
    }
  } catch {
    vscode.window.showErrorMessage('Failed to fetch Argus status');
  }
}

function updateStatusBar(state: 'connected' | 'disconnected' | 'connecting' | 'error') {
  const config = vscode.workspace.getConfiguration('argus');
  if (!config.get<boolean>('showStatusBar', true)) {
    statusBarItem.hide();
    return;
  }

  switch (state) {
    case 'connected':
      statusBarItem.text = '$(eye) Argus';
      statusBarItem.tooltip = 'Argus: Connected - Click for status';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'disconnected':
      statusBarItem.text = '$(eye-closed) Argus';
      statusBarItem.tooltip = 'Argus: Disconnected - Click to connect';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'connecting':
      statusBarItem.text = '$(loading~spin) Argus';
      statusBarItem.tooltip = 'Argus: Connecting...';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(warning) Argus';
      statusBarItem.tooltip = 'Argus: Connection error';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
  statusBarItem.show();
}

export async function deactivate() {
  try { stopLmMonitor(); } catch { /* best effort */ }
  try { await teardownCopilotCapture(); } catch { /* best effort */ }
  statusBarItem?.dispose();
}
