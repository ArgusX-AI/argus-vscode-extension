/**
 * Per-session title pin for Copilot capture pipelines.
 *
 * The Argus server's priority resolver (server commit d6c08bfc) honors
 * `payload.session_title` and replaces the generic "Copilot Chat — <model>"
 * fallback when an explicit title arrives. But Copilot has three independent
 * capture pipelines (HTTP intercept, OTLP HTTP, VS Code LM API) and any of
 * them can fire first, often without prompt content (token-only OTEL events
 * race ahead of prompt-bearing ones). Without a shared, sticky title cache,
 * each pipeline would independently rederive — or, worse, fail to derive — a
 * title and let the model-name fallback win.
 *
 * This module is the symmetric Copilot equivalent of `TailState.sessionTitle`
 * in `codex-rollout.ts`: derive once from the first prompt that arrives for a
 * given session id, pin for the lifetime of the session, hand the same value
 * back to every pipeline on every subsequent payload.
 */
import { makeSessionTitle } from './session-title';

const MAX_SESSION_TITLES = 500;

const sessionTitles = new Map<string, string>();

/**
 * Returns the pinned title for `sessionId`, deriving it from `prompt` on the
 * first call that supplies non-empty prompt text. Subsequent calls — even with
 * a different or absent prompt — return the originally pinned value.
 *
 * Returns `null` until a prompt-bearing call arrives for the session.
 */
export function getOrDeriveCopilotTitle(
  sessionId: string | null | undefined,
  prompt: string | null | undefined,
): string | null {
  if (!sessionId) return null;

  const existing = sessionTitles.get(sessionId);
  if (existing !== undefined) {
    sessionTitles.delete(sessionId);
    sessionTitles.set(sessionId, existing);
    return existing;
  }

  const derived = makeSessionTitle(prompt);
  if (!derived) return null;

  if (sessionTitles.size >= MAX_SESSION_TITLES) {
    const oldest = sessionTitles.keys().next().value;
    if (oldest !== undefined) sessionTitles.delete(oldest);
  }
  sessionTitles.set(sessionId, derived);
  return derived;
}

/** Drop every pinned title. Called from the extension `deactivate()` path. */
export function clearCopilotSessionTitles(): void {
  sessionTitles.clear();
}

/** Test-only: current map size. Not exported via index. */
export function _copilotTitleCacheSize(): number {
  return sessionTitles.size;
}
