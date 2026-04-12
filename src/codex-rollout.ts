/**
 * OpenAI Codex rollout JSONL file watcher — PRIMARY capture path.
 *
 * Codex CLI always writes a rollout JSONL to
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
 * for every invocation mode (TUI, `codex exec`, `codex mcp-server`) regardless
 * of the Codex version or the `[otel]` config. Tailing these files is far more
 * reliable than the OTLP HTTP receiver, which has several well-known gaps
 * (see plan doc + issue #12913).
 *
 * File format (one JSON per line):
 *   Line 1  header:     { session_id, timestamp, model, provider, ... }
 *   Lines 2+ event_msg: { type: "event_msg", payload: { type: "user_message" | "agent_message"
 *                        | "tool_call" | "tool_result", content/text/name/... } }
 *            token_cnt: { type: "event_msg", payload: { type: "token_count", input_tokens, ... } }
 *
 * Strategy:
 *  - Resolve `$CODEX_HOME` (default `~/.codex`).
 *  - Watch today's day directory; re-evaluate at midnight.
 *  - When a rollout file appears or grows, tail new bytes from the last offset.
 *  - Parse each line, group by `session_id`, batch-flush to Argus every 500ms.
 *  - Track processed sessions + file offsets so restarts don't re-ingest history.
 *  - POST each batched event to `${serverUrl}/hooks/CodexRequest` with header
 *    `x-argus-codex-source: rollout` so the server can pick rollout over OTEL
 *    when deduping.
 *
 * Security notes:
 *  - We never follow symlinks inside `$CODEX_HOME/sessions`: all reads use
 *    `fs.realpathSync` comparisons to ensure paths stay inside the base dir.
 *  - We validate each rollout filename against `/^rollout-[A-Za-z0-9._-]+\.jsonl$/`
 *    to reject path-traversal or unexpected entries.
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';

/** Header field stored per rollout file — captured from the first line. */
interface RolloutHeader {
  readonly sessionId: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly startedAt: string | null;
}

/** Per-file tailing state. */
interface TailState {
  readonly filePath: string;
  offset: number;
  header: RolloutHeader | null;
  /** Monotonic counter used to form `(session_id, event_sequence)` dedup keys. */
  sequence: number;
  /** Aggregated cumulative token counts from `token_count` events. */
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  cumulativeReasoningTokens: number;
  /** Flush timer — reset on each new line. */
  flushTimer: NodeJS.Timeout | null;
  /** Pending events that haven't been flushed yet. */
  pending: RolloutEvent[];
}

/** One extracted event ready to post to Argus. */
interface RolloutEvent {
  readonly eventSequence: number;
  readonly requestType: 'chat' | 'tool' | 'inference';
  readonly prompt: string | null;
  readonly completion: string | null;
  readonly toolName: string | null;
  readonly toolCallArguments: string | null;
  readonly toolCallResult: string | null;
  readonly deltaInputTokens: number | null;
  readonly deltaOutputTokens: number | null;
  readonly cumulativeInputTokens: number | null;
  readonly cumulativeOutputTokens: number | null;
  readonly cumulativeCacheReadTokens: number | null;
  readonly cumulativeReasoningTokens: number | null;
}

/** Matches Codex's actual rollout file naming. */
const ROLLOUT_FILENAME_RE = /^rollout-[A-Za-z0-9._-]+\.jsonl$/;

const FLUSH_INTERVAL_MS = 500;
const WATCH_DEBOUNCE_MS = 100;
const MAX_SESSIONS_TRACKED = 200;

type SendFn = (payload: Record<string, unknown>) => void;
type Logger = (msg: string) => void;

let active = false;
let baseDir: string | null = null;
let dayWatcher: fs.FSWatcher | null = null;
let dayWatcherPath: string | null = null;
let midnightTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
const tails = new Map<string, TailState>();
let sendFn: SendFn | null = null;
let logFn: Logger = () => {};
let totalEventsEmitted = 0;
let totalFilesWatched = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the rollout watcher.
 *
 * Returns `true` if the base directory exists and a day-watcher was
 * installed, `false` otherwise (caller should still start OTEL).
 */
export function startCodexRolloutWatcher(send: SendFn, logger: Logger): boolean {
  sendFn = send;
  logFn = logger;

  const resolved = resolveCodexBaseDir();
  if (!resolved) {
    logger('[codex:rollout] CODEX_HOME does not exist — watcher inactive');
    return false;
  }
  baseDir = resolved;

  active = true;
  logger(`[codex:rollout] Watching ${path.join(baseDir, 'sessions')} for rollout-*.jsonl`);

  installDayWatcher();
  scheduleMidnightRollover();
  // Initial scan of today's directory in case files already exist.
  scanTodayDir();
  return true;
}

export function stopCodexRolloutWatcher(): void {
  active = false;
  if (dayWatcher) {
    try { dayWatcher.close(); } catch { /* best effort */ }
    dayWatcher = null;
    dayWatcherPath = null;
  }
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const state of tails.values()) {
    if (state.flushTimer) clearTimeout(state.flushTimer);
  }
  tails.clear();
  sendFn = null;
  logFn = () => {};
  baseDir = null;
  totalEventsEmitted = 0;
  totalFilesWatched = 0;
}

export function getCodexRolloutStats(): {
  active: boolean;
  baseDir: string | null;
  filesWatched: number;
  eventsEmitted: number;
  sessionsTracked: number;
} {
  return {
    active,
    baseDir,
    filesWatched: totalFilesWatched,
    eventsEmitted: totalEventsEmitted,
    sessionsTracked: tails.size,
  };
}

// ---------------------------------------------------------------------------
// Testing hook — `processRolloutLines` lets unit tests drive the parser
// without touching the filesystem.
// ---------------------------------------------------------------------------

/**
 * Process a sequence of rollout JSONL lines against a fresh tail-state and
 * send the resulting events through the provided `sendFn`.
 *
 * Exposed for tests. The returned state can be inspected or replayed.
 */
export function processRolloutLinesForTest(
  lines: readonly string[],
  testSendFn: SendFn,
  logger: Logger = () => {},
): { state: TailState; eventsSent: Array<Record<string, unknown>> } {
  const previousSend = sendFn;
  const previousLog = logFn;
  const eventsSent: Array<Record<string, unknown>> = [];
  sendFn = (payload) => {
    eventsSent.push(payload);
    testSendFn(payload);
  };
  logFn = logger;
  try {
    const state = makeTailState('<test>');
    for (const line of lines) {
      ingestLine(state, line);
    }
    // Force-flush pending.
    flushPending(state, 'test-final');
    return { state, eventsSent };
  } finally {
    sendFn = previousSend;
    logFn = previousLog;
  }
}

// ---------------------------------------------------------------------------
// Base directory resolution — path-traversal safe
// ---------------------------------------------------------------------------

/**
 * Resolve the Codex base directory ($CODEX_HOME with `~/.codex` fallback).
 *
 * Returns the realpath of the directory if it exists and is a directory,
 * otherwise `null`. We realpath to collapse symlinks once — subsequent file
 * operations check that candidate paths stay under this realpath to prevent
 * symlink-escape attacks.
 */
function resolveCodexBaseDir(): string | null {
  const raw = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() !== ''
    ? process.env.CODEX_HOME
    : path.join(homedir(), '.codex');
  try {
    const stat = fs.statSync(raw);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(raw);
  } catch {
    return null;
  }
}

function todaySessionsDir(): string {
  if (!baseDir) throw new Error('baseDir not set');
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return path.join(baseDir, 'sessions', yyyy, mm, dd);
}

/**
 * True if `candidate` (after realpath if it exists, else its parent's
 * realpath + basename) resolves to a path inside `baseDir`.
 */
function isInsideBaseDir(candidate: string): boolean {
  if (!baseDir) return false;
  try {
    // If the file exists, realpath it. If not (new file event), realpath the
    // parent directory (which must exist for the watcher to have fired).
    let realCandidate: string;
    if (fs.existsSync(candidate)) {
      realCandidate = fs.realpathSync(candidate);
    } else {
      const parent = path.dirname(candidate);
      const realParent = fs.realpathSync(parent);
      realCandidate = path.join(realParent, path.basename(candidate));
    }
    const rel = path.relative(baseDir, realCandidate);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Day-directory watcher
// ---------------------------------------------------------------------------

function installDayWatcher(): void {
  if (!active || !baseDir) return;

  const dayDir = todaySessionsDir();
  try {
    fs.mkdirSync(dayDir, { recursive: true });
  } catch (err) {
    logFn(`[codex:rollout] Failed to ensure day dir ${dayDir}: ${errMsg(err)}`);
    return;
  }

  if (dayWatcher && dayWatcherPath === dayDir) return;
  if (dayWatcher) {
    try { dayWatcher.close(); } catch { /* best effort */ }
    dayWatcher = null;
  }

  try {
    dayWatcher = fs.watch(dayDir, { persistent: false }, (_event, fileName) => {
      if (!fileName || typeof fileName !== 'string') return;
      if (!ROLLOUT_FILENAME_RE.test(fileName)) return;
      scheduleScan();
    });
    dayWatcherPath = dayDir;
    logFn(`[codex:rollout] Day watcher installed on ${dayDir}`);
  } catch (err) {
    logFn(`[codex:rollout] fs.watch error on ${dayDir}: ${errMsg(err)}`);
  }
}

function scheduleScan(): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scanTodayDir();
  }, WATCH_DEBOUNCE_MS);
}

function scanTodayDir(): void {
  if (!active || !baseDir) return;
  const dayDir = todaySessionsDir();

  let entries: string[];
  try {
    entries = fs.readdirSync(dayDir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!ROLLOUT_FILENAME_RE.test(name)) continue;
    const filePath = path.join(dayDir, name);
    if (!isInsideBaseDir(filePath)) {
      logFn(`[codex:rollout] Rejected suspicious path: ${filePath}`);
      continue;
    }
    let state = tails.get(filePath);
    if (!state) {
      if (tails.size >= MAX_SESSIONS_TRACKED) {
        logFn('[codex:rollout] Max tracked sessions reached — skipping new file');
        continue;
      }
      state = makeTailState(filePath);
      tails.set(filePath, state);
      totalFilesWatched++;
      logFn(`[codex:rollout] New rollout: ${name}`);
    }
    tailFile(state);
  }
}

function scheduleMidnightRollover(): void {
  if (!active) return;
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 5, // 5-second safety margin past midnight UTC
  ));
  const delay = Math.max(1000, next.getTime() - now.getTime());
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    installDayWatcher();
    scanTodayDir();
    scheduleMidnightRollover();
  }, delay);
}

// ---------------------------------------------------------------------------
// Tailing
// ---------------------------------------------------------------------------

function makeTailState(filePath: string): TailState {
  return {
    filePath,
    offset: 0,
    header: null,
    sequence: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeReasoningTokens: 0,
    flushTimer: null,
    pending: [],
  };
}

function tailFile(state: TailState): void {
  if (state.filePath === '<test>') return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.filePath);
  } catch {
    return;
  }
  if (stat.size <= state.offset) return;

  const length = stat.size - state.offset;
  const buf = Buffer.alloc(length);
  let fd: number;
  try {
    fd = fs.openSync(state.filePath, 'r');
  } catch (err) {
    logFn(`[codex:rollout] Open failed: ${errMsg(err)}`);
    return;
  }
  try {
    fs.readSync(fd, buf, 0, length, state.offset);
  } catch (err) {
    logFn(`[codex:rollout] Read failed: ${errMsg(err)}`);
    try { fs.closeSync(fd); } catch { /* best effort */ }
    return;
  }
  try { fs.closeSync(fd); } catch { /* best effort */ }

  state.offset = stat.size;
  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  // Last entry may be an incomplete line — if so, rewind the offset so the
  // next read picks it up from the start. Only do this when the chunk does
  // not end in a newline.
  let fullLines: string[];
  if (text.endsWith('\n')) {
    fullLines = lines.filter(l => l.length > 0);
  } else {
    const partial = lines.pop() ?? '';
    state.offset -= Buffer.byteLength(partial, 'utf-8');
    fullLines = lines.filter(l => l.length > 0);
  }

  for (const line of fullLines) {
    ingestLine(state, line);
  }
  schedulePendingFlush(state);
}

function ingestLine(state: TailState, line: string): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // skip malformed
  }

  // Header line
  if (state.header === null && typeof record.session_id === 'string') {
    state.header = {
      sessionId: String(record.session_id),
      model: typeof record.model === 'string' ? record.model : null,
      provider: typeof record.provider === 'string' ? record.provider : null,
      startedAt: typeof record.timestamp === 'string' ? record.timestamp : null,
    };
    return;
  }

  // Event lines
  const type = typeof record.type === 'string' ? record.type : null;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  const payloadType = typeof payload.type === 'string' ? payload.type : null;

  // Codex wraps user/agent events inside `event_msg` records.
  if (type !== 'event_msg' && type !== 'response_item' && type !== 'rollout_item') return;

  if (payloadType === 'user_message') {
    const text = extractText(payload, ['content', 'message', 'text']);
    if (text) enqueue(state, {
      requestType: 'chat',
      prompt: text,
      completion: null,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
    });
    return;
  }

  if (payloadType === 'agent_message') {
    const text = extractText(payload, ['content', 'message', 'text']);
    if (text) enqueue(state, {
      requestType: 'chat',
      prompt: null,
      completion: text,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
    });
    return;
  }

  if (payloadType === 'tool_call') {
    const name = typeof payload.name === 'string' ? payload.name : null;
    const args = stringifyUnknown(payload.arguments ?? payload.args ?? payload.input);
    enqueue(state, {
      requestType: 'tool',
      prompt: null,
      completion: null,
      toolName: name,
      toolCallArguments: args,
      toolCallResult: null,
    });
    return;
  }

  if (payloadType === 'tool_result') {
    const name = typeof payload.name === 'string' ? payload.name : null;
    const result = stringifyUnknown(payload.result ?? payload.output ?? payload.content);
    enqueue(state, {
      requestType: 'tool',
      prompt: null,
      completion: null,
      toolName: name,
      toolCallArguments: null,
      toolCallResult: result,
    });
    return;
  }

  if (payloadType === 'token_count') {
    const input = asInt(payload.input_tokens);
    const output = asInt(payload.output_tokens);
    const cacheRead = asInt(payload.cached_input_tokens ?? payload.cache_read_tokens);
    const reasoning = asInt(payload.reasoning_tokens ?? payload.reasoning_output_tokens);
    // Codex emits cumulative counts in some modes, deltas in others. Treat
    // monotonic-increasing values as cumulative; reset as delta-only.
    const deltaIn = input !== null
      ? Math.max(0, input - state.cumulativeInputTokens)
      : null;
    const deltaOut = output !== null
      ? Math.max(0, output - state.cumulativeOutputTokens)
      : null;
    if (input !== null && input >= state.cumulativeInputTokens) state.cumulativeInputTokens = input;
    if (output !== null && output >= state.cumulativeOutputTokens) state.cumulativeOutputTokens = output;
    if (cacheRead !== null) state.cumulativeCacheReadTokens = cacheRead;
    if (reasoning !== null) state.cumulativeReasoningTokens = reasoning;

    state.sequence++;
    state.pending.push({
      eventSequence: state.sequence,
      requestType: 'inference',
      prompt: null,
      completion: null,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
      deltaInputTokens: deltaIn,
      deltaOutputTokens: deltaOut,
      cumulativeInputTokens: state.cumulativeInputTokens,
      cumulativeOutputTokens: state.cumulativeOutputTokens,
      cumulativeCacheReadTokens: state.cumulativeCacheReadTokens || null,
      cumulativeReasoningTokens: state.cumulativeReasoningTokens || null,
    });
  }
}

type EnqueueInput = Pick<
  RolloutEvent,
  'requestType' | 'prompt' | 'completion' | 'toolName' | 'toolCallArguments' | 'toolCallResult'
>;

function enqueue(state: TailState, ev: EnqueueInput): void {
  state.sequence++;
  state.pending.push({
    eventSequence: state.sequence,
    ...ev,
    deltaInputTokens: null,
    deltaOutputTokens: null,
    cumulativeInputTokens: state.cumulativeInputTokens || null,
    cumulativeOutputTokens: state.cumulativeOutputTokens || null,
    cumulativeCacheReadTokens: state.cumulativeCacheReadTokens || null,
    cumulativeReasoningTokens: state.cumulativeReasoningTokens || null,
  });
}

function schedulePendingFlush(state: TailState): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    flushPending(state, 'debounced');
  }, FLUSH_INTERVAL_MS);
}

function flushPending(state: TailState, _reason: string): void {
  if (state.pending.length === 0) return;
  const header = state.header;
  if (!header) {
    // No header yet — hold off; we can't form a session id.
    return;
  }
  const sessionId = `codex-${header.sessionId.slice(0, 8)}`;

  for (const ev of state.pending) {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      conversation_id: header.sessionId,
      event_sequence: ev.eventSequence,
      model_id: header.model,
      request_type: ev.requestType,
      prompt: ev.prompt,
      completion: ev.completion,
      system_prompt: null,
      raw_input_messages: null,
      raw_output_messages: null,
      input_tokens: ev.deltaInputTokens,
      output_tokens: ev.deltaOutputTokens,
      cumulative_input_tokens: ev.cumulativeInputTokens,
      cumulative_output_tokens: ev.cumulativeOutputTokens,
      cache_read_tokens: ev.cumulativeCacheReadTokens,
      reasoning_tokens: ev.cumulativeReasoningTokens,
      tool_name: ev.toolName,
      tool_call_arguments: ev.toolCallArguments,
      tool_call_result: ev.toolCallResult,
      transport: 'rollout-jsonl',
      domain: 'api.openai.com',
      method: 'POST',
      path: '/v1/responses',
      status_code: 200,
      span_name: 'codex.rollout',
    };
    totalEventsEmitted++;
    if (sendFn) sendFn(payload);
  }
  state.pending = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    // Codex sometimes nests content inside an array of message parts.
    if (Array.isArray(v)) {
      const joined = v
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const pt = part as Record<string, unknown>;
            if (typeof pt.text === 'string') return pt.text;
            if (typeof pt.content === 'string') return pt.content;
          }
          return '';
        })
        .filter(s => s.length > 0)
        .join('\n');
      if (joined.trim() !== '') return joined;
    }
  }
  return null;
}

function stringifyUnknown(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
