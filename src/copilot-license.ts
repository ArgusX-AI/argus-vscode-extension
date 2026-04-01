/**
 * Fetch Copilot user license/subscription info from GitHub's internal API.
 *
 * Uses VS Code's built-in GitHub authentication to call the same endpoint
 * that Copilot Chat uses internally. Non-fatal — returns null on any failure.
 */
import * as vscode from 'vscode';
import * as https from 'https';

export interface CopilotLicense {
  copilot_plan: string;              // "individual_pro", "business", "enterprise"
  chat_enabled: boolean;
  premium_requests_remaining: number | null;
  premium_requests_total: number | null;
  premium_percent_remaining: number | null;
  access_type_sku: string | null;    // "plus_monthly_subscriber_quota", etc.
  organizations: string[];
  quota_reset_date: string | null;
  fetched_at: string;
}

let cachedLicense: CopilotLicense | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the user's Copilot license information.
 * Results are cached for 5 minutes.
 */
export async function fetchCopilotLicense(
  logger: (msg: string) => void,
): Promise<CopilotLicense | null> {
  // Return cache if fresh
  if (cachedLicense && (Date.now() - cachedAt) < CACHE_TTL_MS) {
    return cachedLicense;
  }

  try {
    // Get GitHub auth session (non-interactive — won't prompt the user)
    const session = await vscode.authentication.getSession('github', ['read:user'], { createIfNone: false });
    if (!session) {
      logger('[copilot-license] No GitHub auth session available (user not signed in)');
      return null;
    }

    logger('[copilot-license] Fetching license info from api.github.com/copilot_internal/user...');

    const data = await httpsGet(
      'https://api.github.com/copilot_internal/user',
      {
        'Authorization': `Bearer ${session.accessToken}`,
        'User-Agent': 'Argus-AI-Observability',
        'Accept': 'application/json',
      },
    );

    if (!data) {
      logger('[copilot-license] Empty response from copilot_internal/user');
      return null;
    }

    const parsed = JSON.parse(data) as Record<string, unknown>;

    // Extract quota info from quota_snapshots.premium_interactions
    const quotaSnapshots = parsed.quota_snapshots as Record<string, unknown> | undefined;
    const premiumQuota = quotaSnapshots?.premium_interactions as Record<string, unknown> | undefined;

    // Extract organization list from token endpoint (if available in response)
    const orgs: string[] = [];
    if (typeof parsed.organizationsList === 'string') {
      orgs.push(...(parsed.organizationsList as string).split(',').filter(Boolean));
    }

    const license: CopilotLicense = {
      copilot_plan: String(parsed.copilot_plan ?? parsed.plan ?? 'unknown'),
      chat_enabled: parsed.chat_enabled === true,
      premium_requests_remaining: premiumQuota?.remaining != null ? Number(premiumQuota.remaining) : null,
      premium_requests_total: premiumQuota?.entitlement != null ? Number(premiumQuota.entitlement) : null,
      premium_percent_remaining: premiumQuota?.percent_remaining != null ? Number(premiumQuota.percent_remaining) : null,
      access_type_sku: parsed.access_type_sku != null ? String(parsed.access_type_sku) : null,
      organizations: orgs,
      quota_reset_date: parsed.quota_reset_date != null ? String(parsed.quota_reset_date) : null,
      fetched_at: new Date().toISOString(),
    };

    cachedLicense = license;
    cachedAt = Date.now();

    logger(
      `[copilot-license] Plan: ${license.copilot_plan}, Chat: ${license.chat_enabled}, ` +
      `Premium: ${license.premium_requests_remaining ?? '?'}/${license.premium_requests_total ?? '?'} ` +
      `(${license.premium_percent_remaining ?? '?'}% remaining), ` +
      `SKU: ${license.access_type_sku ?? '?'}, Orgs: ${license.organizations.join(', ') || 'none'}`,
    );

    return license;
  } catch (err) {
    logger(`[copilot-license] Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Clear the cache (e.g., on disconnect). */
export function clearLicenseCache(): void {
  cachedLicense = null;
  cachedAt = 0;
}

/** Get the last fetched license (may be stale). */
export function getCachedLicense(): CopilotLicense | null {
  return cachedLicense;
}

/** Simple HTTPS GET that returns the response body as string. */
function httpsGet(url: string, headers: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: 10_000 }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
