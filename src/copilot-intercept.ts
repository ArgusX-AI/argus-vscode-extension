import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as stream from 'stream';
import type { ClientRequest, RequestOptions, IncomingMessage } from 'http';
import { isOtelCaptureActive } from './copilot-otel';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module') as { prototype: { require: (id: string) => unknown } };

/** Copilot API domains to intercept (exact matches). */
const COPILOT_DOMAINS = new Set([
  'api.githubcopilot.com',
  'api.individual.githubcopilot.com',
  'copilot-proxy.githubusercontent.com',
  'copilot.api.github.com',
  'api-model-lab.githubcopilot.com',
]);

/** Check if a hostname belongs to a Copilot API domain. */
export function isCopilotDomain(hostname: string): boolean {
  if (COPILOT_DOMAINS.has(hostname)) return true;
  // Wildcard: any subdomain of githubcopilot.com
  if (hostname.endsWith('.githubcopilot.com')) return true;
  // Wildcard: any copilot-related githubusercontent.com subdomain
  if (hostname.endsWith('.githubusercontent.com') && hostname.includes('copilot')) return true;
  // GitHub uploads for copilot attachments
  if (hostname === 'uploads.github.com') return true;
  return false;
}

/** Max bytes to capture from request/response bodies. */
const MAX_REQUEST_BODY = 50 * 1024;
const MAX_RESPONSE_BODY = 100 * 1024;

// Saved originals for restoration
let originalHttpsRequest: typeof https.request | null = null;
let originalHttpsGet: typeof https.get | null = null;
let originalFetch: typeof globalThis.fetch | null = null;
let originalProtoWrite: typeof http.ClientRequest.prototype.write | null = null;
let originalProtoEnd: typeof http.ClientRequest.prototype.end | null = null;
let originalTlsConnect: typeof tls.connect | null = null;
let originalModuleRequire: ((id: string) => unknown) | null = null;
let originalDuplexWrite: typeof stream.Duplex.prototype.write | null = null;
let originalReadablePush: typeof stream.Readable.prototype.push | null = null;

// Safe request function for posting to Argus (avoids recursion).
// Resolved at startIntercepting time based on server URL protocol.
let safeHttpRequest: (opts: RequestOptions) => ClientRequest = (opts) => http.request(opts);

let intercepting = false;
let serverUrl = '';
let userName = '';
let log: (msg: string) => void = () => {};

// Track requests already captured by module-level patches to avoid double-capture
// in the prototype-level fallback.
const capturedRequests = new WeakSet<ClientRequest>();

// Debug mode: log ALL intercepted hostnames for first 60 seconds
let debugMode = false;
let debugEndTime = 0;

// Diagnostic counters
let totalIntercepted = 0;
let protoFallbackCount = 0;
let tlsProtoInterceptCount = 0;
const domainsSeenSet = new Set<string>();

/**
 * Extract hostname from https.request arguments.
 * Node's https.request accepts (url, options, cb), (url, cb), or (options, cb).
 */
export function extractHostname(args: unknown[]): string | null {
  for (const arg of args) {
    if (typeof arg === 'string') {
      try { return new URL(arg).hostname; } catch { /* ignore */ }
    }
    if (arg && typeof arg === 'object') {
      const opts = arg as Record<string, unknown>;
      if (typeof opts.hostname === 'string') { return opts.hostname; }
      if (typeof opts.host === 'string') { return opts.host.split(':')[0]; }
      if (opts instanceof URL) { return opts.hostname; }
    }
  }
  return null;
}

/** Extract the request path from https.request arguments. */
export function extractPath(args: unknown[]): string {
  for (const arg of args) {
    if (typeof arg === 'string') {
      try { return new URL(arg).pathname; } catch { /* ignore */ }
    }
    if (arg && typeof arg === 'object') {
      const opts = arg as Record<string, unknown>;
      if (typeof opts.path === 'string') { return opts.path; }
      if (opts instanceof URL) { return opts.pathname; }
    }
  }
  return '/';
}

/** Extract the HTTP method from https.request arguments. */
export function extractMethod(args: unknown[]): string {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !(arg instanceof URL)) {
      const opts = arg as Record<string, unknown>;
      if (typeof opts.method === 'string') { return opts.method; }
    }
  }
  return 'GET';
}

/** Fire-and-forget POST to the Argus server. Skips non-OTEL events when OTEL is active. */
function sendToArgus(payload: Record<string, unknown>, fromOtel = false): void {
  // When OTEL is active, suppress non-OTEL events for Copilot domains only.
  // Codex/Gemini traffic is never suppressed.
  const domain = String(payload.domain ?? '');
  if (!fromOtel && isOtelCaptureActive() && isCopilotDomain(domain)) return;
  try {
    const body = JSON.stringify(payload);
    const url = new URL(`${serverUrl}/hooks/CopilotRequest`);
    const req = safeHttpRequest({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Argus-User': userName,
        'X-Argus-Source': 'copilot',
      },
      timeout: 5000,
    } as RequestOptions);
    req.on('response', (res: IncomingMessage) => {
      // Drain the response to free the socket
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        log(`[sendToArgus] Server returned ${res.statusCode}`);
      }
    });
    req.on('error', (err: Error) => {
      log(`[sendToArgus] POST failed: ${err.message}`);
    });
    req.end(body);
    log(`[sendToArgus] Sent ${payload.request_type} event (${payload.method} ${payload.domain}${payload.path})`);
  } catch (err) {
    log(`[sendToArgus] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Extract prompt text from a parsed request body. */
function extractPrompt(parsed: Record<string, unknown>): string | null {
  return (parsed.content as string | undefined)
    ?? (parsed.prompt as string | undefined)
    ?? (parsed.messages as Array<{ content?: string }> | undefined)
      ?.[((parsed.messages as unknown[])?.length ?? 0) - 1]?.content
    ?? null;
}

/** Extract completion text from an SSE response body. */
function extractSseCompletion(responseBody: string): string | null {
  const lines = responseBody.split('\n');
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content
          ?? parsed.choices?.[0]?.text
          ?? null;
        if (delta) parts.push(delta);
      } catch { /* skip unparseable SSE lines */ }
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/** Extract completion text from a JSON response body. */
function extractJsonCompletion(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody);
    return parsed.choices?.[0]?.message?.content
      ?? parsed.choices?.[0]?.text
      ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a ClientRequest to capture the body being written to it.
 * Returns the original request unchanged — the capture is side-effect only.
 */
function captureRequest(
  clientReq: ClientRequest,
  hostname: string,
  path: string,
  method: string,
): void {
  capturedRequests.add(clientReq);
  totalIntercepted++;
  domainsSeenSet.add(hostname);
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const startTime = Date.now();

  const origWrite = clientReq.write;
  (clientReq as unknown as Record<string, unknown>).write = function (this: ClientRequest, ...args: unknown[]) {
    const chunk = args[0];
    if (chunk && totalSize < MAX_REQUEST_BODY) {
      const buf = Buffer.isBuffer(chunk) ? chunk
        : typeof chunk === 'string' ? Buffer.from(chunk)
        : null;
      if (buf) {
        chunks.push(buf.subarray(0, MAX_REQUEST_BODY - totalSize));
        totalSize += buf.length;
      }
    }
    return origWrite.apply(this, args as Parameters<typeof origWrite>);
  };

  const origEnd = clientReq.end;
  (clientReq as unknown as Record<string, unknown>).end = function (this: ClientRequest, ...args: unknown[]) {
    const chunk = args[0];
    if (chunk && totalSize < MAX_REQUEST_BODY) {
      const buf = Buffer.isBuffer(chunk) ? chunk
        : typeof chunk === 'string' ? Buffer.from(chunk)
        : null;
      if (buf) {
        chunks.push(buf.subarray(0, MAX_REQUEST_BODY - totalSize));
        totalSize += buf.length;
      }
    }

    // Listen for the response
    clientReq.once('response', (res: IncomingMessage) => {
      captureResponse(res, hostname, path, method, chunks, startTime);
    });

    return origEnd.apply(this, args as Parameters<typeof origEnd>);
  };
}

/** Capture the response body and send everything to Argus. */
function captureResponse(
  res: IncomingMessage,
  hostname: string,
  path: string,
  method: string,
  requestChunks: Buffer[],
  startTime: number,
): void {
  const responseChunks: Buffer[] = [];
  let responseSize = 0;

  res.on('data', (chunk: Buffer) => {
    if (responseSize < MAX_RESPONSE_BODY) {
      responseChunks.push(chunk.subarray(0, MAX_RESPONSE_BODY - responseSize));
      responseSize += chunk.length;
    }
  });

  res.on('end', () => {
    try {
      const requestBody = Buffer.concat(requestChunks).toString('utf-8');
      const responseBody = Buffer.concat(responseChunks).toString('utf-8');
      const durationMs = Date.now() - startTime;
      const contentType = res.headers['content-type'] ?? '';

      // Determine request type from path
      let requestType: 'chat' | 'completion' | 'other' = 'other';
      if (path.includes('/chat/') || path.includes('/threads/')) {
        requestType = 'chat';
      } else if (path.includes('/completions') || path.includes('/generate')) {
        requestType = 'completion';
      }

      // Extract prompt from request body
      let prompt: string | null = null;
      try {
        const parsed = JSON.parse(requestBody);
        prompt = extractPrompt(parsed as Record<string, unknown>);
      } catch { /* not JSON or no prompt field */ }

      // Extract completion from response body
      let completion: string | null = null;
      if (contentType.includes('text/event-stream')) {
        completion = extractSseCompletion(responseBody);
      } else {
        completion = extractJsonCompletion(responseBody);
      }

      // Send all Copilot requests to Argus — let the server decide what to keep
      log(`[capture] ${method} ${hostname}${path} type=${requestType} prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} completion=${completion ? 'yes(' + completion.length + ')' : 'no'} status=${res.statusCode}`);
      sendToArgus({
        session_id: `copilot-${new Date().toISOString().slice(0, 10)}`,
        domain: hostname,
        path,
        method,
        request_type: requestType,
        prompt,
        completion,
        status_code: res.statusCode,
        content_type: contentType,
        duration_ms: durationMs,
        request_body: requestBody.slice(0, 2000),
        response_body: responseBody.slice(0, 5000),
      });
    } catch (err) {
      log(`[captureResponse] Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  res.on('error', () => { /* swallow */ });
}

/** Convert various body types to a string. */
function bodyToString(body: unknown, maxLen: number): string {
  if (typeof body === 'string') return body.slice(0, maxLen);
  if (Buffer.isBuffer(body)) return body.subarray(0, maxLen).toString('utf-8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).subarray(0, maxLen).toString('utf-8');
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).subarray(0, maxLen).toString('utf-8');
  return '';
}

// Track sockets already processed to avoid double-send
const processedSockets = new WeakSet<tls.TLSSocket>();

/**
 * Wrap a TLS socket connected to a Copilot domain to capture raw HTTP data.
 */
function wrapCopilotSocket(socket: tls.TLSSocket, hostname: string): void {
  const requestChunks: Buffer[] = [];
  let requestSize = 0;
  const responseChunks: Buffer[] = [];
  let responseSize = 0;
  let responseStarted = false;
  const startTime = Date.now();
  let sent = false;

  // Wrap write() to capture outgoing HTTP request data
  const origWrite = socket.write;
  socket.write = function (data: unknown, ...rest: unknown[]) {
    if (!responseStarted && requestSize < MAX_REQUEST_BODY) {
      try {
        const buf = Buffer.isBuffer(data) ? data
          : typeof data === 'string' ? Buffer.from(data)
          : null;
        if (buf) {
          requestChunks.push(buf.subarray(0, MAX_REQUEST_BODY - requestSize));
          requestSize += buf.length;
        }
      } catch { /* don't break socket */ }
    }
    return origWrite.apply(this, [data, ...rest] as Parameters<typeof origWrite>);
  };

  // Capture response data
  const onData = (chunk: Buffer) => {
    responseStarted = true;
    if (responseSize < MAX_RESPONSE_BODY) {
      responseChunks.push(chunk.subarray(0, MAX_RESPONSE_BODY - responseSize));
      responseSize += chunk.length;
    }
  };
  socket.on('data', onData);

  const doSend = () => {
    if (sent) return;
    sent = true;
    socket.removeListener('data', onData);
    try {
      parseAndSendSocketData(hostname, requestChunks, responseChunks, startTime);
    } catch (err) {
      log(`[socket] Parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  socket.on('end', doSend);
  socket.on('close', doSend);
}

// --- Layer 7 state: TLS socket capture via stream prototype patching ---

interface SocketCaptureState {
  hostname: string;
  requestChunks: Buffer[];
  requestSize: number;
  responseChunks: Buffer[];
  responseSize: number;
  responseStarted: boolean;
  startTime: number;
  sent: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const socketCaptureState = new WeakMap<tls.TLSSocket, SocketCaptureState>();

/**
 * Get or create capture state for a TLS socket connected to a Copilot domain.
 * Returns null if the socket is not a Copilot connection or already processed.
 */
function getOrCreateSocketState(socket: tls.TLSSocket): SocketCaptureState | null {
  const existing = socketCaptureState.get(socket);
  if (existing) return existing;

  const hostname = socket.servername
    ?? (socket as unknown as Record<string, unknown>)._host as string | undefined
    ?? null;
  if (!hostname || !isCopilotDomain(hostname)) return null;
  // Skip sockets already handled by tls.connect or require proxy patches
  if (processedSockets.has(socket)) return null;
  processedSockets.add(socket);

  const state: SocketCaptureState = {
    hostname,
    requestChunks: [],
    requestSize: 0,
    responseChunks: [],
    responseSize: 0,
    responseStarted: false,
    startTime: Date.now(),
    sent: false,
    flushTimer: null,
  };
  socketCaptureState.set(socket, state);

  log(`[tls:proto] New Copilot socket: ${hostname}`);
  tlsProtoInterceptCount++;
  totalIntercepted++;
  domainsSeenSet.add(hostname);

  socket.on('end', () => flushSocketCapture(socket));
  socket.on('close', () => flushSocketCapture(socket));

  return state;
}

/**
 * Flush captured socket data to Argus. Called on socket end/close or debounce timer.
 */
function flushSocketCapture(socket: tls.TLSSocket): void {
  const state = socketCaptureState.get(socket);
  if (!state || state.sent) return;
  state.sent = true;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  try {
    parseAndSendSocketData(state.hostname, state.requestChunks, state.responseChunks, state.startTime);
  } catch (err) {
    log(`[tls:proto] Flush error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Parse raw HTTP/1.1 request/response from captured socket data and send to Argus.
 */
function parseAndSendSocketData(
  hostname: string,
  requestChunks: Buffer[],
  responseChunks: Buffer[],
  startTime: number,
): void {
  if (requestChunks.length === 0) return;

  const rawRequest = Buffer.concat(requestChunks).toString('utf-8');
  const rawResponse = Buffer.concat(responseChunks).toString('utf-8');
  const durationMs = Date.now() - startTime;

  // Parse HTTP request line: "POST /chat/completions HTTP/1.1"
  const requestLineMatch = rawRequest.match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(\S+)\s+HTTP/);
  if (!requestLineMatch) {
    log(`[socket] No HTTP request line found in ${rawRequest.slice(0, 80)}`);
    return;
  }

  const method = requestLineMatch[1];
  const path = requestLineMatch[2];

  // Skip telemetry — already handled by prototype patches
  if (path.includes('/telemetry')) return;

  // Extract request body (after double CRLF)
  const bodyStart = rawRequest.indexOf('\r\n\r\n');
  const requestBody = bodyStart >= 0 ? rawRequest.slice(bodyStart + 4) : '';

  // Parse response status
  const statusMatch = rawResponse.match(/HTTP\/[\d.]+\s+(\d+)/);
  const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;

  // Extract content-type from response headers
  const ctMatch = rawResponse.match(/content-type:\s*([^\r\n]+)/i);
  const contentType = ctMatch?.[1]?.trim() ?? '';

  // Extract response body
  const respBodyStart = rawResponse.indexOf('\r\n\r\n');
  const responseBody = respBodyStart >= 0 ? rawResponse.slice(respBodyStart + 4) : '';

  // Determine request type
  let requestType: 'chat' | 'completion' | 'other' = 'other';
  if (path.includes('/chat/') || path.includes('/threads/')) requestType = 'chat';
  else if (path.includes('/completions') || path.includes('/generate')) requestType = 'completion';

  // Extract prompt from request body
  let prompt: string | null = null;
  try {
    const parsed = JSON.parse(requestBody);
    prompt = extractPrompt(parsed as Record<string, unknown>);
  } catch { /* not JSON or chunked encoding garbles it */ }

  // Extract completion from response body
  let completion: string | null = null;
  if (responseBody.includes('data: ')) {
    completion = extractSseCompletion(responseBody);
  } else {
    completion = extractJsonCompletion(responseBody);
  }

  log(`[socket:capture] ${method} ${hostname}${path} type=${requestType} prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} completion=${completion ? 'yes(' + completion.length + ')' : 'no'} status=${statusCode}`);

  totalIntercepted++;
  domainsSeenSet.add(hostname);

  sendToArgus({
    session_id: `copilot-${new Date().toISOString().slice(0, 10)}`,
    domain: hostname,
    path,
    method,
    request_type: requestType,
    prompt,
    completion,
    status_code: statusCode,
    content_type: contentType,
    duration_ms: durationMs,
    request_body: requestBody.slice(0, 2000),
    response_body: responseBody.slice(0, 5000),
  });
}

/**
 * Start intercepting HTTPS requests to Copilot domains.
 * Must be called after the extension host has loaded Copilot.
 */
export function startIntercepting(
  argusServerUrl: string,
  user: string,
  logger?: (msg: string) => void,
  debug?: boolean,
): void {
  if (intercepting) { return; }

  serverUrl = argusServerUrl;
  userName = user;
  log = logger ?? (() => {});
  debugMode = debug ?? false;
  // Always log all hostnames for the first 60 seconds to diagnose Copilot traffic
  debugEndTime = Date.now() + 60_000;

  // --- LAYER 0: Patch Module.prototype.require ---
  // This is the nuclear option. Built-in module properties (https.request, tls.connect)
  // are non-configurable in Node v22+. But we can intercept require() itself and return
  // Proxy objects that wrap the built-in modules. When Copilot's SDK does require('tls'),
  // it gets our Proxy where .connect returns our patched version.
  const builtInProxies = new Map<string, unknown>();
  try {
    originalModuleRequire = Module.prototype.require;
    const savedRequire = originalModuleRequire;

    Module.prototype.require = function patchedRequire(id: string): unknown {
      const originalModule = savedRequire.apply(this, [id] as unknown as [string]);

      if (!intercepting && !['https', 'tls', 'http', 'net'].includes(id)) {
        return originalModule;
      }

      // Only proxy the modules we need to intercept
      if (['https', 'tls', 'http', 'net'].includes(id)) {
        if (!builtInProxies.has(id)) {
          builtInProxies.set(id, new Proxy(originalModule as object, {
            get(target: Record<string, unknown>, prop: string) {
              // Intercept tls.connect — the critical path for Copilot chat
              if (id === 'tls' && prop === 'connect') {
                return function patchedTlsConnect(...args: unknown[]) {
                  const socket = (Reflect.get(target, prop) as Function).apply(target, args) as tls.TLSSocket;
                  try {
                    const opts = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : null;
                    const hostname = (opts?.host as string) ?? (opts?.servername as string) ?? null;
                    if (Date.now() < debugEndTime && hostname) {
                      log(`[debug] tls.connect (via require proxy) → ${hostname}`);
                    }
                    if (hostname && isCopilotDomain(hostname)) {
                      log(`[socket] TLS connection to Copilot domain: ${hostname}`);
                      wrapCopilotSocket(socket, hostname);
                    }
                  } catch { /* don't break TLS */ }
                  return socket;
                };
              }
              return Reflect.get(target, prop);
            },
          }));
        }
        return builtInProxies.get(id);
      }

      return originalModule;
    };
    log('[intercept] Module.prototype.require proxy: OK');
  } catch (err) {
    log(`[intercept] Module.prototype.require proxy: FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  // Resolve safe request function based on server URL protocol.
  // Save the original https.request before patching so we can use it for HTTPS
  // posts to Argus without recursion.
  const savedOriginalHttpsRequest = https.request;
  try {
    const serverProto = new URL(argusServerUrl).protocol;
    if (serverProto === 'https:') {
      safeHttpRequest = (opts: RequestOptions) => (savedOriginalHttpsRequest as Function).call(https, opts) as ClientRequest;
    } else {
      safeHttpRequest = (opts: RequestOptions) => http.request(opts);
    }
  } catch {
    safeHttpRequest = (opts: RequestOptions) => http.request(opts);
  }

  // Helper: safely override a property that may be getter-only
  function safePatch(target: object, prop: string, value: unknown): boolean {
    try {
      // Try direct assignment first (fastest)
      (target as Record<string, unknown>)[prop] = value;
      return true;
    } catch {
      // Property is getter-only — use Object.defineProperty
      try {
        Object.defineProperty(target, prop, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
        return true;
      } catch (err) {
        log(`[intercept] Failed to patch ${prop}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
  }

  // --- Patch https.request ---
  originalHttpsRequest = https.request;
  const savedRequest = originalHttpsRequest;
  const patchedRequest = function patchedRequest(
    ...args: unknown[]
  ): ClientRequest {
    const hostname = extractHostname(args);
    if (Date.now() < debugEndTime && hostname) {
      log(`[debug] https.request → ${hostname}`);
    }
    const req = savedRequest.apply(https, args as Parameters<typeof https.request>) as ClientRequest;
    if (hostname && isCopilotDomain(hostname)) {
      const path = extractPath(args);
      const method = extractMethod(args);
      log(`[intercept] Copilot request: ${method} ${hostname}${path}`);
      captureRequest(req, hostname, path, method);
    }
    return req;
  };
  const requestPatched = safePatch(https, 'request', patchedRequest);
  log(`[intercept] https.request patch: ${requestPatched ? 'OK' : 'FAILED'}`);

  // --- Patch https.get ---
  originalHttpsGet = https.get;
  const savedGet = originalHttpsGet;
  const patchedGet = function patchedGet(
    ...args: unknown[]
  ): ClientRequest {
    const hostname = extractHostname(args);
    if (Date.now() < debugEndTime && hostname) {
      log(`[debug] https.get → ${hostname}`);
    }
    const req = savedGet.apply(https, args as Parameters<typeof https.get>) as ClientRequest;
    if (hostname && isCopilotDomain(hostname)) {
      const path = extractPath(args);
      log(`[intercept] Copilot GET: ${hostname}${path}`);
      captureRequest(req, hostname, path, 'GET');
    }
    return req;
  };
  const getPatched = safePatch(https, 'get', patchedGet);
  log(`[intercept] https.get patch: ${getPatched ? 'OK' : 'FAILED'}`);

  // --- Patch globalThis.fetch (Node 18+) ---
  if (typeof globalThis.fetch === 'function') {
    originalFetch = globalThis.fetch;
    const savedFetch = originalFetch;
    const patchedFetch = async function patchedFetch(
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      let hostname: string | null = null;
      let path = '/';
      let method = init?.method ?? 'GET';

      if (typeof input === 'string') {
        try {
          const u = new URL(input);
          hostname = u.hostname;
          path = u.pathname;
        } catch { /* not a URL */ }
      } else if (input instanceof URL) {
        hostname = input.hostname;
        path = input.pathname;
      } else if (input instanceof Request) {
        try {
          const u = new URL(input.url);
          hostname = u.hostname;
          path = u.pathname;
          method = input.method;
        } catch { /* ignore */ }
      }

      if (debugMode && Date.now() < debugEndTime && hostname) {
        log(`[debug] fetch → ${hostname}${path}`);
      }

      if (!hostname || !isCopilotDomain(hostname)) {
        return savedFetch(input, init);
      }

      log(`[intercept] Copilot fetch: ${method} ${hostname}${path}`);

      // Capture the request body
      const startTime = Date.now();
      let requestBody = '';
      if (init?.body) {
        requestBody = bodyToString(init.body, MAX_REQUEST_BODY);
      } else if (input instanceof Request && input.body) {
        // Try to read Request body — clone to avoid consuming
        try {
          const clonedReq = input.clone();
          requestBody = (await clonedReq.text()).slice(0, MAX_REQUEST_BODY);
        } catch { /* can't read body */ }
      }

      // Execute the real fetch
      const response = await savedFetch(input, init);

      // Clone the response to read the body without consuming it
      try {
        const cloned = response.clone();
        const responseBody = (await cloned.text()).slice(0, MAX_RESPONSE_BODY);
        const durationMs = Date.now() - startTime;
        const contentType = response.headers.get('content-type') ?? '';

        // Determine request type
        let requestType: 'chat' | 'completion' | 'other' = 'other';
        if (path.includes('/chat/') || path.includes('/threads/')) {
          requestType = 'chat';
        } else if (path.includes('/completions') || path.includes('/generate')) {
          requestType = 'completion';
        }

        // Extract prompt
        let prompt: string | null = null;
        try {
          const parsed = JSON.parse(requestBody);
          prompt = extractPrompt(parsed as Record<string, unknown>);
        } catch { /* not JSON */ }

        // Extract completion (with SSE support)
        let completion: string | null = null;
        if (contentType.includes('text/event-stream')) {
          completion = extractSseCompletion(responseBody);
        } else {
          completion = extractJsonCompletion(responseBody);
        }

        log(`[capture:fetch] ${method} ${hostname}${path} type=${requestType} prompt=${prompt ? 'yes(' + prompt.length + ')' : 'no'} completion=${completion ? 'yes(' + completion.length + ')' : 'no'} status=${response.status}`);
        sendToArgus({
          session_id: `copilot-${new Date().toISOString().slice(0, 10)}`,
          domain: hostname,
          path,
          method,
          request_type: requestType,
          prompt,
          completion,
          status_code: response.status,
          content_type: contentType,
          duration_ms: durationMs,
          request_body: requestBody.slice(0, 2000),
          response_body: responseBody.slice(0, 5000),
        });
      } catch (err) {
        log(`[intercept] Fetch capture error: ${err instanceof Error ? err.message : String(err)}`);
      }

      return response;
    };
    const fetchPatched = safePatch(globalThis, 'fetch', patchedFetch);
    log(`[intercept] globalThis.fetch patch: ${fetchPatched ? 'OK' : 'FAILED'}`);
  }

  // --- Fallback: Patch ClientRequest.prototype for requests that bypass module-level patches ---
  originalProtoWrite = http.ClientRequest.prototype.write;
  originalProtoEnd = http.ClientRequest.prototype.end;

  const protoSavedWrite = originalProtoWrite;
  const protoSavedEnd = originalProtoEnd;

  const patchedProtoWrite = function (
    this: ClientRequest,
    ...args: unknown[]
  ) {
    if (!capturedRequests.has(this)) {
      try {
        const host = this.getHeader('host') as string | undefined;
        const hostname = host?.split(':')[0] ?? null;
        if (hostname && isCopilotDomain(hostname)) {
          const reqPath = (this as unknown as Record<string, unknown>).path as string ?? '/';
          const reqMethod = (this as unknown as Record<string, unknown>).method as string ?? 'GET';
          protoFallbackCount++;
          log(`[intercept:proto] Copilot request via prototype (fallback #${protoFallbackCount}): ${reqMethod} ${hostname}${reqPath}`);
          captureRequest(this, hostname, reqPath, reqMethod);
        }
      } catch { /* don't break anything */ }
    }
    return protoSavedWrite.apply(this, args as Parameters<typeof protoSavedWrite>);
  };

  const patchedProtoEnd = function (
    this: ClientRequest,
    ...args: unknown[]
  ) {
    if (!capturedRequests.has(this)) {
      try {
        const host = this.getHeader('host') as string | undefined;
        const hostname = host?.split(':')[0] ?? null;
        if (hostname && isCopilotDomain(hostname)) {
          const reqPath = (this as unknown as Record<string, unknown>).path as string ?? '/';
          const reqMethod = (this as unknown as Record<string, unknown>).method as string ?? 'GET';
          protoFallbackCount++;
          log(`[intercept:proto] Copilot request via prototype (fallback #${protoFallbackCount}): ${reqMethod} ${hostname}${reqPath}`);
          captureRequest(this, hostname, reqPath, reqMethod);
        }
      } catch { /* don't break anything */ }
    }
    return protoSavedEnd.apply(this, args as Parameters<typeof protoSavedEnd>);
  };

  const writePatched = safePatch(http.ClientRequest.prototype, 'write', patchedProtoWrite);
  const endPatched = safePatch(http.ClientRequest.prototype, 'end', patchedProtoEnd);
  log(`[intercept] ClientRequest.prototype.write patch: ${writePatched ? 'OK' : 'FAILED'}`);
  log(`[intercept] ClientRequest.prototype.end patch: ${endPatched ? 'OK' : 'FAILED'}`);

  // --- LAYER 6: Patch tls.connect() to catch raw socket communication ---
  // The @github/copilot SDK bypasses fetch/https.request entirely and writes
  // raw HTTP/1.1 protocol bytes directly to TLS sockets. This is the only
  // way to intercept chat completion requests.
  originalTlsConnect = tls.connect;
  const savedTlsConnect = originalTlsConnect;
  const patchedTlsConnect = function (...args: unknown[]) {
    const socket = (savedTlsConnect as Function).apply(tls, args) as tls.TLSSocket;
    try {
      const opts = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : null;
      const hostname = (opts?.host as string) ?? (opts?.servername as string) ?? null;
      if (Date.now() < debugEndTime && hostname) {
        log(`[debug] tls.connect → ${hostname}`);
      }
      if (hostname && isCopilotDomain(hostname)) {
        log(`[socket] TLS connection to Copilot domain: ${hostname}`);
        wrapCopilotSocket(socket, hostname);
      }
    } catch { /* don't break TLS connections */ }
    return socket;
  };
  const tlsPatched = safePatch(tls, 'connect', patchedTlsConnect);
  log(`[intercept] tls.connect patch: ${tlsPatched ? 'OK' : 'FAILED'}`);

  // --- LAYER 7: Patch stream.Duplex.prototype.write + stream.Readable.prototype.push ---
  // The Copilot SDK writes raw HTTP/1.1 bytes to TLS sockets. The write() method
  // lives on Duplex.prototype (not TLSSocket.prototype). Unlike module exports,
  // prototype methods ARE configurable. Guard: `instanceof tls.TLSSocket` (~8ns).
  try {
    originalDuplexWrite = stream.Duplex.prototype.write;
    const savedDuplexWrite = originalDuplexWrite;

    stream.Duplex.prototype.write = function patchedDuplexWrite(
      this: stream.Duplex,
      chunk: unknown,
      encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
      cb?: (error: Error | null | undefined) => void,
    ): boolean {
      try {
        if (this instanceof tls.TLSSocket && (this as tls.TLSSocket).encrypted) {
          const socket = this as tls.TLSSocket;
          const hostname = socket.servername ?? '';

          // Debug logging for first 60 seconds — show ALL TLS destinations
          if (Date.now() < debugEndTime && hostname) {
            log(`[debug:tls-write] ${hostname}`);
          }

          const state = getOrCreateSocketState(socket);
          if (state && !state.sent && state.requestSize < MAX_REQUEST_BODY) {
            const buf = Buffer.isBuffer(chunk) ? chunk
              : typeof chunk === 'string' ? Buffer.from(chunk) : null;
            if (buf) {
              state.requestChunks.push(buf.subarray(0, MAX_REQUEST_BODY - state.requestSize));
              state.requestSize += buf.length;
            }
          }
        }
      } catch { /* NEVER break stream writes */ }
      return savedDuplexWrite.call(this, chunk, encoding as BufferEncoding, cb);
    } as typeof stream.Duplex.prototype.write;

    log('[intercept] stream.Duplex.prototype.write patch: OK');
  } catch (err) {
    log(`[intercept] stream.Duplex.prototype.write patch: FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  try {
    originalReadablePush = stream.Readable.prototype.push;
    const savedReadablePush = originalReadablePush;

    stream.Readable.prototype.push = function patchedReadablePush(
      this: stream.Readable,
      chunk: unknown,
      encoding?: BufferEncoding,
    ): boolean {
      try {
        if (this instanceof tls.TLSSocket && (this as tls.TLSSocket).encrypted) {
          const socket = this as tls.TLSSocket;
          const state = socketCaptureState.get(socket);
          if (state && !state.sent && chunk) {
            state.responseStarted = true;
            if (state.responseSize < MAX_RESPONSE_BODY) {
              const buf = Buffer.isBuffer(chunk) ? chunk
                : typeof chunk === 'string' ? Buffer.from(chunk) : null;
              if (buf) {
                state.responseChunks.push(buf.subarray(0, MAX_RESPONSE_BODY - state.responseSize));
                state.responseSize += buf.length;
              }
            }
            // Debounced flush for streaming SSE responses
            if (state.flushTimer) clearTimeout(state.flushTimer);
            state.flushTimer = setTimeout(() => flushSocketCapture(socket), 5000);
          }
        }
      } catch { /* NEVER break stream pushes */ }
      return savedReadablePush.call(this, chunk, encoding);
    } as typeof stream.Readable.prototype.push;

    log('[intercept] stream.Readable.prototype.push patch: OK');
  } catch (err) {
    log(`[intercept] stream.Readable.prototype.push patch: FAILED (${err instanceof Error ? err.message : String(err)})`);
  }

  intercepting = true;

  // Enhanced startup diagnostics
  log(`[intercept] === Interception Started ===`);
  log(`[intercept] Server: ${argusServerUrl}`);
  log(`[intercept] User: ${user}`);
  log(`[intercept] Debug mode: ${debugMode}`);
  log(`[intercept] globalThis.fetch patched: ${originalFetch !== null}`);
  log(`[intercept] https.request patched: ${originalHttpsRequest !== null}`);
  log(`[intercept] https.get patched: ${originalHttpsGet !== null}`);
  log(`[intercept] ClientRequest.prototype.write patched: ${originalProtoWrite !== null}`);
  log(`[intercept] ClientRequest.prototype.end patched: ${originalProtoEnd !== null}`);
  log(`[intercept] tls.connect patched: ${originalTlsConnect !== null}`);
  log(`[intercept] Module.prototype.require proxy: ${originalModuleRequire !== null}`);
  log(`[intercept] stream.Duplex.prototype.write patched: ${originalDuplexWrite !== null}`);
  log(`[intercept] stream.Readable.prototype.push patched: ${originalReadablePush !== null}`);
  log(`[intercept] Domains: ${[...COPILOT_DOMAINS].join(', ')} + wildcards`);

  // Always log all HTTPS hostnames for the first 60 seconds to help diagnose
  // what Copilot actually calls (regardless of debug setting)
  const startupLogEnd = Date.now() + 60_000;
  const startupInterval = setInterval(() => {
    if (Date.now() > startupLogEnd) {
      clearInterval(startupInterval);
      log(`[intercept] Startup hostname logging ended. Total intercepted: ${totalIntercepted}`);
    }
  }, 60_000);

  console.log('[Argus] Copilot request interception started');
}

/** Get diagnostic stats about interception. */
export function getInterceptStats(): {
  active: boolean;
  totalIntercepted: number;
  protoFallbackCount: number;
  tlsProtoInterceptCount: number;
  domainsSeen: string[];
  serverUrl: string;
} {
  return {
    active: intercepting,
    totalIntercepted,
    protoFallbackCount,
    tlsProtoInterceptCount,
    domainsSeen: [...domainsSeenSet],
    serverUrl,
  };
}

/** Send a synthetic test event to the Argus server. Returns true on success. */
export function sendTestEvent(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!intercepting || !serverUrl) {
      resolve(false);
      return;
    }
    try {
      const body = JSON.stringify({
        session_id: `copilot-test-${new Date().toISOString().slice(0, 10)}`,
        domain: 'test.githubcopilot.com',
        path: '/test/capture-verification',
        method: 'POST',
        request_type: 'chat',
        prompt: '[Argus test] Copilot capture verification ping',
        completion: null,
        status_code: 200,
        content_type: 'application/json',
        duration_ms: 0,
        request_body: '{"test": true}',
        response_body: '{}',
      });
      const url = new URL(`${serverUrl}/hooks/CopilotRequest`);
      const req = safeHttpRequest({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Argus-User': userName,
          'X-Argus-Source': 'copilot',
        },
        timeout: 5000,
      } as RequestOptions);
      req.on('response', (res: IncomingMessage) => {
        res.resume();
        log(`[test] Server responded with ${res.statusCode}`);
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      });
      req.on('error', (err: Error) => {
        log(`[test] Failed: ${err.message}`);
        resolve(false);
      });
      req.end(body);
    } catch (err) {
      log(`[test] Error: ${err instanceof Error ? err.message : String(err)}`);
      resolve(false);
    }
  });
}

/**
 * Stop intercepting and restore original functions.
 */
export function stopIntercepting(): void {
  if (!intercepting) { return; }

  const restore = (target: object, prop: string, original: unknown) => {
    try {
      (target as Record<string, unknown>)[prop] = original;
    } catch {
      try {
        Object.defineProperty(target, prop, { value: original, writable: true, configurable: true });
      } catch { /* best effort */ }
    }
  };

  if (originalHttpsRequest) {
    restore(https, 'request', originalHttpsRequest);
    originalHttpsRequest = null;
  }
  if (originalHttpsGet) {
    restore(https, 'get', originalHttpsGet);
    originalHttpsGet = null;
  }
  if (originalFetch) {
    restore(globalThis, 'fetch', originalFetch);
    originalFetch = null;
  }
  if (originalProtoWrite) {
    http.ClientRequest.prototype.write = originalProtoWrite;
    originalProtoWrite = null;
  }
  if (originalProtoEnd) {
    http.ClientRequest.prototype.end = originalProtoEnd;
    originalProtoEnd = null;
  }
  if (originalTlsConnect) {
    restore(tls, 'connect', originalTlsConnect);
    originalTlsConnect = null;
  }
  if (originalModuleRequire) {
    Module.prototype.require = originalModuleRequire;
    originalModuleRequire = null;
  }
  if (originalDuplexWrite) {
    stream.Duplex.prototype.write = originalDuplexWrite;
    originalDuplexWrite = null;
  }
  if (originalReadablePush) {
    stream.Readable.prototype.push = originalReadablePush;
    originalReadablePush = null;
  }

  intercepting = false;
  log('[intercept] Copilot request interception stopped');
  console.log('[Argus] Copilot request interception stopped');
}

/** Public wrapper for sendToArgus — used by copilot-diagnostics.ts */
export function sendToArgusExport(payload: Record<string, unknown>): void {
  sendToArgus(payload);
}

/** Unguarded sender for OTEL layer — bypasses the isOtelCaptureActive() suppression. */
export function sendToArgusFromOtel(payload: Record<string, unknown>): void {
  sendToArgus(payload, true);
}
