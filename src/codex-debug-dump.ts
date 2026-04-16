/**
 * Codex debug dump — writes raw and processed capture data to desktop
 * for offline inspection when `argus.codexDebugMode` is enabled.
 *
 * Output structure:
 *   ~/Desktop/argus-codex-debug/<session-timestamp>/
 *     summary.json
 *     raw-rollout/<file>.jsonl
 *     sent-to-argus/events.jsonl
 *     raw-otel/<timestamp>.json
 */
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let sessionDir: string | null = null;
let enabled = false;

/**
 * Activate the debug dumper. Creates the session folder tree on first call.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function enableDebugDump(): string {
  if (sessionDir) return sessionDir;

  const ts = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
  const home = homedir();
  const root = join(home, 'Desktop', 'argus-codex-debug', ts);

  try {
    mkdirSync(join(root, 'raw-rollout'), { recursive: true });
    mkdirSync(join(root, 'sent-to-argus'), { recursive: true });
    mkdirSync(join(root, 'raw-otel'), { recursive: true });
  } catch (err) {
    throw err;
  }

  sessionDir = root;
  enabled = true;
  return root;
}

export function isDebugDumpEnabled(): boolean {
  return enabled;
}

export function getDebugDumpDir(): string | null {
  return sessionDir;
}

/**
 * Write a verbatim rollout JSONL line (pretty-printed) to
 * `raw-rollout/<fileName>.jsonl`.
 */
export function dumpRawLine(fileName: string, _lineNumber: number, rawJsonLine: string): void {
  if (!enabled || !sessionDir) return;
  try {
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = join(sessionDir, 'raw-rollout', `${safe}.jsonl`);
    let pretty: string;
    try {
      pretty = JSON.stringify(JSON.parse(rawJsonLine), null, 2);
    } catch {
      pretty = rawJsonLine;
    }
    appendFileSync(dest, pretty + '\n', 'utf-8');
  } catch { /* best effort */ }
}

/**
 * Write a processed event payload (what gets POSTed to Argus) to
 * `sent-to-argus/events.jsonl`.
 */
export function dumpProcessedEvent(payload: Record<string, unknown>): void {
  if (!enabled || !sessionDir) return;
  try {
    const dest = join(sessionDir, 'sent-to-argus', 'events.jsonl');
    appendFileSync(dest, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  } catch { /* best effort */ }
}

/**
 * Write a raw OTLP request body to `raw-otel/<timestamp>.json`.
 */
export function dumpOtelRaw(endpoint: string, rawBody: string): void {
  if (!enabled || !sessionDir) return;
  try {
    const ts = Date.now();
    const safe = endpoint.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = join(sessionDir, 'raw-otel', `${ts}-${safe}.json`);
    let pretty: string;
    try {
      pretty = JSON.stringify(JSON.parse(rawBody), null, 2);
    } catch {
      pretty = rawBody;
    }
    writeFileSync(dest, pretty, 'utf-8');
  } catch { /* best effort */ }
}

/**
 * Write a `summary.json` with session-level metadata.
 */
export function dumpSummary(info: Record<string, unknown>): void {
  if (!enabled || !sessionDir) return;
  try {
    const dest = join(sessionDir, 'summary.json');
    if (existsSync(dest)) return;
    writeFileSync(dest, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  } catch { /* best effort */ }
}

/**
 * Tear down — reset state but leave files on disk.
 */
export function disableDebugDump(): void {
  sessionDir = null;
  enabled = false;
}
