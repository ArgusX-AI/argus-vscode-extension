import { detectCopilot } from './copilot-detect';
import { startIntercepting, stopIntercepting, sendToArgusExport, sendToArgusFromOtel } from './copilot-intercept';
import { startDiagnosticsInterception, stopDiagnosticsInterception } from './copilot-diagnostics';
import { startLmIntercept, stopLmIntercept } from './copilot-lm-intercept';
import { startOtelCapture, stopOtelCapture } from './copilot-otel';
import { fetchCopilotLicense, clearLicenseCache } from './copilot-license';

let active = false;

/**
 * Detect GitHub Copilot and start intercepting its requests.
 * Returns true if interception was started, false if Copilot is not installed.
 */
export async function setupCopilotCapture(
  serverUrl: string,
  user: string,
  logger?: (msg: string) => void,
  debug?: boolean,
): Promise<boolean> {
  const log = logger ?? (() => {});
  const status = detectCopilot();
  log(`[copilot] Detection: installed=${status.installed}, core=${status.coreInstalled}, chat=${status.chatInstalled}, version=${status.version ?? 'unknown'}`);

  if (!status.installed) {
    log('[copilot] No Copilot extension found (neither github.copilot nor github.copilot-chat) — skipping interception');
    return false;
  }

  // Layer 1: Network-level monkey-patching (catches telemetry, /models, etc.)
  startIntercepting(serverUrl, user, logger, debug);

  // Layer 2: diagnostics_channel (catches undici/HTTP2 requests in extension host)
  startDiagnosticsInterception(sendToArgusExport, log, Date.now() + 300_000);

  // Layer 3: OTEL capture — the PRIMARY layer for chat prompt capture.
  // Copilot Chat v0.41+ has built-in OpenTelemetry with content capture.
  // We enable it (file exporter), watch the output file, and forward to Argus.
  try {
    const otelOk = await startOtelCapture(sendToArgusFromOtel, log, debug);
    if (otelOk) {
      log('[copilot] OTEL capture configured — this is the primary chat capture layer');
    } else {
      log('[copilot] OTEL capture setup failed');
    }
  } catch (err) {
    log(`[copilot] OTEL setup error: ${err}`);
  }

  // Layer 4: LM API prototype patching (fallback — currently blocked by frozen model objects)
  setTimeout(async () => {
    try {
      const ok = await startLmIntercept(sendToArgusExport, log);
      if (ok) {
        log('[copilot] LM API interception ACTIVE (bonus layer)');
      }
    } catch {
      // Expected to fail — model objects are frozen. OTEL is the real solution.
    }
  }, 5_000);

  // Layer 5: Fetch user license info from GitHub API
  // Deferred to avoid blocking activation; non-fatal.
  setTimeout(async () => {
    try {
      const license = await fetchCopilotLicense(log);
      if (license) {
        sendToArgusExport({
          session_id: `copilot-otel-${new Date().toISOString().slice(0, 10)}-0`,
          request_type: 'license_info',
          copilot_plan: license.copilot_plan,
          chat_enabled: license.chat_enabled,
          premium_requests_remaining: license.premium_requests_remaining,
          premium_requests_total: license.premium_requests_total,
          premium_percent_remaining: license.premium_percent_remaining,
          access_type_sku: license.access_type_sku,
          organizations: license.organizations,
          quota_reset_date: license.quota_reset_date,
          transport: 'license-api',
          domain: 'api.github.com',
          method: 'GET',
          path: '/copilot_internal/user',
        });
        log('[copilot] License info sent to Argus server');
      }
    } catch (err) {
      log(`[copilot] License fetch error (non-fatal): ${err}`);
    }
  }, 8_000);

  active = true;

  const parts: string[] = [`v${status.version ?? 'unknown'}`];
  if (status.coreInstalled) parts.push('Core');
  if (status.chatInstalled) parts.push('Chat');
  console.log(`[Argus] Copilot capture active (${parts.join(', ')})`);
  return true;
}

/**
 * Stop intercepting Copilot requests and restore originals.
 */
export async function teardownCopilotCapture(): Promise<void> {
  if (!active) { return; }
  stopOtelCapture();
  stopLmIntercept();
  clearLicenseCache();
  stopDiagnosticsInterception();
  stopIntercepting();
  active = false;
}
