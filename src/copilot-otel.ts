/**
 * Copilot Chat prompt capture via built-in OpenTelemetry — OTLP HTTP receiver.
 *
 * The file exporter only writes metrics. Traces and logs (which contain the
 * actual prompt/response content) are only sent via OTLP HTTP/gRPC.
 *
 * This module:
 * 1. Starts a local HTTP server that acts as an OTLP collector
 * 2. Configures Copilot to use otlp-http exporter pointing to our local server
 * 3. Receives log records with gen_ai.input.messages, copilot_chat.user_request, etc.
 * 4. Extracts content and forwards to the Argus server
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOrDeriveCopilotTitle } from './copilot-session-state';

/** Fixed port for the OTLP HTTP receiver. Copilot Chat defaults to port 4318
 *  (the standard OTLP port) for its `otel.otlpEndpoint` setting. We listen on
 *  4318 first so Copilot works without any config changes. Fallback ports are
 *  used only if 4318 is already occupied — in which case we must override
 *  the setting AND trigger a window reload for it to take effect. */
export const PREFERRED_OTLP_PORT = 4318;
const PREFERRED_PORTS = [4318, 14318, 14319, 14320, 14321, 14322];

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

// File watcher fallback state
let fileWatcherActive = false;
let fileWatcherPath: string | null = null;
let fileLastOffset = 0;
let fileRecordCount = 0;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
// Deduplication: track last cumulative token sums PER SESSION to avoid re-sending.
// Keyed by sessionId (not model) because multiple sessions alternate in the JSONL file.
let lastSentTokens: Record<string, { input: number; output: number }> = {};

// Debug dump state — when copilotDebugMode is enabled, write captured data
// to ~/Desktop/argus-otel-debug/session-.../ for diagnostic inspection.
let debugBasePath: string | null = null;
let debugHttpCounter = 0;
let debugFileCounter = 0;
let debugPayloadCounter = 0;

/**
 * Start the local OTLP HTTP receiver and configure Copilot to send data to it.
 */
export async function startOtelCapture(
  send: (payload: Record<string, unknown>) => void,
  logger: (msg: string) => void,
  debug = false,
): Promise<boolean> {
  sendFn = send;
  logFn = logger;

  // Guard: close any previous server to prevent zombie listeners on re-entry
  if (server) {
    try { server.close(); } catch { /* best effort */ }
    server = null;
    serverPort = 0;
  }

  try {
    // Step 1: Start local OTLP HTTP server
    serverPort = await startOtlpServer(logger);
    if (!serverPort) {
      logger('[otel] Failed to start OTLP server');
      return false;
    }

    const endpoint = `http://127.0.0.1:${serverPort}`;
    const isPreferredPort = serverPort === PREFERRED_OTLP_PORT;
    logger(`[otel] OTLP server listening on ${endpoint} (${isPreferredPort ? 'default 4318' : 'fallback'})`);

    // Step 2: Set Copilot-specific env vars. Per Copilot Chat package.json:
    //   COPILOT_OTEL_ENABLED, COPILOT_OTEL_CAPTURE_CONTENT, and
    //   OTEL_EXPORTER_OTLP_ENDPOINT all take PRECEDENCE over VS Code settings.
    // Setting them here is a best-effort — Copilot runs in the main Electron
    // process and may have already captured env at launch, but when we detect
    // the extension loading in the same host this can still stick.
    process.env.COPILOT_OTEL_ENABLED = 'true';
    process.env.COPILOT_OTEL_CAPTURE_CONTENT = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    process.env.OTEL_EXPORTER_OTLP_COMPRESSION = 'none';

    // Step 3: Configure Copilot Chat OTEL settings. These are the persistent
    // config path — env vars may not reach Copilot's process, but settings
    // survive VS Code restart. All require a window reload to take effect.
    const config = vscode.workspace.getConfiguration('github.copilot.chat');
    const updates: Array<{ key: string; value: unknown }> = [];

    if (config.get<boolean>('otel.enabled', false) !== true) {
      updates.push({ key: 'otel.enabled', value: true });
    }
    if (config.get<boolean>('otel.captureContent', false) !== true) {
      updates.push({ key: 'otel.captureContent', value: true });
    }
    // Force otlp-http exporter (default is 'otlp-http' but user may have changed it)
    if (config.get<string>('otel.exporterType') !== 'otlp-http') {
      updates.push({ key: 'otel.exporterType', value: 'otlp-http' });
    }
    // Only override endpoint if we're NOT on Copilot's default port 4318.
    // Copilot's default is http://localhost:4318 — matching it means no
    // setting change needed, which means no window reload needed.
    const defaultEndpoint = 'http://localhost:4318';
    const currentEndpoint = config.get<string>('otel.otlpEndpoint', defaultEndpoint);
    if (isPreferredPort) {
      // We're on 4318 — only clear a stale non-default override
      if (currentEndpoint !== defaultEndpoint && currentEndpoint !== endpoint) {
        updates.push({ key: 'otel.otlpEndpoint', value: defaultEndpoint });
      }
    } else {
      // We're on a fallback port — must override
      if (currentEndpoint !== endpoint) {
        updates.push({ key: 'otel.otlpEndpoint', value: endpoint });
      }
    }
    // Clear any stale outfile setting — it forces the file exporter and
    // overrides exporterType, killing OTLP HTTP content capture.
    const existingOutfile = config.get<string>('otel.outfile', '');
    if (existingOutfile && existingOutfile.length > 0) {
      updates.push({ key: 'otel.outfile', value: '' });
    }

    for (const u of updates) {
      await config.update(u.key, u.value, vscode.ConfigurationTarget.Global);
      logger(`[otel] Set github.copilot.chat.${u.key} = ${JSON.stringify(u.value)}`);
    }

    if (updates.length > 0) {
      logger(`[otel] ${updates.length} settings updated — WINDOW RELOAD REQUIRED for Copilot to pick up new OTEL config`);
      // Prompt user to reload so Copilot actually starts sending telemetry
      void vscode.window
        .showInformationMessage(
          'Argus: Copilot telemetry settings updated. Reload window to capture prompts.',
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    } else {
      logger('[otel] Settings already configured for OTLP HTTP — no reload needed');
    }

    active = true;
    logger('[otel] OTLP receiver active — waiting for Copilot Chat traces/logs');

    // Initialize debug dump if enabled
    if (debug) {
      initDebugDump(logger);
    }

    // Start file watcher immediately — Copilot is likely using the file exporter
    // and the JSONL file is already being written to. This runs alongside the
    // OTLP HTTP server so both capture paths work in parallel.
    startOtelFileWatcher(logger);

    return true;
  } catch (err) {
    logger(`[otel] Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Debug Dump — writes captured data to ~/Desktop/argus-otel-debug/ for inspection
// ---------------------------------------------------------------------------

function initDebugDump(logger: (msg: string) => void): void {
  try {
    const desktop = path.join(os.homedir(), 'Desktop', 'argus-otel-debug');
    const sessionName = `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const sessionPath = path.join(desktop, sessionName);
    fs.mkdirSync(path.join(sessionPath, 'http'), { recursive: true });
    fs.mkdirSync(path.join(sessionPath, 'file-watcher'), { recursive: true });
    fs.mkdirSync(path.join(sessionPath, 'payloads-sent'), { recursive: true });

    // Cleanup old sessions (> 24h)
    if (fs.existsSync(desktop)) {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const entry of fs.readdirSync(desktop)) {
        if (!entry.startsWith('session-')) continue;
        const p = path.join(desktop, entry);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) {
            fs.rmSync(p, { recursive: true, force: true });
          }
        } catch { /* skip */ }
      }
    }

    const copilotSettings = vscode.workspace.getConfiguration('github.copilot.chat');
    const manifest = [
      `Argus OTEL Debug Dump`,
      `Session started: ${new Date().toISOString()}`,
      `OTLP server port: ${serverPort}`,
      `VS Code: ${vscode.version}`,
      `Node: ${process.version}`,
      `Platform: ${process.platform}`,
      ``,
      `Copilot OTEL settings:`,
      `  otel.enabled:        ${copilotSettings.get<boolean>('otel.enabled')}`,
      `  otel.captureContent: ${copilotSettings.get<boolean>('otel.captureContent')}`,
      `  otel.exporterType:   ${copilotSettings.get<string>('otel.exporterType')}`,
      `  otel.otlpEndpoint:   ${copilotSettings.get<string>('otel.otlpEndpoint')}`,
      `  otel.outfile:        ${copilotSettings.get<string>('otel.outfile')}`,
      ``,
      `Env vars:`,
      `  OTEL_EXPORTER_OTLP_ENDPOINT:    ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
      `  OTEL_EXPORTER_OTLP_PROTOCOL:    ${process.env.OTEL_EXPORTER_OTLP_PROTOCOL}`,
      `  OTEL_EXPORTER_OTLP_COMPRESSION: ${process.env.OTEL_EXPORTER_OTLP_COMPRESSION}`,
      ``,
      `Folder layout:`,
      `  http/           — raw OTLP HTTP POST bodies + parsed JSON`,
      `  file-watcher/   — JSONL records from Copilot's OTEL file exporter`,
      `  payloads-sent/  — payloads sent to the Argus server`,
    ].join('\n');
    fs.writeFileSync(path.join(sessionPath, 'MANIFEST.txt'), manifest);

    debugBasePath = sessionPath;
    debugHttpCounter = 0;
    debugFileCounter = 0;
    debugPayloadCounter = 0;
    logger(`[otel:debug] Debug dump enabled → ${sessionPath}`);
  } catch (err) {
    logger(`[otel:debug] Failed to init debug dump: ${err instanceof Error ? err.message : String(err)}`);
    debugBasePath = null;
  }
}

function dumpHttp(
  url: string,
  headers: http.IncomingHttpHeaders,
  raw: Buffer,
  decompressed: Buffer,
  parsed: unknown,
): void {
  if (!debugBasePath) return;
  try {
    debugHttpCounter++;
    const n = String(debugHttpCounter).padStart(4, '0');
    const endpoint = url.replace(/^\//, '').replace(/\//g, '-') || 'root';
    const dir = path.join(debugBasePath, 'http');
    fs.writeFileSync(path.join(dir, `${n}-${endpoint}.raw`), raw);
    fs.writeFileSync(
      path.join(dir, `${n}-${endpoint}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        url,
        headers,
        rawSize: raw.length,
        decompressedSize: decompressed.length,
        decompressedPreview: decompressed.slice(0, 2000).toString('utf-8'),
        parsed,
      }, null, 2),
    );
  } catch { /* best effort */ }
}

function dumpFileRecord(record: unknown): void {
  if (!debugBasePath) return;
  try {
    debugFileCounter++;
    const n = String(debugFileCounter).padStart(4, '0');
    fs.writeFileSync(
      path.join(debugBasePath, 'file-watcher', `${n}-record.json`),
      JSON.stringify(record, null, 2),
    );
  } catch { /* best effort */ }
}

function dumpPayload(source: 'log' | 'file-metric', payload: Record<string, unknown>): void {
  if (!debugBasePath) return;
  try {
    debugPayloadCounter++;
    const n = String(debugPayloadCounter).padStart(4, '0');
    fs.writeFileSync(
      path.join(debugBasePath, 'payloads-sent', `${n}-${source}.json`),
      JSON.stringify({ timestamp: new Date().toISOString(), source, payload }, null, 2),
    );
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// OTLP HTTP Server
// ---------------------------------------------------------------------------

function createOtlpHandler(logger: (msg: string) => void): http.RequestListener {
  return (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? '';

    // Health check endpoint for diagnostics
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
      logger(`[otel:server] Request error: ${err.message}`);
    });
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const encoding = (req.headers['content-encoding'] ?? '').toLowerCase();
      const contentType = req.headers['content-type'] ?? '';

      logger(`[otel:server] POST ${url} type=${contentType} encoding=${encoding || 'none'} size=${raw.length}`);

      // Decompress if needed (OTLP clients commonly send gzip)
      let decompressed: Buffer;
      try {
        if (encoding === 'gzip' || encoding === 'x-gzip') {
          decompressed = zlib.gunzipSync(raw);
          logger(`[otel:server] Decompressed gzip: ${raw.length} → ${decompressed.length} bytes`);
        } else if (encoding === 'deflate') {
          decompressed = zlib.inflateSync(raw);
        } else {
          decompressed = raw;
        }
      } catch (err) {
        parseErrors++;
        logger(`[otel:server] Decompression failed (${encoding}): ${err instanceof Error ? err.message : String(err)} raw=${raw.length}b first=${raw.slice(0, 20).toString('hex')}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'decompression_failed' }));
        return;
      }

      try {
        const body = decompressed.toString('utf-8');
        const data = JSON.parse(body) as Record<string, unknown>;

        // Debug dump — write raw + parsed for inspection
        dumpHttp(url, req.headers, raw, decompressed, data);

        if (url.includes('/v1/logs')) {
          processOtlpLogs(data, logger);
        } else if (url.includes('/v1/traces')) {
          processOtlpTraces(data, logger);
        } else if (url.includes('/v1/metrics')) {
          processOtlpMetrics(data, logger);
        } else {
          logger(`[otel:server] Unknown endpoint: ${url}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch (err) {
        parseErrors++;
        const preview = decompressed.slice(0, 100).toString('utf-8').replace(/[^ -~]/g, '?');
        logger(`[otel:server] JSON parse error on ${url}: ${err instanceof Error ? err.message : String(err)} size=${decompressed.length} preview="${preview}"`);
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
        logger(`[otel] Port ${port} error: ${err.code} — ${err.message}`);
      }
      resolve(null);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function startOtlpServer(logger: (msg: string) => void): Promise<number> {
  const handler = createOtlpHandler(logger);

  // Try each preferred port in order
  for (const port of PREFERRED_PORTS) {
    const srv = await tryListenOnPort(handler, port, logger);
    if (srv) {
      server = srv;
      return port;
    }
    logger(`[otel] Port ${port} busy, trying next...`);
  }

  // Ultimate fallback: random port (better than nothing)
  logger('[otel] All preferred ports busy, falling back to random port');
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

  // Extract content fields
  const model = str(a['gen_ai.request.model']) ?? str(a['gen_ai.response.model']);
  const inputTokens = num(a['gen_ai.usage.input_tokens']);
  const outputTokens = num(a['gen_ai.usage.output_tokens']);

  // Content — prefer clean Copilot-specific fields over raw JSON
  const userRequest = str(a['copilot_chat.user_request']);
  const markdownContent = str(a['copilot_chat.markdown_content']);
  const reasoningContent = str(a['copilot_chat.reasoning_content']);
  const rawInputMessages = str(a['gen_ai.input.messages']);
  const rawOutputMessages = str(a['gen_ai.output.messages']);
  const systemInstructions = str(a['gen_ai.system_instructions']);

  const prompt = userRequest
    ?? extractUserMessageFromJson(rawInputMessages)
    ?? null;
  const completion = markdownContent
    ?? extractAssistantMessageFromJson(rawOutputMessages)
    ?? null;

  // Model parameters
  const temperature = num(a['gen_ai.request.temperature']);
  const topP = num(a['gen_ai.request.top_p']);
  const maxTokens = num(a['gen_ai.request.max_tokens']);
  const finishReasons = str(a['gen_ai.response.finish_reasons']);
  const responseId = str(a['gen_ai.response.id']);
  const conversationId = str(a['gen_ai.conversation.id']);
  const agentName = str(a['gen_ai.agent.name']);

  // Tool calls
  const toolName = str(a['gen_ai.tool.name']);
  const toolDefinitions = str(a['gen_ai.tool.definitions']);
  const toolCallArguments = str(a['gen_ai.tool.call.arguments']);
  const toolCallResult = str(a['gen_ai.tool.call.result']);

  // Extra metrics
  const cacheReadTokens = num(a['gen_ai.usage.cache_read.input_tokens']);
  const reasoningTokens = num(a['gen_ai.usage.reasoning_tokens']);
  const ttft = num(a['copilot_chat.time_to_first_token']);
  const intent = str(a['copilot_chat.intent']);
  const location = str(a['copilot_chat.location']);

  const hasContent = !!(prompt || completion || systemInstructions);
  const isInference = eventName.includes('gen_ai.client.inference') || eventName.includes('GenAI inference');
  const isAgentTurn = eventName.includes('copilot_chat.agent.turn');

  // Log
  const attrKeys = Object.keys(a);
  logger(
    `[otel:log] event="${eventName.slice(0, 60)}" model=${model ?? '-'} ` +
    `tokens=${inputTokens ?? '-'}/${outputTokens ?? '-'} ` +
    `prompt=${prompt ? 'YES(' + prompt.length + ')' : 'no'} ` +
    `completion=${completion ? 'YES(' + completion.length + ')' : 'no'} ` +
    `system=${systemInstructions ? 'yes(' + systemInstructions.length + ')' : 'no'} ` +
    `attrs=${attrKeys.length}`,
  );

  if (hasContent || (isInference && model) || isAgentTurn) {
    // Session grouping
    const now = Date.now();
    if (now - lastSpanTime > 5 * 60 * 1000 && lastSpanTime > 0) sessionCounter++;
    lastSpanTime = now;
    const sessionId = conversationId
      ? `copilot-${conversationId.slice(0, 8)}`
      : `copilot-otel-${new Date().toISOString().slice(0, 10)}-${sessionCounter}`;

    captureCount++;
    const requestType = hasContent ? 'chat' : 'inference';
    logger(`[otel:capture] #${captureCount} ${requestType} model=${model} prompt=${prompt?.length ?? 0}ch completion=${completion?.length ?? 0}ch`);

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      model_id: model,
      request_type: requestType,
      prompt: prompt ? prompt.slice(0, 100_000) : null,
      completion: completion ? completion.slice(0, 200_000) : null,
      system_prompt: systemInstructions ? systemInstructions.slice(0, 100_000) : null,
      reasoning_content: reasoningContent ? reasoningContent.slice(0, 50_000) : null,
      raw_input_messages: rawInputMessages ? rawInputMessages.slice(0, 100_000) : null,
      raw_output_messages: rawOutputMessages ? rawOutputMessages.slice(0, 200_000) : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      reasoning_tokens: reasoningTokens,
      temperature, top_p: topP, max_tokens: maxTokens,
      finish_reasons: finishReasons,
      response_id: responseId,
      conversation_id: conversationId,
      agent_name: agentName,
      tool_name: toolName,
      tool_definitions: toolDefinitions ? toolDefinitions.slice(0, 20_000) : null,
      tool_call_arguments: toolCallArguments ? toolCallArguments.slice(0, 20_000) : null,
      tool_call_result: toolCallResult ? toolCallResult.slice(0, 50_000) : null,
      ttft_ms: ttft,
      intent, location,
      transport: 'otel-otlp',
      domain: 'api.individual.githubcopilot.com',
      method: 'POST',
      path: '/chat/completions',
      status_code: 200,
      span_name: eventName,
      session_title: getOrDeriveCopilotTitle(sessionId, prompt),
    };
    dumpPayload('log', payload);
    if (sendFn) {
      sendFn(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// OTLP Traces — span-level data (timing, trace context)
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
      // Trace spans contain timing/context but content is in logs.
      // Process them for trace IDs and duration if needed.
      for (const span of spans) {
        const a = extractOtlpAttributes(span);
        const name = String(span.name ?? '');
        const model = str(a['gen_ai.request.model']);
        if (model) {
          logger(`[otel:trace] span="${name}" model=${model} traceId=${span.traceId ?? '-'}`);
        }
      }
    }
  }
  if (spanCount > 0) {
    logger(`[otel:traces] Received ${spanCount} trace spans`);
  }
}

// ---------------------------------------------------------------------------
// OTLP Metrics — token counts, histograms
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
    logger(`[otel:metrics] Received ${metricCount} metrics`);
  }
}

// ---------------------------------------------------------------------------
// OTLP attribute extraction (array format with typed values)
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

      // OTLP typed values: stringValue, intValue, doubleValue, boolValue
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
    // Fallback: plain object format
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

/**
 * Extract session.id from a JSONL record's resource._rawAttributes.
 * Copilot writes resource attributes as an array of [key, value] pairs.
 */
function extractResourceSessionId(record: Record<string, unknown>): string | null {
  const resource = record.resource as Record<string, unknown> | undefined;
  if (!resource) return null;
  const rawAttrs = resource._rawAttributes;
  if (!Array.isArray(rawAttrs)) return null;
  for (const entry of rawAttrs) {
    if (Array.isArray(entry) && entry[0] === 'session.id' && typeof entry[1] === 'string') {
      return entry[1];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// File watcher fallback — captures metrics when OTLP HTTP isn't working
// ---------------------------------------------------------------------------

function startOtelFileWatcher(logger: (msg: string) => void): void {
  const config = vscode.workspace.getConfiguration('github.copilot.chat');
  let filePath = config.get<string>('otel.outfile') ?? null;

  if (!filePath) {
    filePath = path.join(os.tmpdir(), 'argus-copilot-otel.jsonl');
  }

  // Do NOT change exporterType — just watch whatever file Copilot is already writing to.
  // The OTLP HTTP server stays active in parallel for content capture.

  fileWatcherPath = filePath;

  // Start from current end of file to avoid processing old data
  try {
    if (fs.existsSync(filePath)) {
      fileLastOffset = fs.statSync(filePath).size;
    }
  } catch { /* file may not exist yet */ }

  fs.watchFile(filePath, { interval: 2000 }, () => {
    readNewFileLines(filePath!, logger);
  });

  fileWatcherActive = true;
  logger(`[otel:file] File watcher active on ${filePath}`);
}

function readNewFileLines(filePath: string, logger: (msg: string) => void): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= fileLastOffset) return;

    const buf = Buffer.alloc(stat.size - fileLastOffset);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, fileLastOffset);
    fs.closeSync(fd);
    fileLastOffset = stat.size;

    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        dumpFileRecord(record);
        processFileMetricRecord(record, logger);
        fileRecordCount++;
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    logger(`[otel:file] Read error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ModelTokens { input: number; output: number }

function processFileMetricRecord(record: Record<string, unknown>, logger: (msg: string) => void): void {
  // Copilot's file exporter writes JSONL with cumulative metrics per export cycle.
  // Strategy: collect ALL token data from this line, pick the MAIN model (highest
  // input tokens), and send ONE event. Skip if unchanged from last send (dedup).
  const scopeMetrics = record.scopeMetrics as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(scopeMetrics)) return;

  // Step 1: Collect cumulative token sums per model from this line
  const modelTokens: Record<string, ModelTokens> = {};

  for (const sm of scopeMetrics) {
    const metrics = sm.metrics as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(metrics)) continue;
    for (const metric of metrics) {
      const descriptor = metric.descriptor as Record<string, unknown> | undefined;
      const metricName = String(descriptor?.name ?? metric.name ?? '');
      if (metricName !== 'gen_ai.client.token.usage') continue;

      const dataPoints = metric.dataPoints as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(dataPoints)) continue;

      for (const dp of dataPoints) {
        const a = extractOtlpAttributes(dp);
        const model = str(a['gen_ai.request.model']) ?? str(a['gen_ai.response.model']);
        if (!model) continue;

        const tokenType = str(a['gen_ai.token.type']);
        const val = dp.value as Record<string, unknown> | undefined;
        const tokenCount = num(val?.sum as number) ?? num(dp.value as number);
        if (!tokenCount || !tokenType) continue;

        if (!modelTokens[model]) modelTokens[model] = { input: 0, output: 0 };
        if (tokenType === 'input') modelTokens[model].input = tokenCount;
        if (tokenType === 'output') modelTokens[model].output = tokenCount;
      }
    }
  }

  // Step 2: Pick the main model (highest input tokens — the real chat model)
  let mainModel: string | null = null;
  let maxInput = 0;
  for (const [model, tokens] of Object.entries(modelTokens)) {
    if (tokens.input > maxInput) {
      maxInput = tokens.input;
      mainModel = model;
    }
  }
  if (!mainModel) return;
  const tokens = modelTokens[mainModel];

  // Step 3: Resolve session ID FIRST (needed for per-session dedup)
  const copilotSessionId = extractResourceSessionId(record);
  const now = Date.now();
  if (now - lastSpanTime > 5 * 60 * 1000 && lastSpanTime > 0) sessionCounter++;
  lastSpanTime = now;
  const sessionId = copilotSessionId
    ? `copilot-${copilotSessionId.slice(0, 8)}`
    : `copilot-otel-${new Date().toISOString().slice(0, 10)}-${sessionCounter}`;

  // Step 4: Dedup — keyed by SESSION ID (not model). Multiple sessions alternate
  // in the JSONL file; per-model dedup causes cross-session interference.
  const prev = lastSentTokens[sessionId];
  if (prev && prev.input === tokens.input && prev.output === tokens.output) return;

  const deltaInput = Math.max(0, prev ? tokens.input - prev.input : tokens.input);
  const deltaOutput = Math.max(0, prev ? tokens.output - prev.output : tokens.output);
  if (deltaInput === 0 && deltaOutput === 0) return;

  lastSentTokens[sessionId] = { input: tokens.input, output: tokens.output };

  // Step 5: Send ONE event per session per change
  logger(`[otel:file] ${sessionId.slice(0,16)} ${mainModel} Δin=${deltaInput} Δout=${deltaOutput}`);

  const filePayload: Record<string, unknown> = {
    session_id: sessionId,
    model_id: mainModel,
    request_type: 'chat',
    input_tokens: deltaInput,
    output_tokens: deltaOutput,
    cumulative_input_tokens: tokens.input,
    cumulative_output_tokens: tokens.output,
    transport: 'otel-file',
    domain: 'api.individual.githubcopilot.com',
    method: 'POST',
    path: '/chat/completions',
    status_code: 200,
    span_name: 'gen_ai.client.token.usage',
    session_title: getOrDeriveCopilotTitle(sessionId, null),
  };
  dumpPayload('file-metric', filePayload);
  if (sendFn) {
    sendFn(filePayload);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function stopOtelCapture(): void {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (server) {
    try { server.close(); } catch { /* best effort */ }
    server = null;
  }
  if (fileWatcherPath) {
    try { fs.unwatchFile(fileWatcherPath); } catch { /* best effort */ }
    fileWatcherPath = null;
  }
  active = false;
  fileWatcherActive = false;
  sendFn = null;
  logFn = () => {};
  lastSentTokens = {};
  sessionCounter = 0;
  lastSpanTime = 0;
  captureCount = 0;
  totalHttpRequests = 0;
  parseErrors = 0;
  fileRecordCount = 0;
  fileLastOffset = 0;
  debugBasePath = null;
  debugHttpCounter = 0;
  debugFileCounter = 0;
  debugPayloadCounter = 0;
}

/** Returns true when OTEL capture is active and handling Copilot data. */
export function isOtelCaptureActive(): boolean {
  return active;
}

export function getOtelStats(): {
  active: boolean;
  captureCount: number;
  serverPort: number;
  isFixedPort: boolean;
  totalHttpRequests: number;
  parseErrors: number;
  fileWatcherActive: boolean;
  fileRecordCount: number;
} {
  return {
    active, captureCount, serverPort,
    isFixedPort: PREFERRED_PORTS.includes(serverPort),
    totalHttpRequests, parseErrors,
    fileWatcherActive, fileRecordCount,
  };
}
