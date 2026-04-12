/**
 * OpenAI Codex prompt capture via native OpenTelemetry — OTLP HTTP receiver.
 *
 * Codex CLI supports OTLP HTTP exporter configured in ~/.codex/config.toml.
 * This module:
 * 1. Starts a local HTTP server that acts as an OTLP collector
 * 2. Receives log records, traces, and metrics from Codex
 * 3. Extracts content (prompts, completions, tool calls) and forwards to Argus
 *
 * OTEL events emitted by Codex:
 *   codex.api_request — status, attempts, duration
 *   codex.sse_event — token counts, caching metrics
 *   codex.user_prompt — user input (opt-in via log_user_prompt = true)
 *   codex.tool_decision — tool approval decisions
 *   codex.tool_result — execution outcomes, runtime
 */
import * as http from 'http';
import * as zlib from 'zlib';

/** Fixed port for the Codex OTLP HTTP receiver (Copilot uses 14318-14322). */
export const CODEX_OTLP_PORT = 14323;
const PREFERRED_PORTS = [14323, 14324, 14325, 14326, 14327];

let server: http.Server | null = null;
let serverPort = 0;
let sendFn: ((payload: Record<string, unknown>) => void) | null = null;
let logFn: (msg: string) => void = () => {};
let captureCount = 0;
let active = false;
let lastSpanTime = 0;
let sessionCounter = 0;
let totalHttpRequests = 0;
let parseErrors = 0;

/**
 * Start the local OTLP HTTP receiver for Codex telemetry.
 */
export async function startCodexOtelCapture(
  send: (payload: Record<string, unknown>) => void,
  logger: (msg: string) => void,
): Promise<boolean> {
  sendFn = send;
  logFn = logger;

  // Close any previous server to prevent zombie listeners
  if (server) {
    try { server.close(); } catch { /* best effort */ }
    server = null;
    serverPort = 0;
  }

  try {
    serverPort = await startOtlpServer(logger);
    if (!serverPort) {
      logger('[codex:otel] Failed to start OTLP server');
      return false;
    }

    const endpoint = `http://127.0.0.1:${serverPort}`;
    const isPreferredPort = PREFERRED_PORTS.includes(serverPort);
    logger(`[codex:otel] OTLP server listening on ${endpoint} (${isPreferredPort ? 'fixed' : 'random fallback'})`);

    active = true;
    logger('[codex:otel] OTLP receiver active — waiting for Codex traces/logs');
    return true;
  } catch (err) {
    logger(`[codex:otel] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// OTLP HTTP Server
// ---------------------------------------------------------------------------

function createOtlpHandler(logger: (msg: string) => void): http.RequestListener {
  return (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? '';

    // Health check
    if (method === 'GET' && (url === '/_health' || url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', captureCount, totalHttpRequests, parseErrors, active, serverPort }));
      return;
    }

    if (method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    totalHttpRequests++;
    const chunks: Buffer[] = [];
    req.on('error', (err) => {
      logger(`[codex:otel:server] Request error: ${err.message}`);
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const encoding = (req.headers['content-encoding'] ?? '').toLowerCase();
      const contentType = req.headers['content-type'] ?? '';

      logger(`[codex:otel:server] POST ${url} type=${contentType} encoding=${encoding || 'none'} size=${raw.length}`);

      // Decompress if needed
      let decompressed: Buffer;
      try {
        if (encoding === 'gzip' || encoding === 'x-gzip') {
          decompressed = zlib.gunzipSync(raw);
          logger(`[codex:otel:server] Decompressed gzip: ${raw.length} → ${decompressed.length} bytes`);
        } else if (encoding === 'deflate') {
          decompressed = zlib.inflateSync(raw);
        } else {
          decompressed = raw;
        }
      } catch (err) {
        parseErrors++;
        logger(`[codex:otel:server] Decompression failed: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'decompression_failed' }));
        return;
      }

      try {
        const body = decompressed.toString('utf-8');
        const data = JSON.parse(body) as Record<string, unknown>;

        if (url.includes('/v1/logs')) {
          processOtlpLogs(data, logger);
        } else if (url.includes('/v1/traces')) {
          processOtlpTraces(data, logger);
        } else if (url.includes('/v1/metrics')) {
          processOtlpMetrics(data, logger);
        } else {
          logger(`[codex:otel:server] Unknown endpoint: ${url}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch (err) {
        parseErrors++;
        const preview = decompressed.slice(0, 100).toString('utf-8').replace(/[^ -~]/g, '?');
        logger(`[codex:otel:server] JSON parse error on ${url}: ${err instanceof Error ? err.message : String(err)} preview="${preview}"`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'parse_error' }));
      }
    });
  };
}

function tryListenOnPort(
  handler: http.RequestListener,
  port: number,
  logger: (msg: string) => void,
): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') {
        logger(`[codex:otel] Port ${port} error: ${err.code} — ${err.message}`);
      }
      resolve(null);
    });
    srv.listen(port, '127.0.0.1', () => {
      // Defence in depth — only resolve once the kernel-level bind is done.
      // On any supported Node version `listening` is true once the listen
      // callback fires, but checking it explicitly prevents returning an
      // unbound server on some exotic error paths.
      if (srv.listening) {
        resolve(srv);
      } else {
        resolve(null);
      }
    });
  });
}

async function startOtlpServer(logger: (msg: string) => void): Promise<number> {
  const handler = createOtlpHandler(logger);

  for (const port of PREFERRED_PORTS) {
    const srv = await tryListenOnPort(handler, port, logger);
    if (srv) {
      server = srv;
      return port;
    }
    logger(`[codex:otel] Port ${port} busy, trying next...`);
  }

  // Fallback: random port
  logger('[codex:otel] All preferred ports busy, falling back to random port');
  const srv = await tryListenOnPort(handler, 0, logger);
  if (srv) {
    server = srv;
    const addr = srv.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// OTLP Log Records — where prompt/response content lives
// ---------------------------------------------------------------------------

function processOtlpLogs(data: Record<string, unknown>, logger: (msg: string) => void): void {
  const resourceLogs = data.resourceLogs as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(resourceLogs)) return;

  for (const rl of resourceLogs) {
    const scopeLogs = rl.scopeLogs as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(scopeLogs)) continue;

    for (const sl of scopeLogs) {
      const logRecords = sl.logRecords as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(logRecords)) continue;

      for (const record of logRecords) {
        processLogRecord(record, logger);
      }
    }
  }
}

function processLogRecord(record: Record<string, unknown>, logger: (msg: string) => void): void {
  const a = extractOtlpAttributes(record);
  const body = extractBody(record);
  const eventName = str(a['event.name']) ?? body ?? '';

  // Model info — try both codex-specific and gen_ai namespaces
  const model = str(a['gen_ai.request.model'])
    ?? str(a['gen_ai.response.model'])
    ?? str(a['codex.model']);
  const inputTokens = num(a['gen_ai.usage.input_tokens'])
    ?? num(a['codex.input_tokens']);
  const outputTokens = num(a['gen_ai.usage.output_tokens'])
    ?? num(a['codex.output_tokens']);

  // Content — Codex-specific attributes first, gen_ai fallback
  const codexUserPrompt = str(a['codex.user_prompt']);
  const codexAssistantResponse = str(a['codex.assistant_response']);
  const rawInputMessages = str(a['gen_ai.input.messages']);
  const rawOutputMessages = str(a['gen_ai.output.messages']);
  const systemInstructions = str(a['gen_ai.system_instructions']);

  const prompt = codexUserPrompt
    ?? extractUserMessageFromJson(rawInputMessages)
    ?? null;
  const completion = codexAssistantResponse
    ?? extractAssistantMessageFromJson(rawOutputMessages)
    ?? null;

  // Model parameters
  const temperature = num(a['gen_ai.request.temperature']);
  const topP = num(a['gen_ai.request.top_p']);
  const maxTokens = num(a['gen_ai.request.max_tokens']);
  const finishReasons = str(a['gen_ai.response.finish_reasons']);
  const responseId = str(a['gen_ai.response.id']);
  const conversationId = str(a['gen_ai.conversation.id'])
    ?? str(a['conversation.id']);

  // Tool calls
  const toolName = str(a['gen_ai.tool.name'])
    ?? str(a['codex.tool_name']);
  const toolDefinitions = str(a['gen_ai.tool.definitions']);
  const toolCallArguments = str(a['gen_ai.tool.call.arguments'])
    ?? str(a['codex.tool_input']);
  const toolCallResult = str(a['gen_ai.tool.call.result'])
    ?? str(a['codex.tool_result']);

  // Extra metrics
  const cacheReadTokens = num(a['gen_ai.usage.cache_read.input_tokens']);
  const reasoningTokens = num(a['gen_ai.usage.reasoning_tokens']);
  const ttft = num(a['codex.time_to_first_token']);
  const durationMs = num(a['codex.duration_ms']);

  const hasContent = !!(prompt || completion || systemInstructions);
  const isInference = eventName.includes('gen_ai.client.inference')
    || eventName.includes('GenAI inference')
    || eventName.includes('codex.api_request');
  const isToolEvent = eventName.includes('codex.tool_decision')
    || eventName.includes('codex.tool_result');
  const isUserPrompt = eventName.includes('codex.user_prompt');

  // Log all attribute keys at debug level for discovery
  const attrKeys = Object.keys(a);
  logger(
    `[codex:otel:log] event="${eventName.slice(0, 60)}" model=${model ?? '-'} ` +
    `tokens=${inputTokens ?? '-'}/${outputTokens ?? '-'} ` +
    `prompt=${prompt ? 'YES(' + prompt.length + ')' : 'no'} ` +
    `completion=${completion ? 'YES(' + completion.length + ')' : 'no'} ` +
    `attrs=[${attrKeys.join(',')}]`,
  );

  if (hasContent || (isInference && model) || isToolEvent || isUserPrompt) {
    // Session grouping
    const now = Date.now();
    if (now - lastSpanTime > 5 * 60 * 1000 && lastSpanTime > 0) sessionCounter++;
    lastSpanTime = now;
    const sessionId = conversationId
      ? `codex-${conversationId.slice(0, 8)}`
      : `codex-otel-${new Date().toISOString().slice(0, 10)}-${sessionCounter}`;

    captureCount++;
    const requestType = hasContent ? 'chat' : isToolEvent ? 'tool' : 'inference';
    logger(`[codex:otel:capture] #${captureCount} ${requestType} model=${model} prompt=${prompt?.length ?? 0}ch completion=${completion?.length ?? 0}ch`);

    if (sendFn) {
      sendFn({
        session_id: sessionId,
        model_id: model,
        request_type: requestType,
        prompt: prompt ? prompt.slice(0, 100_000) : null,
        completion: completion ? completion.slice(0, 200_000) : null,
        system_prompt: systemInstructions ? systemInstructions.slice(0, 100_000) : null,
        raw_input_messages: rawInputMessages ? rawInputMessages.slice(0, 100_000) : null,
        raw_output_messages: rawOutputMessages ? rawOutputMessages.slice(0, 200_000) : null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        reasoning_tokens: reasoningTokens,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        finish_reasons: finishReasons,
        response_id: responseId,
        conversation_id: conversationId,
        tool_name: toolName,
        tool_definitions: toolDefinitions ? toolDefinitions.slice(0, 20_000) : null,
        tool_call_arguments: toolCallArguments ? toolCallArguments.slice(0, 20_000) : null,
        tool_call_result: toolCallResult ? toolCallResult.slice(0, 50_000) : null,
        ttft_ms: ttft,
        duration_ms: durationMs,
        transport: 'otel-otlp',
        domain: 'api.openai.com',
        method: 'POST',
        path: '/v1/responses',
        status_code: 200,
        span_name: eventName,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// OTLP Traces
// ---------------------------------------------------------------------------

function processOtlpTraces(data: Record<string, unknown>, logger: (msg: string) => void): void {
  const resourceSpans = data.resourceSpans as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(resourceSpans)) return;

  let spanCount = 0;
  for (const rs of resourceSpans) {
    const scopeSpans = rs.scopeSpans as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      const spans = ss.spans as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(spans)) continue;
      spanCount += spans.length;
      for (const span of spans) {
        const a = extractOtlpAttributes(span);
        const name = String(span.name ?? '');
        const model = str(a['gen_ai.request.model']) ?? str(a['codex.model']);
        if (model) {
          logger(`[codex:otel:trace] span="${name}" model=${model} traceId=${span.traceId ?? '-'}`);
        }
      }
    }
  }
  if (spanCount > 0) {
    logger(`[codex:otel:traces] Received ${spanCount} trace spans`);
  }
}

// ---------------------------------------------------------------------------
// OTLP Metrics
// ---------------------------------------------------------------------------

function processOtlpMetrics(data: Record<string, unknown>, logger: (msg: string) => void): void {
  const resourceMetrics = data.resourceMetrics as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(resourceMetrics)) return;

  let metricCount = 0;
  for (const rm of resourceMetrics) {
    const scopeMetrics = rm.scopeMetrics as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(scopeMetrics)) continue;
    for (const sm of scopeMetrics) {
      const metrics = sm.metrics as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(metrics)) continue;
      metricCount += metrics.length;
    }
  }
  if (metricCount > 0) {
    logger(`[codex:otel:metrics] Received ${metricCount} metrics`);
  }
}

// ---------------------------------------------------------------------------
// OTLP attribute extraction (shared format with Copilot OTEL)
// ---------------------------------------------------------------------------

function extractOtlpAttributes(record: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const attrs = record.attributes;

  if (Array.isArray(attrs)) {
    for (const attr of attrs) {
      const a = attr as Record<string, unknown>;
      const key = String(a.key ?? '');
      const val = a.value as Record<string, unknown> | undefined;
      if (!val) continue;

      if (val.stringValue !== undefined) result[key] = String(val.stringValue);
      else if (val.intValue !== undefined) result[key] = Number(val.intValue);
      else if (val.doubleValue !== undefined) result[key] = Number(val.doubleValue);
      else if (val.boolValue !== undefined) result[key] = val.boolValue ? 1 : 0;
      else if (val.arrayValue) {
        const arr = (val.arrayValue as Record<string, unknown>).values as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(arr)) {
          result[key] = arr.map(av => String(av.stringValue ?? av.intValue ?? '')).join(',');
        }
      }
    }
  } else if (attrs && typeof attrs === 'object') {
    for (const [key, val] of Object.entries(attrs as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number') result[key] = val;
      else if (typeof val === 'boolean') result[key] = val ? 1 : 0;
      else if (Array.isArray(val)) result[key] = val.map(String).join(',');
    }
  }

  return result;
}

function extractBody(record: Record<string, unknown>): string | null {
  const body = record.body ?? record._body;
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return String(b.stringValue ?? b.value ?? '');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content parsing helpers
// ---------------------------------------------------------------------------

function extractUserMessageFromJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const messages = JSON.parse(raw) as Array<{ role?: string; content?: string }>;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content) return messages[i].content!;
    }
  } catch { /* not JSON */ }
  return null;
}

function extractAssistantMessageFromJson(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const messages = JSON.parse(raw) as Array<{ role?: string; content?: string }>;
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) return messages[i].content!;
    }
  } catch { /* not JSON */ }
  return null;
}

function str(v: string | number | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

function num(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function stopCodexOtelCapture(): void {
  if (server) {
    try { server.close(); } catch { /* best effort */ }
    server = null;
  }
  active = false;
  sendFn = null;
  logFn = () => {};
  sessionCounter = 0;
  lastSpanTime = 0;
  captureCount = 0;
  totalHttpRequests = 0;
  parseErrors = 0;
}

export function getCodexOtelStats(): {
  active: boolean;
  captureCount: number;
  serverPort: number;
  isFixedPort: boolean;
  totalHttpRequests: number;
  parseErrors: number;
} {
  return {
    active,
    captureCount,
    serverPort,
    isFixedPort: PREFERRED_PORTS.includes(serverPort),
    totalHttpRequests,
    parseErrors,
  };
}
