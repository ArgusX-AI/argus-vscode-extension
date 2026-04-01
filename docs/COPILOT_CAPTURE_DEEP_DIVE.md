# Copilot Chat Prompt Capture — Deep Dive

## The Challenge

GitHub Copilot Chat runs inside VS Code but its actual API calls (the chat completions with your prompts and responses) are **invisible to other extensions**. Unlike Claude Code or Gemini CLI which route through configurable proxies, Copilot Chat sends requests through VS Code's **main Electron process**, completely bypassing the extension host where our code runs.

This document explains every approach we tried, why most failed, and what finally worked.

---

## Architecture: Why Copilot Is Hard to Intercept

```
┌─────────────────────────────────────────────────────┐
│                    VS Code                           │
│                                                      │
│  ┌──────────────────┐    ┌────────────────────────┐ │
│  │  Extension Host   │    │    Main Process         │ │
│  │  (Node.js)        │    │    (Electron)           │ │
│  │                    │    │                         │ │
│  │  - Argus ext      │    │  - Copilot Chat API ──────── GitHub API
│  │  - Copilot Chat   │    │    calls go HERE        │ │
│  │    (UI + logic)   │    │                         │ │
│  │                    │    │  - vscode.lm API        │ │
│  │  Can patch:       │    │    routes through HERE   │ │
│  │  ✅ http/https    │    │                         │ │
│  │  ✅ fetch         │    │  Cannot patch:          │ │
│  │  ✅ tls           │    │  ❌ Isolated process    │ │
│  │  ✅ diagnostics   │    │  ❌ No extension access │ │
│  └──────────────────┘    └────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Key insight**: All extensions share one Extension Host process. Copilot Chat's UI and logic run there. But when it actually sends a chat completion request to `api.individual.githubcopilot.com`, that HTTP call happens in the **Main Process** — a separate Electron process that extensions cannot access or patch.

---

## What We Tried (and Why Each Failed)

### Layer 1: Classic Monkey-Patching (v0.10–v0.14)

**Approach**: Patch `https.request`, `https.get`, `globalThis.fetch`, `tls.connect` at the module level.

```typescript
// Example: patch globalThis.fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (isCopilotDomain(url)) captureRequest(url, options);
  return originalFetch(url, options);
};
```

**Result**:
- `https.request` / `https.get` / `tls.connect` → **FAILED** — Node v22 marks these as `configurable: false`, `writable: false`. Cannot redefine.
- `globalThis.fetch` → **PARTIAL** — Patched successfully, but only catches `/models` GET requests. Copilot cached the original `fetch` reference before our extension activated.
- `ClientRequest.prototype.write/end` → **PARTIAL** — Catches telemetry POSTs to `copilot-telemetry.githubusercontent.com` but not chat completions.
- `Module.prototype.require` proxy → **OK** for new imports, but Copilot already cached `require('tls')` before activation.

**What we learned**: Copilot's actual chat requests don't go through any of these APIs in the extension host. The telemetry and model listing do, but the real prompts don't.

### Layer 2: `diagnostics_channel` (v0.16)

**Approach**: Use Node.js's official `diagnostics_channel` API — the same approach OpenTelemetry uses internally. Subscribe to undici lifecycle channels that fire for ALL HTTP requests regardless of how they were initiated.

```typescript
import diagnostics_channel from 'node:diagnostics_channel';

diagnostics_channel.subscribe('undici:request:create', (message) => {
  // Fires for every undici/fetch request
  const { request } = message;
  if (isCopilotDomain(request.origin)) {
    // Capture it!
  }
});
```

**Channels subscribed**:
- `undici:request:create` — sees ALL undici/fetch requests
- `undici:request:bodyChunkSent` — captures request body (prompts)
- `undici:request:headers` — captures response status/headers
- `undici:request:bodyChunkReceived` — captures response body
- `undici:request:trailers` — triggers flush
- `http.client.request.start` — Node HTTP client requests
- `http.client.response.finish` — HTTP responses

**Result**: **Successfully sees telemetry and /models requests** but NOT chat completions. This confirmed the chat requests go through the main process, not the extension host's Node.js runtime.

### Layer 3: HTTP/2 Patching (v0.17)

**Approach**: Maybe Copilot uses `http2.connect()` directly for streaming. Patch it.

```typescript
import http2 from 'node:http2';
const originalConnect = http2.connect;
http2.connect = function(authority, ...rest) {
  const session = originalConnect(authority, ...rest);
  if (isCopilotDomain(authority)) {
    wrapHttp2Session(session);
  }
  return session;
};
```

**Result**: **Patch applied successfully** (`http2.connect` is configurable), but Copilot Chat never calls it from the extension host. Confirmed: chat traffic doesn't touch the extension host's network stack at all.

### Layer 4: LM API Transport Probe (v0.17)

**Approach**: Definitive test — call `vscode.lm.sendRequest()` ourselves and watch if ANY diagnostic channel fires.

```typescript
const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
const model = models[0]; // e.g., "claude-haiku-4.5"

// Mark timestamp
const probeStart = Date.now();

// Send a test request through the LM API
const response = await model.sendRequest(
  [LanguageModelChatMessage.User('Say "probe-ok"')],
  {}, new CancellationTokenSource().token
);

// Read the response
for await (const chunk of response.text) { /* ... */ }

// Check: did ANY diagnostic channel fire between probeStart and now?
// Answer: NO. Zero network activity in the extension host.
```

**Result**: `vscode.lm.sendRequest()` works perfectly (got "probe-ok" response), but **ZERO diagnostic channel activity**. This is the definitive proof: the VS Code LM API routes requests through the **main Electron process**, completely outside the extension host's network stack.

### Layer 5: LM API Prototype Patching (v0.18)

**Approach**: Since `vscode.lm.selectChatModels()` returns model objects, maybe we can patch `sendRequest` on their prototype to intercept ALL calls — including Copilot Chat's internal calls.

```typescript
const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
const model = models[0];
const proto = Object.getPrototypeOf(model);

// Try to patch sendRequest on the prototype
Object.defineProperty(proto, 'sendRequest', {
  value: patchedSendRequest,
  writable: true,
  configurable: true,
});
```

**Result**: **FAILED** — VS Code returns **frozen plain objects**, not prototype-sharing instances:
```
Model own keys: id, vendor, family, version, name, capabilities, maxInputTokens, countTokens, sendRequest
sendRequest: configurable=false, writable=false
No meaningful prototype (plain object)
```
Every property including `sendRequest` is non-configurable and non-writable. VS Code locks these objects down completely.

### Layer 6: Built-in OpenTelemetry (v0.19) — THE SOLUTION

**Discovery**: While searching Copilot Chat's `package.json`, we found hidden settings:

```json
{
  "github.copilot.chat.otel.enabled": { "type": "boolean", "default": false },
  "github.copilot.chat.otel.captureContent": { "type": "boolean", "default": false },
  "github.copilot.chat.otel.exporterType": { "enum": ["otlp-grpc", "otlp-http", "console", "file"] },
  "github.copilot.chat.otel.otlpEndpoint": { "default": "http://localhost:4318" },
  "github.copilot.chat.otel.outfile": { "type": "string" }
}
```

Copilot Chat has **built-in OpenTelemetry** with content capture! By reversing the minified source, we found the exact attribute keys:

```javascript
// From Copilot Chat's extension.js (deobfuscated):
INPUT_MESSAGES: "gen_ai.input.messages",
OUTPUT_MESSAGES: "gen_ai.output.messages",
SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
TOOL_DEFINITIONS: "gen_ai.tool.definitions"
```

**Implementation**:

1. **Set environment variables** before Copilot activates (our extension uses `*` activation):
```typescript
process.env.COPILOT_OTEL_ENABLED = 'true';
process.env.COPILOT_OTEL_CAPTURE_CONTENT = 'true';
```

2. **Configure VS Code settings** for file-based export:
```typescript
const config = vscode.workspace.getConfiguration('github.copilot.chat');
await config.update('otel.enabled', true, ConfigurationTarget.Global);
await config.update('otel.captureContent', true, ConfigurationTarget.Global);
await config.update('otel.exporterType', 'file', ConfigurationTarget.Global);
await config.update('otel.outfile', otelFilePath, ConfigurationTarget.Global);
```

3. **Watch the OTEL file** for new traces and forward to Argus:
```typescript
fs.watch(otelFilePath, (eventType) => {
  if (eventType === 'change') {
    // Read new JSONL lines from the file
    // Parse OTEL spans
    // Extract model, tokens, content
    // POST to Argus server
  }
});
```

**Result**: **IT WORKS.** Every Copilot Chat inference appears as an OTEL span with:
- `gen_ai.request.model` — the model used (e.g., `claude-haiku-4.5`)
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` — token counts
- `gen_ai.response.finish_reasons` — completion status
- Session tracking, tool calls, agent turns

---

## Current Architecture (v0.19)

```
┌──────────────────────────────────────────────────────────────┐
│                         VS Code                               │
│                                                                │
│  ┌─────────────────────────┐  ┌────────────────────────────┐ │
│  │  Argus Extension         │  │  Copilot Chat Extension     │ │
│  │                           │  │                              │ │
│  │  1. Sets env vars:       │  │  Reads COPILOT_OTEL_ENABLED │ │
│  │     COPILOT_OTEL_ENABLED │  │  Writes OTEL spans to file  │ │
│  │                           │  │                              │ │
│  │  2. Configures settings: │  │  Includes:                   │ │
│  │     otel.enabled=true    │  │  - Model name                │ │
│  │     otel.captureContent  │  │  - Token counts              │ │
│  │     otel.exporterType=   │  │  - Session/trace IDs         │ │
│  │       file               │  │  - (Content when enabled)    │ │
│  │     otel.outfile=...     │  │                              │ │
│  │                           │  └──────────────┬───────────────┘ │
│  │  3. Watches OTEL file ◄──────────────────────┘               │
│  │     for new spans         │                                   │
│  │                           │                                   │
│  │  4. Parses & forwards ──────────► Argus Server (AWS)         │
│  │     to /hooks/CopilotReq │          │                        │
│  └─────────────────────────┘          │                        │
│                                        ▼                        │
│                                   SQLite DB                     │
│                                   Sessions + Hook Events        │
│                                   Timeline + Dashboard          │
└──────────────────────────────────────────────────────────────┘
```

## Data Flow

1. User types in Copilot Chat
2. Copilot sends request to GitHub API (via main process — we can't see this)
3. Copilot's OTEL instrumentation writes a span to the JSONL file
4. Argus watches the file, reads the new span
5. Argus extracts: model, tokens, session_id, content (if enabled)
6. Argus POSTs to the server at `/hooks/CopilotRequest`
7. Server stores in `hook_events` table, updates session, broadcasts via WebSocket
8. Dashboard renders the session with timeline, tokens, and cost

## What We Capture

| Field | Source | Status |
|-------|--------|--------|
| Model name | `gen_ai.request.model` | Working |
| Input tokens | `gen_ai.usage.input_tokens` | Working |
| Output tokens | `gen_ai.usage.output_tokens` | Working |
| Session ID | Generated per day | Working |
| Trace/span IDs | OTEL trace context | Working |
| User prompts | `gen_ai.input.messages` | Pending (needs content capture activation) |
| AI responses | `gen_ai.output.messages` | Pending (needs content capture activation) |
| System prompt | `gen_ai.system_instructions` | Pending |
| Tool definitions | `gen_ai.tool.definitions` | Pending |
| Cost estimate | Calculated from model + tokens | Working |

## Content Capture Status

The OTEL file currently includes model/token data but NOT the actual prompt/response text. The `captureContent` setting is enabled and the env var is set, but Copilot's file exporter may not include content attributes in all export modes. Next steps to get full content:
- Try OTLP HTTP exporter pointing to a local Argus endpoint
- Investigate if content appears in newer Copilot Chat versions
- Consider running a local OTLP collector that the file exporter feeds into

## Files

| File | Purpose |
|------|---------|
| `extensions/vscode/src/copilot-otel.ts` | OTEL settings configuration + file watcher + span parser |
| `extensions/vscode/src/copilot-diagnostics.ts` | diagnostics_channel subscriptions (catches telemetry) |
| `extensions/vscode/src/copilot-intercept.ts` | Network monkey-patching layer (catches telemetry, /models) |
| `extensions/vscode/src/copilot-lm-intercept.ts` | LM API prototype patch attempt (blocked by frozen objects) |
| `extensions/vscode/src/copilot-lm-monitor.ts` | Polls vscode.lm API for model availability |
| `extensions/vscode/src/copilot-detect.ts` | Detects installed Copilot extensions |
| `extensions/vscode/src/copilot-setup.ts` | Orchestrates all capture layers |
| `extensions/vscode/src/extension.ts` | Entry point, sets env vars, registers commands |
| `server/src/hooks.ts` | Server-side handler for CopilotRequest events |
| `server/src/timeline.ts` | Timeline builder — converts events to UI turns |
