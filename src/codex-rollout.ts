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
import { isDebugDumpEnabled, dumpRawLine, dumpSummary } from './codex-debug-dump';
import { makeSessionTitle } from './session-title';

/** Header field stored per rollout file — captured from the first line. */
interface RolloutHeader {
  readonly sessionId: string;
  model: string | null;
  readonly provider: string | null;
  readonly startedAt: string | null;
  readonly systemPrompt: string | null;
  readonly cwd: string | null;
  readonly cliVersion: string | null;
  readonly originator: string | null;
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
  /** Rich turn context from the most recent turn_context record. */
  turnContext: TurnContext | null;
  /** Rate limits from the most recent token_count event. */
  rateLimits: Record<string, unknown> | null;
  /** Task lifecycle tracking. */
  taskStartedAt: number | null;
  modelContextWindow: number | null;
  collaborationModeKind: string | null;
  /** Whether system prompt was already sent (send once per session). */
  systemPromptSent: boolean;
  /** Developer messages captured from response_item role=developer. */
  developerMessages: string | null;
  /** Environment context captured from response_item role=user with <environment_context>. */
  environmentContext: string | null;
  /**
   * Human-readable session title derived from the first user prompt seen on
   * this rollout. Sent on every subsequent payload so the Argus server can
   * use it as the session display label (falling back to "Codex — <model>"
   * when absent).
   */
  sessionTitle: string | null;
}

interface TurnContext {
  readonly turnId: string | null;
  readonly traceId: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly personality: string | null;
  readonly effort: string | null;
  readonly collaborationMode: string | null;
  readonly approvalPolicy: string | null;
  readonly sandboxPolicy: string | null;
  readonly timezone: string | null;
  readonly realtimeActive: boolean | null;
  readonly truncationPolicy: string | null;
}

/** One extracted event ready to post to Argus. */
interface RolloutEvent {
  readonly eventSequence: number;
  readonly requestType: 'chat' | 'tool' | 'inference' | 'lifecycle' | 'context';
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
  readonly phase: string | null;
  readonly rateLimits: string | null;
  readonly taskDurationMs: number | null;
  readonly modelContextWindow: number | null;
  readonly turnContext: string | null;
  readonly systemPrompt: string | null;
  readonly developerMessages: string | null;
  readonly environmentContext: string | null;
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
let dayRecheckInterval: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
const tails = new Map<string, TailState>();
let sendFn: SendFn | null = null;
let logFn: Logger = () => {};
let totalEventsEmitted = 0;
let totalFilesWatched = 0;
let userName: string | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the rollout watcher.
 *
 * Returns `true` if the base directory exists and a day-watcher was
 * installed, `false` otherwise (caller should still start OTEL).
 */
export function startCodexRolloutWatcher(send: SendFn, logger: Logger, user?: string): boolean {
  sendFn = send;
  logFn = logger;
  userName = user ?? process.env.USERNAME ?? process.env.USER ?? null;

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
  scheduleDayRecheck();
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
  if (dayRecheckInterval) {
    clearInterval(dayRecheckInterval);
    dayRecheckInterval = null;
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
  // Codex CLI writes rollout files to sessions/YYYY/MM/DD using LOCAL date
  // (filenames like rollout-2026-04-17T01-10-51-*.jsonl embed local-time
  // components), so watch the local-date folder — not UTC. Users in
  // timezones ahead of UTC would otherwise miss all sessions created
  // between local midnight and UTC midnight.
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
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
  // Schedule for LOCAL midnight (matches Codex's local-date folder scheme).
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0, 0, 5, // 5-second safety margin past local midnight
  );
  const delay = Math.max(1000, next.getTime() - now.getTime());
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    installDayWatcher();
    scanTodayDir();
    scheduleMidnightRollover();
  }, delay);
}

/**
 * Periodically verify the day-watcher is on today's directory. Guards against
 * the case where the midnight setTimeout is throttled or delayed (VS Code
 * backgrounded windows, machine sleep/suspend) and the watcher would otherwise
 * remain stuck on yesterday's day folder after UTC rollover.
 */
function scheduleDayRecheck(): void {
  if (!active) return;
  if (dayRecheckInterval) clearInterval(dayRecheckInterval);
  dayRecheckInterval = setInterval(() => {
    if (!active) return;
    const dayDir = todaySessionsDir();
    if (dayWatcherPath !== dayDir) {
      logFn(`[codex:rollout] Day recheck: watcher on ${dayWatcherPath ?? '<none>'} but today is ${dayDir} — reinstalling`);
      installDayWatcher();
    }
    scanTodayDir();
  }, 60_000); // every 60s
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
    turnContext: null,
    rateLimits: null,
    taskStartedAt: null,
    modelContextWindow: null,
    collaborationModeKind: null,
    systemPromptSent: false,
    developerMessages: null,
    environmentContext: null,
    sessionTitle: null,
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
  if (isDebugDumpEnabled()) {
    const fileName = path.basename(state.filePath, '.jsonl');
    dumpRawLine(fileName, state.sequence + 1, line);
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // skip malformed
  }

  // Header line — support both legacy flat format and current session_meta format
  if (state.header === null) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (typeof record.session_id === 'string') {
      state.header = {
        sessionId: String(record.session_id),
        model: typeof record.model === 'string' ? record.model : null,
        provider: typeof record.provider === 'string' ? record.provider : null,
        startedAt: typeof record.timestamp === 'string' ? record.timestamp : null,
        systemPrompt: null,
        cwd: null,
        cliVersion: null,
        originator: null,
      };
      if (isDebugDumpEnabled()) {
        dumpSummary({ type: 'legacy_header', ...record });
      }
      return;
    }
    if (record.type === 'session_meta' && payload && typeof payload.id === 'string') {
      const baseInstructions = payload.base_instructions as Record<string, unknown> | undefined;
      state.header = {
        sessionId: String(payload.id),
        model: typeof payload.model === 'string' ? payload.model : null,
        provider: typeof payload.model_provider === 'string' ? payload.model_provider : null,
        startedAt: typeof payload.timestamp === 'string' ? payload.timestamp
          : typeof record.timestamp === 'string' ? record.timestamp : null,
        systemPrompt: typeof baseInstructions?.text === 'string' ? baseInstructions.text as string : null,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : null,
        originator: typeof payload.originator === 'string' ? payload.originator : null,
      };
      if (isDebugDumpEnabled()) {
        dumpSummary({ type: 'session_meta', ...record });
      }
      return;
    }
  }

  // Event lines
  const type = typeof record.type === 'string' ? record.type : null;
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  const payloadType = typeof payload.type === 'string' ? payload.type : null;

  // Capture turn_context — rich metadata about the current turn
  if (type === 'turn_context') {
    const model = typeof payload.model === 'string' ? payload.model : null;
    if (state.header && !state.header.model && model) {
      state.header.model = model;
    }
    const collabMode = payload.collaboration_mode as Record<string, unknown> | undefined;
    state.turnContext = {
      turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      traceId: typeof payload.trace_id === 'string' ? payload.trace_id : null,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
      model,
      personality: typeof payload.personality === 'string' ? payload.personality : null,
      effort: typeof payload.effort === 'string' ? payload.effort : null,
      collaborationMode: typeof collabMode?.mode === 'string' ? collabMode.mode as string : null,
      approvalPolicy: typeof payload.approval_policy === 'string' ? payload.approval_policy : null,
      sandboxPolicy: stringifyUnknown(payload.sandbox_policy),
      timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
      realtimeActive: typeof payload.realtime_active === 'boolean' ? payload.realtime_active : null,
      truncationPolicy: stringifyUnknown(payload.truncation_policy),
    };
    return;
  }

  // Capture response_item messages — developer instructions, environment context, assistant responses
  if (type === 'response_item' && payloadType === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : null;
    const contentParts = payload.content;

    if (role === 'developer' && Array.isArray(contentParts)) {
      const devText = contentParts
        .map((part: Record<string, unknown>) => typeof part.text === 'string' ? part.text : '')
        .filter((s: string) => s.length > 0)
        .join('\n---\n');
      if (devText) state.developerMessages = devText;
      return;
    }

    if (role === 'user' && Array.isArray(contentParts)) {
      const userText = contentParts
        .map((part: Record<string, unknown>) => typeof part.text === 'string' ? part.text : '')
        .filter((s: string) => s.length > 0)
        .join('\n');
      if (userText.includes('<environment_context>')) {
        state.environmentContext = userText;
      }
      return;
    }

    // response_item with role=assistant — capture phase
    if (role === 'assistant') {
      const phase = typeof payload.phase === 'string' ? payload.phase : null;
      const text = Array.isArray(contentParts)
        ? contentParts
            .map((part: Record<string, unknown>) => typeof part.text === 'string' ? part.text : '')
            .filter((s: string) => s.length > 0)
            .join('\n')
        : null;
      if (text) enqueue(state, {
        requestType: 'chat',
        prompt: null,
        completion: null,
        toolName: null,
        toolCallArguments: null,
        toolCallResult: null,
        phase,
      });
      return;
    }
    return;
  }

  // Capture task lifecycle events
  if (payloadType === 'task_started') {
    state.taskStartedAt = asInt(payload.started_at);
    state.modelContextWindow = asInt(payload.model_context_window);
    state.collaborationModeKind = typeof payload.collaboration_mode_kind === 'string' ? payload.collaboration_mode_kind : null;

    enqueue(state, {
      requestType: 'lifecycle',
      prompt: null,
      completion: null,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
    });
    return;
  }

  if (payloadType === 'task_complete') {
    const durationMs = asInt(payload.duration_ms);
    const lastMsg = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null;

    state.sequence++;
    state.pending.push({
      eventSequence: state.sequence,
      requestType: 'lifecycle',
      prompt: null,
      completion: lastMsg,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
      deltaInputTokens: null,
      deltaOutputTokens: null,
      cumulativeInputTokens: state.cumulativeInputTokens || null,
      cumulativeOutputTokens: state.cumulativeOutputTokens || null,
      cumulativeCacheReadTokens: state.cumulativeCacheReadTokens || null,
      cumulativeReasoningTokens: state.cumulativeReasoningTokens || null,
      phase: 'task_complete',
      rateLimits: state.rateLimits ? JSON.stringify(state.rateLimits) : null,
      taskDurationMs: durationMs,
      modelContextWindow: state.modelContextWindow,
      turnContext: state.turnContext ? JSON.stringify(state.turnContext) : null,
      systemPrompt: null,
      developerMessages: null,
      environmentContext: null,
    });
    return;
  }

  // Skip non-event records that aren't handled above
  if (type !== 'event_msg' && type !== 'rollout_item') return;

  if (payloadType === 'user_message') {
    const text = extractText(payload, ['content', 'message', 'text']);
    if (text) {
      if (state.sessionTitle === null) {
        const title = makeSessionTitle(text);
        if (title) state.sessionTitle = title;
      }
      enqueue(state, {
        requestType: 'chat',
        prompt: text,
        completion: null,
        toolName: null,
        toolCallArguments: null,
        toolCallResult: null,
      });
    }
    return;
  }

  if (payloadType === 'agent_message') {
    const text = extractText(payload, ['content', 'message', 'text']);
    const phase = typeof payload.phase === 'string' ? payload.phase : null;
    if (text) enqueue(state, {
      requestType: 'chat',
      prompt: null,
      completion: text,
      toolName: null,
      toolCallArguments: null,
      toolCallResult: null,
      phase,
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
    // Codex nests token data inside payload.info.total_token_usage
    const usage = (payload.info as Record<string, unknown> | null)?.total_token_usage as Record<string, unknown> | undefined;
    const input = asInt(usage?.input_tokens ?? payload.input_tokens);
    const output = asInt(usage?.output_tokens ?? payload.output_tokens);
    const cacheRead = asInt(usage?.cached_input_tokens ?? payload.cached_input_tokens ?? payload.cache_read_tokens);
    const reasoning = asInt(usage?.reasoning_output_tokens ?? payload.reasoning_tokens ?? payload.reasoning_output_tokens);

    // Capture rate_limits for this token_count event
    if (payload.rate_limits && typeof payload.rate_limits === 'object') {
      state.rateLimits = payload.rate_limits as Record<string, unknown>;
    }

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
      phase: null,
      rateLimits: state.rateLimits ? JSON.stringify(state.rateLimits) : null,
      taskDurationMs: null,
      modelContextWindow: state.modelContextWindow,
      turnContext: null,
      systemPrompt: null,
      developerMessages: null,
      environmentContext: null,
    });
  }
}

type EnqueueInput = Pick<
  RolloutEvent,
  'requestType' | 'prompt' | 'completion' | 'toolName' | 'toolCallArguments' | 'toolCallResult'
> & { phase?: string | null };

function enqueue(state: TailState, ev: EnqueueInput): void {
  // Attach system prompt, developer messages, and environment context on the first chat event
  let sysPrompt: string | null = null;
  let devMsgs: string | null = null;
  let envCtx: string | null = null;
  if (!state.systemPromptSent && ev.requestType === 'chat' && ev.prompt) {
    sysPrompt = state.header?.systemPrompt ?? null;
    devMsgs = state.developerMessages;
    envCtx = state.environmentContext;
    state.systemPromptSent = true;
  }

  state.sequence++;
  state.pending.push({
    eventSequence: state.sequence,
    requestType: ev.requestType,
    prompt: ev.prompt,
    completion: ev.completion,
    toolName: ev.toolName,
    toolCallArguments: ev.toolCallArguments,
    toolCallResult: ev.toolCallResult,
    deltaInputTokens: null,
    deltaOutputTokens: null,
    cumulativeInputTokens: state.cumulativeInputTokens || null,
    cumulativeOutputTokens: state.cumulativeOutputTokens || null,
    cumulativeCacheReadTokens: state.cumulativeCacheReadTokens || null,
    cumulativeReasoningTokens: state.cumulativeReasoningTokens || null,
    phase: ev.phase ?? null,
    rateLimits: null,
    taskDurationMs: null,
    modelContextWindow: state.modelContextWindow,
    turnContext: state.turnContext ? JSON.stringify(state.turnContext) : null,
    systemPrompt: sysPrompt,
    developerMessages: devMsgs,
    environmentContext: envCtx,
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
    return;
  }
  const sessionId = `codex-${header.sessionId.slice(0, 8)}`;

  // Consolidate prompt + completion + tokens into the high-token inference
  // event so the server's `cdxIsMainModel = input_tokens > 500` heuristic
  // creates a single main turn with all three pieces of data.
  const promptIdx = state.pending.findIndex(e => e.prompt);
  const inferIdx = state.pending.findIndex(e => e.requestType === 'inference' && (e.deltaInputTokens ?? 0) > 500);
  if (promptIdx >= 0 && inferIdx >= 0 && promptIdx !== inferIdx) {
    const promptEv = state.pending[promptIdx];
    const inferEv = state.pending[inferIdx];
    const completionEv = state.pending.find(
      (e, i) => e.completion && i !== inferIdx && i !== promptIdx
    );

    state.pending[inferIdx] = {
      ...inferEv,
      requestType: 'chat',
      prompt: promptEv.prompt,
      completion: completionEv?.completion ?? inferEv.completion,
      systemPrompt: promptEv.systemPrompt ?? inferEv.systemPrompt,
      developerMessages: promptEv.developerMessages ?? inferEv.developerMessages,
      environmentContext: promptEv.environmentContext ?? inferEv.environmentContext,
      turnContext: promptEv.turnContext ?? inferEv.turnContext,
    };

    const removeIdxs = new Set([promptIdx]);
    if (completionEv) {
      const cIdx = state.pending.indexOf(completionEv);
      if (cIdx >= 0) removeIdxs.add(cIdx);
    }
    state.pending = state.pending.filter((_, i) => !removeIdxs.has(i));
  }

  state.pending.sort((a, b) => {
    if (a.prompt && !b.prompt) return -1;
    if (!a.prompt && b.prompt) return 1;
    return 0;
  });

  for (const ev of state.pending) {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      session_title: state.sessionTitle,
      conversation_id: header.sessionId,
      event_sequence: ev.eventSequence,
      model_id: header.model,
      request_type: ev.requestType,
      prompt: ev.prompt,
      completion: ev.completion,
      system_prompt: ev.systemPrompt,
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
      // User info
      user: userName,
      hostname: require('os').hostname(),
      platform: process.platform,
      // Enriched Codex fields
      phase: ev.phase,
      rate_limits: ev.rateLimits,
      task_duration_ms: ev.taskDurationMs,
      model_context_window: ev.modelContextWindow,
      turn_context: ev.turnContext,
      developer_messages: ev.developerMessages,
      environment_context: ev.environmentContext,
      cli_version: header.cliVersion,
      originator: header.originator,
      codex_cwd: header.cwd,
      collaboration_mode_kind: state.collaborationModeKind,
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
