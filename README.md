# Argus AI Observability — VS Code Extension

> Monitor, track, and analyze **every AI agent interaction** inside VS Code. One extension for Claude Code, GitHub Copilot, Gemini CLI, Cursor, and more.

[![Version](https://img.shields.io/badge/version-0.20.0-blue.svg)](https://github.com/ArgusX-AI/argus-vscode-extension)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC.svg)](https://code.visualstudio.com/)

---

## What Is This?

Argus is an **AI agent observability layer**. This VS Code extension acts as a transparent bridge between your AI coding assistants and the Argus dashboard — capturing every prompt, response, token count, and cost without changing how you work.

**No proxy. No certificates. No UX changes.** You use Claude, Copilot, and Gemini exactly as before. Argus quietly records everything and sends it to your self-hosted dashboard.

---

## Supported AI Providers

| Provider | Method | What's Captured | Status |
|----------|--------|----------------|--------|
| **Claude Code** | HTTP hooks (`~/.claude/settings.json`) | Prompts, responses, tool calls, costs, sessions | Full |
| **GitHub Copilot Chat** | Built-in OpenTelemetry + 6-layer interception | Model, tokens, session tracking, premium request costs | Full metadata |
| **Gemini CLI** | Hook bridge scripts (bash/PowerShell) | Prompts, responses, model calls, tool usage | Full |
| **Gemini Code Assist** | Extension detection + proxy | Detected, proxy-ready | Detection |
| **Cursor** | Via Anthropic/OpenAI proxy | Prompts, responses, costs | Via proxy |
| **OpenAI** | Via proxy | Prompts, responses, costs | Via proxy |

---

## Installation

### From VSIX (Recommended)

```bash
# 1. Clone this repo
git clone https://github.com/ArgusX-AI/argus-vscode-extension.git
cd argus-vscode-extension

# 2. Install dependencies and compile
npm install
npm run compile

# 3. Package the extension
npx vsce package --allow-star-activation

# 4. Install in VS Code
code --install-extension argus-ai-observability-0.20.0.vsix
```

### From Source (Development)

```bash
git clone https://github.com/ArgusX-AI/argus-vscode-extension.git
cd argus-vscode-extension
npm install
npm run watch  # Auto-recompile on changes
# Press F5 in VS Code to launch Extension Development Host
```

### Requirements

- VS Code 1.85.0 or later
- An Argus server running (see [Argus-v2](https://github.com/ArgusX-AI/Argus-v2) for the server)
- Node.js 20+ (for building from source)

---

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for "Argus":

| Setting | Default | Description |
|---------|---------|-------------|
| `argus.serverUrl` | `http://localhost:4080` | URL of your Argus server |
| `argus.autoConnect` | `true` | Auto-connect to Argus on VS Code startup |
| `argus.showStatusBar` | `true` | Show connection status in the status bar |
| `argus.enableCopilot` | `true` | Capture GitHub Copilot prompts and completions |
| `argus.copilotDebugMode` | `false` | Log all intercepted HTTPS hostnames for 60s (diagnostic) |
| `argus.enableGeminiCli` | `true` | Auto-configure Gemini CLI hooks on connect |
| `argus.enableGeminiCodeAssist` | `true` | Enable Gemini Code Assist proxy observability |

---

## Commands

Press `Ctrl+Shift+P` and type "Argus":

| Command | Description |
|---------|-------------|
| **Argus: Connect to Server** | Connect to the Argus server and configure all AI hooks |
| **Argus: Disconnect** | Disconnect and stop all capture |
| **Argus: Open Dashboard** | Open the Argus web dashboard in your browser |
| **Argus: Show Status** | Show connection status, session count, request count |
| **Argus: Show Copilot Debug Log** | Open the Argus output channel with detailed diagnostic logs |
| **Argus: Test Copilot Capture** | Send a test event to verify the capture pipeline |
| **Argus: Show Copilot Capture Status** | Show detailed stats: interception layers, domains seen, OTEL status |
| **Argus: Probe LM Transport** | Diagnostic: test if `vscode.lm` API routes through extension host |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           VS Code                                    │
│                                                                       │
│  ┌─────────────────────────────────┐  ┌───────────────────────────┐ │
│  │      Argus Extension             │  │   AI Extensions            │ │
│  │                                   │  │                             │ │
│  │  Claude Setup ──────────────────────→ Claude Code                │ │
│  │    → ~/.claude/settings.json     │  │   (HTTP hooks)              │ │
│  │                                   │  │                             │ │
│  │  Gemini Setup ──────────────────────→ Gemini CLI                 │ │
│  │    → ~/.gemini/settings.json     │  │   (hook bridge scripts)    │ │
│  │    → ~/.argus/bin/bridge.sh      │  │                             │ │
│  │                                   │  │                             │ │
│  │  Copilot OTEL ◄────────────────────── Copilot Chat              │ │
│  │    → Watches OTEL JSONL file     │  │   (built-in OpenTelemetry) │ │
│  │    → 6-layer network intercept   │  │                             │ │
│  │                                   │  │                             │ │
│  │  License Fetcher ───────────────────→ api.github.com             │ │
│  │    → /copilot_internal/user      │  │   (plan, quota, orgs)      │ │
│  │                                   │  │                             │ │
│  │  ─────── All data ──────────────────→ Argus Server               │ │
│  │          POST /hooks/*           │  │   (SQLite + Dashboard)      │ │
│  └─────────────────────────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: GitHub Copilot Chat Interception

Capturing Copilot Chat was the hardest engineering challenge. Unlike Claude Code (which has a hooks API) and Gemini CLI (which has configurable hooks), Copilot Chat sends its API calls through **VS Code's main Electron process** — completely invisible to extensions.

We tried **6 different approaches** before finding one that works:

### Approach 1: Monkey-Patching (Failed)

Patch `https.request`, `globalThis.fetch`, `tls.connect` at the module level.

**Result**: Node v22 marks these as `configurable: false, writable: false`. Cannot redefine. Only catches telemetry and `/models` GETs, not chat completions.

### Approach 2: `diagnostics_channel` (Partial)

Use Node.js's official `diagnostics_channel` API — the same approach OpenTelemetry uses. Subscribe to undici lifecycle channels (`undici:request:create`, `undici:request:bodyChunkSent`, etc.).

**Result**: Successfully sees telemetry and `/models` requests but NOT chat completions. Confirmed: chat requests don't go through the extension host's Node.js runtime.

### Approach 3: HTTP/2 Patching (Failed)

Patch `http2.connect()` — maybe Copilot uses HTTP/2 directly for streaming.

**Result**: Patch applied successfully (`http2.connect` is configurable), but Copilot Chat never calls it from the extension host.

### Approach 4: LM API Prototype Patching (Failed)

`vscode.lm.selectChatModels()` returns model objects. Patch `sendRequest` on their shared prototype to intercept ALL calls.

**Result**: VS Code returns **frozen plain objects** — `sendRequest` is `configurable: false, writable: false` with no shared prototype. Completely locked down.

### Approach 5: LM Transport Probe (Definitive Test)

Call `vscode.lm.sendRequest()` ourselves and watch if ANY diagnostic channel fires.

**Result**: Got "probe-ok" response, but **ZERO network activity** in the extension host. This is definitive proof: the VS Code LM API routes requests through the **main Electron process**.

### Approach 6: Built-in OpenTelemetry (The Solution)

**Discovery**: Copilot Chat v0.41+ has hidden OTEL settings:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "/tmp/argus-copilot-otel.jsonl"
}
```

By enabling these and watching the output file, we capture every Copilot Chat inference — model name, token counts, session data, and (with the OTLP HTTP exporter) full prompt/response content.

**How we found it**: Reverse-engineering Copilot Chat's minified `extension.js` to find OTEL attribute constants:

```javascript
INPUT_MESSAGES: "gen_ai.input.messages",
OUTPUT_MESSAGES: "gen_ai.output.messages",
SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
TOOL_DEFINITIONS: "gen_ai.tool.definitions"
```

### What Copilot Does Behind the Scenes

When you type a message in Copilot Chat with Claude Haiku 4.5 selected:

| Step | Model | Tokens | Purpose |
|------|-------|--------|---------|
| 1 | gpt-4o-mini | ~185 in / 4 out | Intent classification |
| 2 | gpt-4o-mini | ~253 in / 74 out | Context gathering |
| 3 | gpt-4o-mini | ~253 in / 76 out | Tool selection |
| 4 | gpt-4o-mini | ~1,665 in / 10 out | Response planning |
| 5 | **claude-haiku-4.5** | **~27,236 in / 76 out** | **Your actual chat** |

Copilot always uses gpt-4o-mini for orchestration (~$0 cost — included free) before sending to your selected model.

---

## Copilot Premium Request Pricing

Copilot pricing is **per-request with multipliers**, not per-token:

| Model | Multiplier | Cost (overage) |
|-------|-----------|----------------|
| GPT-4o, GPT-4.1, GPT-5 mini | 0x | Free (included) |
| Claude Haiku 4.5 | 0.33x | ~$0.013 |
| Gemini 3 Flash | 0.33x | ~$0.013 |
| Claude Sonnet 4/4.5/4.6 | 1x | $0.04 |
| Gemini 2.5 Pro | 1x | $0.04 |
| Claude Opus 4.5/4.6 | 3x | $0.12 |

Monthly allowances: Free=50, Pro=300, Pro+=1,500, Business=300/seat, Enterprise=1,000/seat.

---

## How It Works — Per Provider

### Claude Code

1. On connect, Argus writes HTTP hook endpoints to `~/.claude/settings.json`
2. Claude Code sends webhook POSTs for every event (prompt, tool call, response, session)
3. Argus also sets `ANTHROPIC_BASE_URL` so API calls route through the Argus proxy

### Gemini CLI

1. On connect, Argus installs bridge scripts to `~/.argus/bin/`
2. Configures `~/.gemini/settings.json` with hook commands pointing to the bridge
3. Bridge scripts translate Gemini CLI events into HTTP POSTs to Argus
4. Also sets `GOOGLE_GEMINI_BASE_URL` for proxy routing

### GitHub Copilot

1. Extension sets `COPILOT_OTEL_ENABLED=true` and `COPILOT_OTEL_CAPTURE_CONTENT=true` before Copilot activates
2. Configures Copilot's OTEL file exporter to write to a watched JSONL file
3. Watches the file for new OTEL spans (model, tokens, session data)
4. Also runs network interception layers (diagnostics_channel, monkey-patching) for telemetry
5. Fetches user license info from GitHub's internal API
6. Forwards all captured data to the Argus server

---

## Data Captured

### Per Copilot Chat Interaction

| Field | Source | Status |
|-------|--------|--------|
| Model name | `gen_ai.request.model` | Captured |
| Input tokens | `gen_ai.usage.input_tokens` | Captured |
| Output tokens | `gen_ai.usage.output_tokens` | Captured |
| Cache tokens | `gen_ai.usage.cache_read.input_tokens` | Captured |
| Temperature | `gen_ai.request.temperature` | Captured |
| Finish reason | `gen_ai.response.finish_reasons` | Captured |
| Session/trace IDs | OTEL trace context | Captured |
| TTFT | `copilot_chat.time_to_first_token` | Captured |
| User prompts | `gen_ai.input.messages` | Pending (needs OTLP HTTP) |
| AI responses | `gen_ai.output.messages` | Pending (needs OTLP HTTP) |
| System prompt | `gen_ai.system_instructions` | Pending (needs OTLP HTTP) |

### Per User

| Field | Source |
|-------|--------|
| Copilot plan | `copilot_internal/user` API |
| Premium requests remaining | `quota_snapshots.premium_interactions` |
| Organizations | `organizationsList` |
| Chat enabled | `chat_enabled` flag |

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-recompile)
npm run watch

# Package VSIX
npx vsce package --allow-star-activation

# Run tests
npx vitest run

# Lint
npm run lint
```

### Project Structure

```
src/
├── extension.ts              # Main entry point, activation, commands
├── env-utils.ts              # Cross-platform env var persistence
├── claude-setup.ts           # Claude Code hook configuration
├── gemini-setup.ts           # Gemini CLI hook bridges
├── gemini-code-assist.ts     # Gemini Code Assist detection
├── copilot-detect.ts         # Copilot extension detection
├── copilot-intercept.ts      # Network monkey-patching (7 layers)
├── copilot-diagnostics.ts    # diagnostics_channel + HTTP/2 hooks
├── copilot-otel.ts           # OTEL file watcher + attribute extraction
├── copilot-lm-intercept.ts   # VS Code LM API prototype patching
├── copilot-lm-monitor.ts     # LM model availability polling
├── copilot-license.ts        # GitHub license/quota API
├── copilot-setup.ts          # Copilot capture orchestration
└── __tests__/
    └── copilot-intercept.test.ts
```

**Zero runtime dependencies** — uses only Node.js built-ins and the VS Code API.

---

## Troubleshooting

### Extension doesn't activate

Check the Argus output channel: `Ctrl+Shift+P` → `Argus: Show Copilot Debug Log`. Look for `[Argus] Extension activating...`.

### Copilot data not appearing

1. Run `Argus: Show Copilot Capture Status` to check all layers
2. Verify `github.copilot.chat.otel.enabled` is `true` in VS Code settings
3. After changing OTEL settings, **reload VS Code twice** (Copilot reads settings at activation)

### Connection to server fails

1. Check `argus.serverUrl` in settings
2. Verify the server is running: `curl http://your-server:4080/api/health`
3. Check firewall/network rules allow the connection

### Wrong model showing for Copilot

The extension uses token count heuristics (>500 tokens = user-facing model). Background orchestration models (gpt-4o-mini with ~200 tokens) are correctly filtered out. If you see the wrong model, check the Copilot Capture Status for details.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Links

- **Argus Server**: [ArgusX-AI/Argus-v2](https://github.com/ArgusX-AI/Argus-v2)
- **Deep Dive: Copilot Interception**: [docs/COPILOT_CAPTURE_DEEP_DIVE.md](docs/COPILOT_CAPTURE_DEEP_DIVE.md)
