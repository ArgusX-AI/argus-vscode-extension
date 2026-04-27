import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { configureClaudeHooks, configureClaudeEnvVar, removeClaudeHooksForServer } from './claude-setup';
import { argusEnvVarMatches, normalizeArgusBaseUrl, removeEnvVarPersistent } from './env-utils';
import { configureGeminiCliHooks, configureGeminiEnvVar } from './gemini-setup';
// GCA intercept REMOVED in v0.27.3 — two independent monkey-patches on https.request
// caused Copilot capture to break. See Lessons Learned: "NEVER have two modules
// independently monkey-patch the same Node.js built-in."
import { setupCopilotCapture, teardownCopilotCapture } from './copilot-setup';
import { getInterceptStats, sendTestEvent } from './copilot-intercept';
import { getDiagnosticsStats, probeLmApiTransport } from './copilot-diagnostics';
import { startLmMonitor, stopLmMonitor, getLmStatus } from './copilot-lm-monitor';
import { getLmInterceptStats } from './copilot-lm-intercept';
import { getOtelStats, PREFERRED_OTLP_PORT } from './copilot-otel';
import { setupCodexCapture, teardownCodexCapture } from './codex-setup';
import { getCodexOtelStats, CODEX_OTLP_PORT } from './codex-otel';
import { enableDebugDump, disableDebugDump, getDebugDumpDir } from './codex-debug-dump';

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
const DEFAULT_SERVER_URL = 'http://54.175.211.160:4080';

async function teardownArgusProviderEnv(serverUrl: string, log: (msg: string) => void): Promise<void> {
  const base = normalizeArgusBaseUrl(serverUrl);
  if (!base) { return; }
  try {
    if (removeClaudeHooksForServer(base)) {
      log(`[Argus] Removed Claude Code hooks for ${base}`);
    }
  } catch (e) {
    log(`[Argus] Claude hook cleanup error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (argusEnvVarMatches('ANTHROPIC_BASE_URL', base)) {
    await removeEnvVarPersistent('ANTHROPIC_BASE_URL');
    log('[Argus] Cleared user ANTHROPIC_BASE_URL');
  }
  // NOTE: OPENAI_BASE_URL teardown removed — extension no longer sets it.
  const google = `${base}/google`;
  if (argusEnvVarMatches('GOOGLE_GEMINI_BASE_URL', google)) {
    await removeEnvVarPersistent('GOOGLE_GEMINI_BASE_URL');
    log('[Argus] Cleared user GOOGLE_GEMINI_BASE_URL');
  }
}

function getConfiguredServerUrl(config = vscode.workspace.getConfiguration('argus')): string {
  return (config.get<string>('serverUrl', DEFAULT_SERVER_URL) ?? '').trim();
}

function checkWorkspaceConfigMismatch(config: vscode.WorkspaceConfiguration): void {
  const inspection = config.inspect<string>('serverUrl');
  if (!inspection) { return; }
  const { globalValue, workspaceValue } = inspection;
  if (workspaceValue && globalValue && workspaceValue !== globalValue) {
    vscode.window.showWarningMessage(
      `Argus: Workspace settings override server URL to "${workspaceValue}" (user setting is "${globalValue}").`,
      'Use User Setting', 'Keep Workspace'
    ).then(action => {
      if (action === 'Use User Setting') {
        config.update('serverUrl', globalValue, vscode.ConfigurationTarget.Workspace);
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Set OTEL env vars FIRST — before Copilot Chat reads them.
  // These take precedence over VS Code settings per Copilot's docs.
  process.env.COPILOT_OTEL_ENABLED = 'true';
  process.env.COPILOT_OTEL_CAPTURE_CONTENT = 'true';
  // Also set the standard OTEL capture content env var that Copilot's code sets internally
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'true';

  // Pre-set the OTLP endpoint to the fixed port BEFORE Copilot reads it.
  // Both env vars AND VS Code settings must be set here — Copilot caches
  // the endpoint at activation time, so it must see the correct port immediately.
  // If the preferred port is busy, startOtelCapture() will update the setting
  // to the actual port later, but the common case (port available) works on first load.
  const otlpEndpoint = `http://127.0.0.1:${PREFERRED_OTLP_PORT}`;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
  process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'none';

  // ALWAYS force-write all OTEL settings — conditional checks read stale values
  // and cause port mismatches (e.g., setting says 14319 but server is on 14318).
  const copilotChatConfig = vscode.workspace.getConfiguration('github.copilot.chat');
  copilotChatConfig.update('otel.otlpEndpoint', otlpEndpoint, vscode.ConfigurationTarget.Global);
  copilotChatConfig.update('otel.exporterType', 'otlp-http', vscode.ConfigurationTarget.Global);
  copilotChatConfig.update('otel.enabled', true, vscode.ConfigurationTarget.Global);
  copilotChatConfig.update('otel.captureContent', true, vscode.ConfigurationTarget.Global);

  // Create output channel FIRST and log immediately — this is the primary diagnostic
  outputChannel = vscode.window.createOutputChannel('Argus');
  outputChannel.appendLine(`[Argus] Extension activating... (v0.27.3)`);
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
    vscode.commands.registerCommand('argus.resetLocalProxyConfig', resetLocalArgusProxyConfig),
    vscode.commands.registerCommand('argus.openDashboard', openDashboard),
    vscode.commands.registerCommand('argus.showStatus', showStatus),
    vscode.commands.registerCommand('argus.showCopilotLog', () => outputChannel.show()),
    vscode.commands.registerCommand('argus.openOtelDebugFolder', async () => {
      const folder = vscode.Uri.file(require('path').join(require('os').homedir(), 'Desktop', 'argus-otel-debug'));
      try {
        await vscode.env.openExternal(folder);
      } catch (err) {
        vscode.window.showErrorMessage(`Argus: couldn't open debug folder — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('argus.openCodexDebugFolder', async () => {
      const dumpDir = getDebugDumpDir();
      const folder = vscode.Uri.file(dumpDir ?? require('path').join(require('os').homedir(), 'Desktop', 'argus-codex-debug'));
      try {
        await vscode.env.openExternal(folder);
      } catch (err) {
        vscode.window.showErrorMessage(`Argus: couldn't open Codex debug folder — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
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
        `OTEL port: ${getOtelStats().serverPort} (${getOtelStats().isFixedPort ? 'fixed' : 'random'})`,
        `OTEL HTTP requests: ${getOtelStats().totalHttpRequests}`,
        `OTEL parse errors: ${getOtelStats().parseErrors}`,
        `OTEL file watcher: ${getOtelStats().fileWatcherActive ? 'active' : 'inactive'}`,
        `OTEL file records: ${getOtelStats().fileRecordCount}`,
        `--- LM Intercept (Fallback) ---`,
        `LM intercept active: ${lmIntercept.active}`,
        `LM intercept location: ${lmIntercept.patchLocation ?? 'none'}`,
        `LM intercept count: ${lmIntercept.interceptCount}`,
      ];
      outputChannel.appendLine(`\n--- Copilot Status ---\n${lines.join('\n')}\n---`);
      outputChannel.show();
    }),
    vscode.commands.registerCommand('argus.geminiCodeAssistStatus', () => {
      outputChannel.appendLine('[Argus] Gemini Code Assist intercept removed in v0.27.3 — caused monkey-patch conflict with Copilot');
      outputChannel.show();
    }),
    vscode.commands.registerCommand('argus.openGcaDebugFolder', () => {
      outputChannel.appendLine('[Argus] Gemini Code Assist intercept removed in v0.27.3');
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
  const serverUrl = getConfiguredServerUrl(config);
  const rawUser = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  const debug = config.get<boolean>('copilotDebugMode', false);

  outputChannel.appendLine(`[Argus] Config: enableCopilot=${enableCopilot}, serverUrl=${serverUrl}, user=${rawUser}, debug=${debug}`);

  const logger = (msg: string) => {
    outputChannel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  };

  if (enableCopilot && serverUrl) {
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
    outputChannel.appendLine(enableCopilot
      ? '[Argus] Copilot capture skipped - no Argus server URL configured'
      : '[Argus] Copilot capture disabled in settings');
  }

  // OpenAI Codex capture
  const enableCodex = config.get<boolean>('enableCodex', true);
  const codexDebug = config.get<boolean>('codexDebugMode', false);
  if (codexDebug) {
    const dumpDir = enableDebugDump();
    outputChannel.appendLine(`[Argus] Codex debug dump enabled → ${dumpDir}`);
  }
  if (enableCodex && serverUrl) {
    try {
      outputChannel.appendLine('[Argus] Starting Codex capture setup...');
      setupCodexCapture(serverUrl, rawUser, logger, codexDebug).then((ok) => {
        if (ok) {
          outputChannel.appendLine('[Argus] Codex capture ACTIVE');
        } else {
          outputChannel.appendLine('[Argus] Codex not detected — capture skipped');
        }
      }).catch((err) => {
        outputChannel.appendLine(`[Argus] Codex setup error: ${err}`);
      });
    } catch (codexErr) {
      outputChannel.appendLine(`[Argus] Codex setup sync error: ${codexErr}`);
    }
  } else {
    outputChannel.appendLine(enableCodex
      ? '[Argus] Codex capture skipped - no Argus server URL configured'
      : '[Argus] Codex capture disabled in settings');
  }

  // Gemini Code Assist capture — DISABLED in v0.27.3 (monkey-patch conflict with Copilot)
  outputChannel.appendLine('[Argus] Gemini Code Assist intercept disabled in v0.27.3 — use GCA detection only');

  // Auto-connect on startup (deferred to not block activation)
  if (config.get<boolean>('autoConnect', true) && serverUrl) {
    // Use setTimeout to defer — ensures activation returns quickly
    setTimeout(connectToServer, 0);
  } else if (config.get<boolean>('autoConnect', true)) {
    outputChannel.appendLine('[Argus] Auto-connect skipped - no Argus server URL configured');
  }
}

async function connectToServer() {
  if (connectionInProgress) { return; }
  connectionInProgress = true;

  const config = vscode.workspace.getConfiguration('argus');
  checkWorkspaceConfigMismatch(config);
  const serverUrl = getConfiguredServerUrl(config);

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

    // 5. Copilot interception was already started in activate() — just check status
    const enableCopilot = config.get<boolean>('enableCopilot', true);
    const copilotConfigured = enableCopilot; // Already set up in activate()

    // 6. Codex capture was already started in activate()
    const enableCodex2 = config.get<boolean>('enableCodex', true);
    const codexConfigured = enableCodex2;

    connected = true;
    updateStatusBar('connected');

    // 8. Build success message
    const configured: string[] = [];
    if (claudeConfigured) { configured.push('Claude Code'); }
    if (geminiCliConfigured) { configured.push('Gemini CLI'); }
    if (copilotConfigured) { configured.push('GitHub Copilot'); }
    if (codexConfigured) { configured.push('OpenAI Codex'); }

    const parts: string[] = [`Argus connected to ${serverUrl}`];
    if (configured.length > 0) {
      parts.push(`Hooks configured: ${configured.join(', ')}`);
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
  try { await teardownCodexCapture(); } catch { /* best effort */ }
  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = getConfiguredServerUrl(config);
  if (serverUrl) {
    await teardownArgusProviderEnv(serverUrl, (msg) => outputChannel.appendLine(msg));
  }
  connected = false;
  updateStatusBar('disconnected');
  vscode.window.showInformationMessage('Argus disconnected');
}

async function resetLocalArgusProxyConfig() {
  const config = vscode.workspace.getConfiguration('argus');
  let baseUrl = getConfiguredServerUrl(config);
  if (!baseUrl) {
    const input = await vscode.window.showInputBox({
      title: 'Argus: Reset local proxy config',
      prompt:
        'Base URL to remove from Claude Code hooks and matching user env vars (e.g. http://host:4080). Cancel to abort.',
      placeHolder: 'http://localhost:4080',
    });
    if (!input?.trim()) { return; }
    baseUrl = input.trim();
  }
  await teardownArgusProviderEnv(baseUrl, (msg) => outputChannel.appendLine(msg));
  void vscode.window.showInformationMessage(
    `Argus: Local proxy teardown finished for ${normalizeArgusBaseUrl(baseUrl)}`
  );
}

function openDashboard() {
  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = getConfiguredServerUrl(config);
  if (!serverUrl) {
    void vscode.window.showErrorMessage('Argus: No server URL configured. Set argus.serverUrl in settings.');
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(serverUrl));
}

async function showStatus() {
  const config = vscode.workspace.getConfiguration('argus');
  const serverUrl = getConfiguredServerUrl(config);

  if (!serverUrl) {
    const action = await vscode.window.showInformationMessage(
      'Argus server URL is not configured.',
      'Open Settings'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'argus.serverUrl');
    }
    return;
  }

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
  try { await teardownCodexCapture(); } catch { /* best effort */ }
  try { disableDebugDump(); } catch { /* best effort */ }
  statusBarItem?.dispose();
}
