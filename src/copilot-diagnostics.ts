/**
 * Copilot request interception via Node.js diagnostics_channel.
 *
 * This is the primary interception layer for Copilot Chat prompts.
 * Unlike monkey-patching (which fails on non-configurable module exports
 * in Node v22 and can't catch cached fetch references or HTTP/2 via undici),
 * diagnostics_channel hooks into undici's internals and fires for ALL
 * requests regardless of how they were initiated.
 *
 * Used by OpenTelemetry in production for the same purpose.
 */
import diagnostics_channel from 'node:diagnostics_channel';
import http2 from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, IncomingHttpStatusHeader } from 'node:http2';
import { isCopilotDomain } from './copilot-intercept';

const MAX_REQUEST_BODY = 50 * 1024;
const MAX_RESPONSE_BODY = 100 * 1024;

interface DiagRequestState {
  hostname: string;
  path: string;
  method: string;
  requestChunks: Buffer[];
  requestSize: number;
  responseChunks: Buffer[];
  responseSize: number;
  statusCode: number;
  contentType: string;
  startTime: number;
}

const requestStates = new WeakMap<object, DiagRequestState>();
const subscriptions: Array<{ channel: string; unsubscribe: () => void }> = [];

let sendFn: ((payload: Record<string, unknown>) => void) | null = null;
let logFn: (msg: string) => void = () => {};
let diagInterceptCount = 0;
let active = false;
let debugEndTimeMs = 0;

export function startDiagnosticsInterception(
  send: (payload: Record<string, unknown>) => void,
  logger: (msg: string) => void,
  debugEndTime: number,
): void {
  if (active) return;
  sendFn = send;
  logFn = logger;
  debugEndTimeMs = debugEndTime;
  active = true;

  // --- UNDICI CHANNELS ---
  // These fire for globalThis.fetch, undici.request(), bundled undici, and HTTP/2 via undici.

  trySubscribe('undici:request:create', (message: unknown) => {
    try {
      const { request } = message as { request: Record<string, unknown> };
      const origin = String(request.origin ?? '');
      const path = String(request.path ?? '/');
      const method = String(request.method ?? 'GET');

      let hostname = '';
      try { hostname = new URL(origin).hostname; } catch { /* not a URL */ }

      if (Date.now() < debugEndTimeMs) {
        logFn(`[diag:undici] request:create ${method} ${hostname}${path}`);
      }

      if (!hostname || !isCopilotDomain(hostname)) return;

      logFn(`[diag] Copilot request: ${method} ${hostname}${path}`);
      diagInterceptCount++;

      requestStates.set(request, {
        hostname, path, method,
        requestChunks: [], requestSize: 0,
        responseChunks: [], responseSize: 0,
        statusCode: 0, contentType: '',
        startTime: Date.now(),
      });
    } catch { /* never break undici */ }
  });

  // Request body chunks (available in recent undici)
  trySubscribe('undici:request:bodyChunkSent', (message: unknown) => {
    try {
      const { request, chunk } = message as { request: object; chunk: Buffer };
      const state = requestStates.get(request);
      if (state && state.requestSize < MAX_REQUEST_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string);
        state.requestChunks.push(buf.subarray(0, MAX_REQUEST_BODY - state.requestSize));
        state.requestSize += buf.length;
      }
    } catch { /* never break */ }
  });

  // Response headers
  trySubscribe('undici:request:headers', (message: unknown) => {
    try {
      const { request, response } = message as {
        request: object;
        response: { statusCode: number; headers: Buffer[] };
      };
      const state = requestStates.get(request);
      if (!state) return;

      state.statusCode = response.statusCode;

      // Extract content-type from raw headers (Buffer[] pairs: [name, value, ...])
      if (Array.isArray(response.headers)) {
        for (let i = 0; i < response.headers.length - 1; i += 2) {
          const name = response.headers[i]?.toString?.()?.toLowerCase?.();
          if (name === 'content-type') {
            state.contentType = response.headers[i + 1]?.toString?.() ?? '';
            break;
          }
        }
      }
    } catch { /* never break */ }
  });

  // Response body chunks
  trySubscribe('undici:request:bodyChunkReceived', (message: unknown) => {
    try {
      const { request, chunk } = message as { request: object; chunk: Buffer };
      const state = requestStates.get(request);
      if (state && state.responseSize < MAX_RESPONSE_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string);
        state.responseChunks.push(buf.subarray(0, MAX_RESPONSE_BODY - state.responseSize));
        state.responseSize += buf.length;
      }
    } catch { /* never break */ }
  });

  // Request complete — flush to Argus
  trySubscribe('undici:request:trailers', (message: unknown) => {
    try {
      const { request } = message as { request: object };
      flushRequest(request);
    } catch { /* never break */ }
  });

  // Request error — also flush what we have
  trySubscribe('undici:request:error', (message: unknown) => {
    try {
      const { request } = message as { request: object };
      flushRequest(request);
    } catch { /* never break */ }
  });

  // Supplementary: log when headers are actually sent on the wire
  trySubscribe('undici:client:sendHeaders', (message: unknown) => {
    try {
      const { request } = message as { request: object; headers: string; socket: unknown };
      const state = requestStates.get(request);
      if (state && Date.now() < debugEndTimeMs) {
        logFn(`[diag:undici] sendHeaders for ${state.hostname}${state.path}`);
      }
    } catch { /* never break */ }
  });

  // Request body fully sent
  trySubscribe('undici:request:bodySent', (message: unknown) => {
    try {
      const { request } = message as { request: object };
      const state = requestStates.get(request);
      if (state && Date.now() < debugEndTimeMs) {
        logFn(`[diag:undici] bodySent for ${state.hostname}${state.path} (${state.requestSize} bytes)`);
      }
    } catch { /* never break */ }
  });

  // --- HTTP CLIENT CHANNELS (Node v22+) ---
  // These fire for http.request/https.request (not undici).
  trySubscribe('http.client.request.start', (message: unknown) => {
    try {
      const msg = message as Record<string, unknown>;
      const req = msg.request as Record<string, unknown> | undefined;
      const hostname = req?.hostname ?? req?.host ?? 'unknown';
      logFn(`[diag:http] request.start ${req?.method ?? '?'} ${hostname}${req?.path ?? '/'}`);
    } catch { /* never break */ }
  });

  trySubscribe('http.client.response.finish', (message: unknown) => {
    try {
      const msg = message as Record<string, unknown>;
      const req = msg.request as Record<string, unknown> | undefined;
      const res = msg.response as Record<string, unknown> | undefined;
      const hostname = req?.hostname ?? req?.host ?? 'unknown';
      logFn(`[diag:http] response.finish ${req?.method ?? '?'} ${hostname}${req?.path ?? '/'} status=${res?.statusCode ?? '?'}`);
    } catch { /* never break */ }
  });

  // --- NET SOCKET CHANNELS (Node v22+) ---
  // TracingChannel — fires for ALL TCP socket connections
  for (const phase of ['start', 'end', 'error'] as const) {
    trySubscribe(`tracing:net.client.socket:${phase}`, (message: unknown) => {
      try {
        const msg = message as Record<string, unknown>;
        const options = msg.options as Record<string, unknown> | undefined;
        const host = options?.host ?? options?.hostname ?? 'unknown';
        const port = options?.port ?? '?';
        if (Date.now() < debugEndTimeMs) {
          logFn(`[diag:net] socket:${phase} ${host}:${port}`);
        }
      } catch { /* never break */ }
    });
  }

  // --- HTTP/2 PATCHING ---
  // Copilot Chat may use http2 directly for streaming chat completions.
  patchHttp2(logFn);

  logFn(`[diag] Subscribed to ${subscriptions.length} diagnostic channels`);
  logFn(`[diag] Channels: ${subscriptions.map(s => s.channel).join(', ')}`);
}

function flushRequest(request: object): void {
  const state = requestStates.get(request);
  if (!state) return;
  requestStates.delete(request);

  const requestBody = Buffer.concat(state.requestChunks).toString('utf-8');
  const responseBody = Buffer.concat(state.responseChunks).toString('utf-8');
  const durationMs = Date.now() - state.startTime;

  // Determine request type
  let requestType: 'chat' | 'completion' | 'other' = 'other';
  if (state.path.includes('/chat/') || state.path.includes('/threads/') || state.path.includes('/v1/messages')) {
    requestType = 'chat';
  } else if (state.path.includes('/completions') || state.path.includes('/generate')) {
    requestType = 'completion';
  }

  // Extract prompt
  let prompt: string | null = null;
  try {
    const parsed = JSON.parse(requestBody) as Record<string, unknown>;
    prompt = extractPromptFromParsed(parsed);
  } catch { /* not JSON */ }

  // Extract completion
  let completion: string | null = null;
  if (state.contentType.includes('text/event-stream')) {
    completion = extractSseCompletion(responseBody);
  } else {
    try {
      const parsed = JSON.parse(responseBody) as Record<string, unknown>;
      completion = extractJsonCompletion(parsed);
    } catch { /* not JSON */ }
  }

  logFn(
    `[diag:capture] ${state.method} ${state.hostname}${state.path} ` +
    `type=${requestType} prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} ` +
    `completion=${completion ? 'yes(' + completion.length + ')' : 'no'} status=${state.statusCode}`,
  );

  if (sendFn) {
    sendFn({
      session_id: `copilot-${new Date().toISOString().slice(0, 10)}`,
      domain: state.hostname,
      path: state.path,
      method: state.method,
      request_type: requestType,
      prompt,
      completion,
      status_code: state.statusCode,
      content_type: state.contentType,
      duration_ms: durationMs,
      request_body: requestBody.slice(0, 2000),
      response_body: responseBody.slice(0, 5000),
    });
  }
}

function extractPromptFromParsed(body: Record<string, unknown>): string | null {
  // OpenAI format: messages array
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (Array.isArray(messages)) {
    const userMsgs = messages.filter(m => m.role === 'user');
    const last = userMsgs[userMsgs.length - 1];
    if (last?.content) return last.content;
  }
  if (typeof body.prompt === 'string') return body.prompt;
  if (typeof body.input === 'string') return body.input;
  return null;
}

function extractSseCompletion(raw: string): string | null {
  const parts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const choices = parsed.choices as Array<{ delta?: { content?: string } }> | undefined;
      const delta = choices?.[0]?.delta?.content
        ?? (parsed.delta as Record<string, unknown> | undefined)?.text
        ?? '';
      if (delta) parts.push(String(delta));
    } catch { /* skip malformed SSE */ }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function extractJsonCompletion(body: Record<string, unknown>): string | null {
  const choices = body.choices as Array<{ message?: { content: string }; text?: string }> | undefined;
  if (Array.isArray(choices) && choices[0]) {
    return choices[0].message?.content ?? choices[0].text ?? null;
  }
  return null;
}

// --- HTTP/2 MODULE PATCHING ---
let originalHttp2Connect: typeof http2.connect | null = null;

function patchHttp2(logger: (msg: string) => void): void {
  try {
    const desc = Object.getOwnPropertyDescriptor(http2, 'connect');
    logger(`[diag:h2] http2.connect configurable=${desc?.configurable}, writable=${desc?.writable}`);

    if (desc && !desc.configurable && !desc.writable) {
      logger('[diag:h2] http2.connect is non-configurable and non-writable — cannot patch');
      return;
    }

    originalHttp2Connect = http2.connect;

    const patchedConnect = function (authority: string | URL, optionsOrListener?: unknown, listener?: unknown): ClientHttp2Session {
      const authorityStr = String(authority);
      let hostname = '';
      try { hostname = new URL(authorityStr).hostname; } catch { /* not a URL */ }

      logger(`[diag:h2] http2.connect called: ${authorityStr} (hostname=${hostname})`);

      // Call original with the same arity
      let session: ClientHttp2Session;
      if (listener !== undefined) {
        session = originalHttp2Connect!(authority, optionsOrListener as Parameters<typeof http2.connect>[1], listener as () => void);
      } else if (optionsOrListener !== undefined) {
        session = originalHttp2Connect!(authority, optionsOrListener as Parameters<typeof http2.connect>[1]);
      } else {
        session = originalHttp2Connect!(authority);
      }

      if (hostname && isCopilotDomain(hostname)) {
        logger(`[diag:h2] Copilot HTTP/2 session to ${hostname} — wrapping .request()`);
        wrapHttp2Session(session, hostname, logger);
      }

      return session;
    };

    // Try Object.defineProperty first, fall back to direct assignment
    try {
      Object.defineProperty(http2, 'connect', {
        value: patchedConnect,
        writable: true,
        configurable: true,
      });
      logger('[diag:h2] http2.connect patched via defineProperty: OK');
    } catch {
      try {
        (http2 as Record<string, unknown>).connect = patchedConnect;
        logger('[diag:h2] http2.connect patched via assignment: OK');
      } catch (err2) {
        logger(`[diag:h2] http2.connect patch FAILED: ${err2 instanceof Error ? err2.message : String(err2)}`);
      }
    }
  } catch (err) {
    logger(`[diag:h2] http2 patching error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function wrapHttp2Session(session: ClientHttp2Session, hostname: string, logger: (msg: string) => void): void {
  const origRequest = session.request.bind(session);

  (session as unknown as Record<string, unknown>).request = function (headers?: Record<string, unknown>, options?: unknown): ClientHttp2Stream {
    const hdrs = headers ?? {};
    const method = String(hdrs[':method'] ?? 'GET');
    const path = String(hdrs[':path'] ?? '/');
    logger(`[diag:h2] Copilot H2 request: ${method} ${hostname}${path}`);

    const stream = origRequest(headers as IncomingHttpHeaders & IncomingHttpStatusHeader, options as Record<string, unknown> | undefined);

    // Capture request body
    const requestChunks: Buffer[] = [];
    let requestSize = 0;
    const origWrite = stream.write.bind(stream) as (chunk: unknown, encoding?: string, cb?: () => void) => boolean;
    const origEnd = stream.end.bind(stream) as (chunk?: unknown, encoding?: string, cb?: () => void) => ReturnType<typeof stream.end>;

    (stream as unknown as Record<string, unknown>).write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
      if (requestSize < MAX_REQUEST_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : null;
        if (buf) { requestChunks.push(buf.subarray(0, MAX_REQUEST_BODY - requestSize)); requestSize += buf.length; }
      }
      return origWrite(chunk, encoding as string | undefined, cb as (() => void) | undefined);
    };

    (stream as unknown as Record<string, unknown>).end = function (chunk?: unknown, encoding?: unknown, cb?: unknown): ReturnType<typeof stream.end> {
      if (chunk && requestSize < MAX_REQUEST_BODY) {
        const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : null;
        if (buf) { requestChunks.push(buf.subarray(0, MAX_REQUEST_BODY - requestSize)); requestSize += buf.length; }
      }
      return origEnd(chunk, encoding as string | undefined, cb as (() => void) | undefined);
    };

    // Capture response
    const responseChunks: Buffer[] = [];
    let responseSize = 0;
    let statusCode = 0;
    let contentType = '';
    const startTime = Date.now();

    stream.on('response', (responseHeaders: IncomingHttpHeaders & IncomingHttpStatusHeader) => {
      statusCode = responseHeaders[':status'] ?? 0;
      contentType = String(responseHeaders['content-type'] ?? '');
    });

    stream.on('data', (chunk: Buffer) => {
      if (responseSize < MAX_RESPONSE_BODY) {
        responseChunks.push(chunk.subarray(0, MAX_RESPONSE_BODY - responseSize));
        responseSize += chunk.length;
      }
    });

    stream.on('end', () => {
      try {
        const requestBody = Buffer.concat(requestChunks).toString('utf-8');
        const responseBody = Buffer.concat(responseChunks).toString('utf-8');
        const durationMs = Date.now() - startTime;

        let requestType: 'chat' | 'completion' | 'other' = 'other';
        if (path.includes('/chat/') || path.includes('/threads/') || path.includes('/v1/messages')) {
          requestType = 'chat';
        } else if (path.includes('/completions') || path.includes('/generate')) {
          requestType = 'completion';
        }

        let prompt: string | null = null;
        try { prompt = extractPromptFromParsed(JSON.parse(requestBody) as Record<string, unknown>); } catch { /* not JSON */ }

        let completion: string | null = null;
        if (contentType.includes('text/event-stream')) {
          completion = extractSseCompletion(responseBody);
        } else {
          try { completion = extractJsonCompletion(JSON.parse(responseBody) as Record<string, unknown>); } catch { /* not JSON */ }
        }

        logger(
          `[diag:h2:capture] ${method} ${hostname}${path} type=${requestType} ` +
          `prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} ` +
          `completion=${completion ? 'yes(' + completion.length + ')' : 'no'} status=${statusCode}`,
        );

        diagInterceptCount++;
        if (sendFn) {
          sendFn({
            session_id: `copilot-${new Date().toISOString().slice(0, 10)}`,
            domain: hostname,
            path, method,
            request_type: requestType,
            prompt, completion,
            status_code: statusCode,
            content_type: contentType,
            duration_ms: durationMs,
            request_body: requestBody.slice(0, 2000),
            response_body: responseBody.slice(0, 5000),
            transport: 'http2',
          });
        }
      } catch (err) {
        logger(`[diag:h2] capture error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return stream;
  };
}

/**
 * Probe: make a request through VS Code's LM API and see if it appears
 * in any diagnostics channel. This tells us whether vscode.lm routes
 * through the extension host (patchable) or the main process (not patchable).
 */
export async function probeLmApiTransport(logger: (msg: string) => void): Promise<string> {
  try {
    // Dynamic import to avoid hard dependency on vscode types
    const vscode = await import('vscode');
    if (typeof vscode.lm?.selectChatModels !== 'function') {
      return 'vscode.lm API not available';
    }

    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      return 'No Copilot LM models available';
    }

    logger(`[probe] Found ${models.length} Copilot models: ${models.map(m => m.id).join(', ')}`);
    logger('[probe] Sending test request via vscode.lm API — watch for diagnostics channel activity...');

    // Mark the timestamp so we can correlate
    const probeTimestamp = Date.now();
    logger(`[probe] Probe timestamp: ${probeTimestamp}`);

    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User('Say "probe-ok" and nothing else.')];

    try {
      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let fullResponse = '';
      for await (const chunk of response.text) {
        fullResponse += chunk;
      }

      logger(`[probe] LM API response received (${fullResponse.length} chars): ${fullResponse.slice(0, 100)}`);
      logger(`[probe] Time elapsed: ${Date.now() - probeTimestamp}ms`);
      logger('[probe] Check above logs for [diag:undici], [diag:http], [diag:h2], [diag:net] entries after the probe timestamp.');
      logger('[probe] If NO diagnostic entries appeared → request went through VS Code main process (not patchable from extension host).');

      return `Probe complete. Response: "${fullResponse.slice(0, 50)}". Check output channel for diagnostic activity.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger(`[probe] LM API request failed: ${msg}`);
      return `Probe request failed: ${msg}`;
    }
  } catch (err) {
    return `Probe error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function trySubscribe(channelName: string, handler: (message: unknown) => void): void {
  try {
    diagnostics_channel.subscribe(channelName, handler);
    subscriptions.push({
      channel: channelName,
      unsubscribe: () => {
        try { diagnostics_channel.unsubscribe(channelName, handler); } catch { /* best effort */ }
      },
    });
  } catch (err) {
    logFn(`[diag] Failed to subscribe to ${channelName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopDiagnosticsInterception(): void {
  for (const sub of subscriptions) {
    sub.unsubscribe();
  }
  subscriptions.length = 0;
  sendFn = null;
  active = false;
}

export function getDiagnosticsStats(): { active: boolean; interceptCount: number; channels: string[] } {
  return {
    active,
    interceptCount: diagInterceptCount,
    channels: subscriptions.map(s => s.channel),
  };
}
