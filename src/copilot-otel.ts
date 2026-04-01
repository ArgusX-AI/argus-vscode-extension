/**
 * Copilot Chat prompt capture via built-in OpenTelemetry.
 *
 * Copilot Chat v0.41+ has built-in OTEL support with content capture.
 * This module:
 * 1. Enables OTEL settings (file exporter with content capture)
 * 2. Watches the OTEL output file for new traces
 * 3. Parses ALL GenAI semantic convention attributes
 * 4. Forwards captured data to the Argus server
 *
 * No monkey-patching, no proxy, no certificate issues.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let watcher: fs.FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let fileOffset = 0;
let otelFilePath = '';
let sendFn: ((payload: Record<string, unknown>) => void) | null = null;
let logFn: (msg: string) => void = () => {};
let captureCount = 0;
let active = false;
// Track last span timestamp for session gap detection
let lastSpanTime = 0;
let sessionCounter = 0;

/**
 * Configure Copilot Chat's OTEL settings and start watching for traces.
 */
export async function startOtelCapture(
  send: (payload: Record<string, unknown>) => void,
  logger: (msg: string) => void,
): Promise<boolean> {
  sendFn = send;
  logFn = logger;

  try {
    otelFilePath = path.join(os.tmpdir(), 'argus-copilot-otel.jsonl');
    logger(`[otel] Output file: ${otelFilePath}`);

    const config = vscode.workspace.getConfiguration('github.copilot.chat');
    const currentEnabled = config.get<boolean>('otel.enabled', false);
    const currentCapture = config.get<boolean>('otel.captureContent', false);
    const currentExporter = config.get<string>('otel.exporterType', 'otlp-http');
    const currentOutfile = config.get<string>('otel.outfile', '');

    logger(`[otel] Current settings: enabled=${currentEnabled}, captureContent=${currentCapture}, exporterType=${currentExporter}, outfile=${currentOutfile}`);

    const updates: Array<{ key: string; value: unknown }> = [];
    if (!currentEnabled) updates.push({ key: 'otel.enabled', value: true });
    if (!currentCapture) updates.push({ key: 'otel.captureContent', value: true });
    if (currentExporter !== 'file') updates.push({ key: 'otel.exporterType', value: 'file' });
    if (currentOutfile !== otelFilePath) updates.push({ key: 'otel.outfile', value: otelFilePath });

    if (updates.length > 0) {
      for (const u of updates) {
        await config.update(u.key, u.value, vscode.ConfigurationTarget.Global);
        logger(`[otel] Set github.copilot.chat.${u.key} = ${JSON.stringify(u.value)}`);
      }
      logger(`[otel] Settings updated (${updates.length} changes).`);
    } else {
      logger('[otel] Settings already configured correctly');
    }

    if (!fs.existsSync(otelFilePath)) {
      fs.writeFileSync(otelFilePath, '', 'utf-8');
      logger('[otel] Created output file');
    }

    const stats = fs.statSync(otelFilePath);
    fileOffset = stats.size;
    logger(`[otel] Starting file watch from offset ${fileOffset}`);

    startFileWatcher(logger);
    active = true;
    logger('[otel] OTEL capture started — waiting for Copilot Chat traces');

    if (updates.length > 0) {
      logger('[otel] NOTE: Copilot Chat may need a VS Code reload to start emitting OTEL data.');
    }

    return true;
  } catch (err) {
    logger(`[otel] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function startFileWatcher(logger: (msg: string) => void): void {
  if (watcher) return;

  try {
    watcher = fs.watch(otelFilePath, { persistent: false }, (eventType) => {
      if (eventType === 'change') readNewData(logger);
    });

    pollTimer = setInterval(() => {
      if (!active) {
        if (pollTimer) clearInterval(pollTimer);
        return;
      }
      readNewData(logger);
    }, 2000);

    logger('[otel] File watcher started');
  } catch (err) {
    logger(`[otel] File watcher error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readNewData(logger: (msg: string) => void): void {
  try {
    const stats = fs.statSync(otelFilePath);
    if (stats.size <= fileOffset) return;

    const fd = fs.openSync(otelFilePath, 'r');
    const bufSize = stats.size - fileOffset;
    const buffer = Buffer.alloc(bufSize);
    fs.readSync(fd, buffer, 0, bufSize, fileOffset);
    fs.closeSync(fd);
    fileOffset = stats.size;

    const newData = buffer.toString('utf-8');
    const lines = newData.split('\n').filter(line => line.trim().length > 0);

    for (const line of lines) {
      try {
        const trace = JSON.parse(line) as Record<string, unknown>;
        processOtelTrace(trace, logger);
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger(`[otel] Read error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function processOtelTrace(trace: Record<string, unknown>, logger: (msg: string) => void): void {
  try {
    const resourceSpans = trace.resourceSpans as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(resourceSpans)) {
      processSpan(trace, logger);
      return;
    }

    for (const rs of resourceSpans) {
      const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(scopeSpans)) continue;
      for (const ss of scopeSpans) {
        const spans = ss.spans as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(spans)) continue;
        for (const span of spans) {
          processSpan(span, logger);
        }
      }
    }
  } catch (err) {
    logger(`[otel] Trace processing error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Core span processing — extract ALL useful attributes
// ---------------------------------------------------------------------------

function processSpan(span: Record<string, unknown>, logger: (msg: string) => void): void {
  const a = extractAttributes(span);
  const spanName = String(span.name ?? span.operationName ?? '');
  const eventName = str(a['event.name']);

  // --- Model & token basics ---
  const model = str(a['gen_ai.request.model']) ?? str(a['gen_ai.response.model']);
  const inputTokens = num(a['gen_ai.usage.input_tokens']);
  const outputTokens = num(a['gen_ai.usage.output_tokens']);

  // --- Content (only present when captureContent=true) ---
  // Prefer Copilot-specific clean text over raw JSON message arrays
  const userRequest = str(a['copilot_chat.user_request']);
  const markdownContent = str(a['copilot_chat.markdown_content']);
  const reasoningContent = str(a['copilot_chat.reasoning_content']);
  const rawInputMessages = str(a['gen_ai.input.messages']);
  const rawOutputMessages = str(a['gen_ai.output.messages']);
  const systemInstructions = str(a['gen_ai.system_instructions']);

  // Extract clean prompt text
  const prompt = userRequest
    ?? extractUserMessageFromJson(rawInputMessages)
    ?? null;

  // Extract clean completion text
  const completion = markdownContent
    ?? extractAssistantMessageFromJson(rawOutputMessages)
    ?? null;

  // --- Request parameters ---
  const temperature = num(a['gen_ai.request.temperature']);
  const topP = num(a['gen_ai.request.top_p']);
  const maxTokens = num(a['gen_ai.request.max_tokens']);
  const finishReasons = str(a['gen_ai.response.finish_reasons']);
  const responseId = str(a['gen_ai.response.id']);

  // --- Conversation & session tracking ---
  const conversationId = str(a['gen_ai.conversation.id']);
  const agentName = str(a['gen_ai.agent.name']);

  // --- Tool call data ---
  const toolName = str(a['gen_ai.tool.name']);
  const toolDefinitions = str(a['gen_ai.tool.definitions']);
  const toolCallArguments = str(a['gen_ai.tool.call.arguments']);
  const toolCallResult = str(a['gen_ai.tool.call.result']);

  // --- Extra metrics ---
  const cacheReadTokens = num(a['gen_ai.usage.cache_read.input_tokens']);
  const cacheCreateTokens = num(a['gen_ai.usage.cache_creation.input_tokens']);
  const reasoningTokens = num(a['gen_ai.usage.reasoning_tokens']);
  const ttft = num(a['copilot_chat.time_to_first_token']);
  const intent = str(a['copilot_chat.intent']);
  const location = str(a['copilot_chat.location']);

  // --- Determine what type of span this is ---
  const isInference = eventName === 'gen_ai.client.inference.operation.details';
  const isAgentTurn = eventName === 'copilot_chat.agent.turn';
  const isToolCall = eventName === 'copilot_chat.tool.call';
  const isSessionStart = eventName === 'copilot_chat.session.start';
  const hasContent = !!(prompt || completion || systemInstructions);

  // Log span info
  const attrKeys = Object.keys(a);
  logger(
    `[otel:span] event="${eventName}" model=${model ?? '-'} ` +
    `tokens=${inputTokens ?? '-'}/${outputTokens ?? '-'} ` +
    `prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} ` +
    `completion=${completion ? 'yes(' + completion.length + ')' : 'no'} ` +
    `system=${systemInstructions ? 'yes(' + systemInstructions.length + ')' : 'no'} ` +
    `reasoning=${reasoningContent ? 'yes(' + reasoningContent.length + ')' : 'no'} ` +
    `keys=[${attrKeys.slice(0, 15).join(',')}${attrKeys.length > 15 ? ',...' : ''}]`,
  );

  // --- Session ID: use conversation_id or date+counter with gap detection ---
  const now = Date.now();
  if (now - lastSpanTime > 5 * 60 * 1000 && lastSpanTime > 0) {
    sessionCounter++;
  }
  lastSpanTime = now;
  const sessionId = conversationId
    ? `copilot-${conversationId.slice(0, 8)}`
    : `copilot-otel-${new Date().toISOString().slice(0, 10)}-${sessionCounter}`;

  // --- Send to Argus ---
  if (hasContent || (isInference && model) || isAgentTurn || isSessionStart) {
    captureCount++;

    const requestType = hasContent ? 'chat'
      : isToolCall ? 'tool_call'
      : isSessionStart ? 'session_start'
      : 'inference';

    logger(
      `[otel:capture] #${captureCount} ${requestType} model=${model ?? '-'} ` +
      `prompt=${prompt ? prompt.length + 'ch' : 'none'} completion=${completion ? completion.length + 'ch' : 'none'}`,
    );

    if (sendFn) {
      sendFn({
        session_id: sessionId,
        model_id: model,
        request_type: requestType,
        // Content
        prompt: prompt ? prompt.slice(0, 100_000) : null,
        completion: completion ? completion.slice(0, 200_000) : null,
        system_prompt: systemInstructions ? systemInstructions.slice(0, 100_000) : null,
        reasoning_content: reasoningContent ? reasoningContent.slice(0, 50_000) : null,
        // Raw JSON messages (for server-side parsing if clean text is empty)
        raw_input_messages: rawInputMessages ? rawInputMessages.slice(0, 100_000) : null,
        raw_output_messages: rawOutputMessages ? rawOutputMessages.slice(0, 200_000) : null,
        // Tokens
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_create_tokens: cacheCreateTokens,
        reasoning_tokens: reasoningTokens,
        // Model parameters
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        finish_reasons: finishReasons,
        response_id: responseId,
        // Conversation
        conversation_id: conversationId,
        agent_name: agentName,
        // Tool calls
        tool_name: toolName,
        tool_definitions: toolDefinitions ? toolDefinitions.slice(0, 20_000) : null,
        tool_call_arguments: toolCallArguments ? toolCallArguments.slice(0, 20_000) : null,
        tool_call_result: toolCallResult ? toolCallResult.slice(0, 50_000) : null,
        // Metrics
        ttft_ms: ttft,
        intent,
        location,
        // Transport
        transport: 'otel',
        domain: 'api.individual.githubcopilot.com',
        method: 'POST',
        path: '/chat/completions',
        status_code: 200,
        span_name: eventName ?? spanName,
        trace_id: span.traceId ?? (span.spanContext as Record<string, unknown>)?.traceId ?? null,
        span_id: span.spanId ?? (span.spanContext as Record<string, unknown>)?.spanId ?? null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Content parsing helpers
// ---------------------------------------------------------------------------

/** Extract the last user message from a JSON messages array string. */
function extractUserMessageFromJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const messages = JSON.parse(raw) as Array<{ role?: string; content?: string }>;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content) {
        return messages[i].content!;
      }
    }
  } catch { /* not valid JSON */ }
  return null;
}

/** Extract the assistant message from a JSON messages array string. */
function extractAssistantMessageFromJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const messages = JSON.parse(raw) as Array<{ role?: string; content?: string }>;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) {
        return messages[i].content!;
      }
    }
  } catch { /* not valid JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

function extractAttributes(span: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const attrs = span.attributes;

  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      const a = attr as Record<string, unknown>;
      const key = String(a.key ?? '');
      const val = a.value as Record<string, unknown> | string | number | undefined;

      if (typeof val === 'string' || typeof val === 'number') {
        result[key] = val;
      } else if (val && typeof val === 'object') {
        const v = val.stringValue ?? val.intValue ?? val.doubleValue ?? val.boolValue;
        if (v !== undefined && v !== null) {
          result[key] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number);
        }
        // Handle arrayValue (e.g., finish_reasons)
        if (val.arrayValue && typeof val.arrayValue === 'object') {
          const arr = (val.arrayValue as Record<string, unknown>).values as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(arr)) {
            result[key] = arr.map(av => String(av.stringValue ?? av.intValue ?? '')).join(',');
          }
        }
      }
    }
  } else if (attrs && typeof attrs === 'object') {
    for (const [key, val] of Object.entries(attrs as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number') {
        result[key] = val;
      } else if (typeof val === 'boolean') {
        result[key] = val ? 1 : 0;
      } else if (Array.isArray(val)) {
        // e.g., finish_reasons: ["stop"]
        result[key] = val.map(v => String(v)).join(',');
      }
    }
  }

  return result;
}

/** Safely get string from attribute value. */
function str(v: string | number | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

/** Safely get number from attribute value. */
function num(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function stopOtelCapture(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* best effort */ }
    watcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  active = false;
  sendFn = null;
}

export function getOtelStats(): {
  active: boolean;
  captureCount: number;
  otelFilePath: string;
  fileOffset: number;
} {
  return { active, captureCount, otelFilePath, fileOffset };
}
