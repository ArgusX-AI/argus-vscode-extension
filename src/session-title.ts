/**
 * Build a short, human-readable session title from a free-form prompt string.
 *
 * The Argus server uses this as the session display label when present, which
 * is what keeps the UI from falling back to the generic "Codex — <model>"
 * template. See `docs/codex-otel-user-info.md` for the wider context.
 *
 * Rules:
 *   - Reject null / empty / whitespace-only input (returns `null`).
 *   - Strip ASCII control and zero-width characters.
 *   - Collapse every run of whitespace to a single space, then trim.
 *   - If the cleaned string is <= `maxLen`, return as-is.
 *   - Otherwise cut at the last word boundary <= `maxLen - 1` and append `…`.
 *   - The returned string is guaranteed to be at most `maxLen` characters.
 */
export function makeSessionTitle(
  input: unknown,
  maxLen: number = 60,
): string | null {
  if (typeof input !== 'string') return null;
  if (maxLen < 2) return null;

  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\u0000-\u001F\u007F\u200B-\u200F\uFEFF]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (collapsed.length === 0) return null;
  if (collapsed.length <= maxLen) return collapsed;

  const cutoff = maxLen - 1;
  const slice = collapsed.slice(0, cutoff);
  const lastSpace = slice.lastIndexOf(' ');

  // Only prefer a word boundary if it leaves us with meaningful text.
  // Require at least ~40% of maxLen before the break, otherwise the title
  // would be a tiny stub like "a…" which helps nobody.
  const minBreak = Math.floor(cutoff * 0.4);
  const base = lastSpace >= minBreak ? slice.slice(0, lastSpace) : slice;

  return `${base.trimEnd()}…`;
}
