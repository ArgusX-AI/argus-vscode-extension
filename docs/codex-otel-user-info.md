# What the Codex OTEL + rollout hook can learn about the user

This doc inventories every piece of user-related information the Argus VS Code
extension can gather from a Codex session. Each item links back to the code
that reads it, and ships with a real-life example of what it reveals.

Sources are the two Codex capture paths:

- **OTEL** — the local OTLP HTTP receiver at `CODEX_OTLP_PORT` (14323) that
  ingests Codex CLI log records. Source: [src/codex-otel.ts](../src/codex-otel.ts).
- **Rollout** — the JSONL session files Codex always writes to
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. Source:
  [src/codex-rollout.ts](../src/codex-rollout.ts).

Both paths POST to `${serverUrl}/hooks/CodexRequest` with headers
`X-Argus-User`, `X-Argus-Source: codex`, and `X-Argus-Codex-Source: rollout|otel`.

---

## From OTEL attributes (per log record)

| Field | Attribute(s) read | Real-life example |
|---|---|---|
| User prompt text | `codex.user_prompt`, `gen_ai.input.messages` (role=user) | `"write me a function that logs in with admin/admin123"` — intent + hard-coded secrets. |
| Assistant completion | `codex.assistant_response`, `gen_ai.output.messages` | Leaked API keys or PII the model echoed back into code. |
| System / developer instructions | `gen_ai.system_instructions` | `"I am Eli, always write Python like an ex-Googler"` — real identity + preferences. |
| Model name | `gen_ai.request.model`, `gen_ai.response.model`, `codex.model` | `gpt-5.4`, `gpt-5-codex-high` — tier / provider the user pays for. |
| Sampling parameters | `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.max_tokens` | `temperature=0` tells you the user is on a deterministic config. |
| Finish reasons | `gen_ai.response.finish_reasons` | `content_filter` leaks that the user tried something policy-violating. |
| Response id | `gen_ai.response.id` | Correlates with the provider's own logs. |
| Conversation id | `gen_ai.conversation.id`, `conversation.id` | Links multi-turn sessions — lets you fingerprint a user's workflow across hours. |
| Token counts | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.reasoning_tokens`, `codex.input_tokens`, `codex.output_tokens` | 200k-input-token spike means the user pasted a large codebase or secret dump. |
| Time-to-first-token + duration | `codex.time_to_first_token`, `codex.duration_ms` | Consistent sub-second TTFT suggests a US-east network path — geolocation hint. |
| Tool definitions | `gen_ai.tool.definitions` | Reveals which tools are exposed to the agent (shell, apply_patch, web_search, …). |
| Tool name | `gen_ai.tool.name`, `codex.tool_name` | `apply_patch` vs `shell` — how the agent touches the system. |
| Tool call args | `gen_ai.tool.call.arguments`, `codex.tool_input` | `shell({"cmd": "rm -rf node_modules"})` or `apply_patch` args contain real file paths + source code. |
| Tool call result | `gen_ai.tool.call.result`, `codex.tool_result` | Command stdout — can leak env vars, secrets, directory listings. |
| Span / event name | `span.name`, `event.name` | Tells you which kind of request (inference vs tool decision vs sse_event). |

---

## From the rollout JSONL header + `turn_context`

| Field | Where it lives | Real-life example |
|---|---|---|
| Session start timestamp | `header.timestamp` / `session_meta.payload.timestamp` | `2026-04-17T01:18:42Z` — user's active hours, implies timezone + work schedule. |
| Codex session id | `session_id` / `payload.id` | Deduplication; also correlates with OTEL `conversation.id`. |
| Codex CLI version | `payload.cli_version` | Tells you how stale/fresh they are, whether they're on a known-vulnerable build. |
| Originator | `payload.originator` | `codex_cli_rs`, `vscode`, `codex-web` — which surface they used. |
| Working directory | `payload.cwd` | `C:\Users\Eli Guy\Desktop\MyPro\argus-vscode-extension` leaks username + project name in one string. |
| Provider | `header.provider` / `session_meta.payload.model_provider` | `openai`, `anthropic`, `google`. |
| Base instructions | `session_meta.base_instructions.text` | User's custom `AGENTS.md` / `.cursorrules` excerpt — taste + guardrails. |
| Turn id + trace id | `turn_context.turn_id`, `turn_context.trace_id` | Joins multi-turn rollouts across OTEL. |
| Personality | `turn_context.personality` | `"gpt-5-codex"`, `"gpt-5-high"` — reasoning mode. |
| Effort | `turn_context.effort` | `"low"` / `"medium"` / `"high"` — how hard the user wants the agent to think. |
| Collaboration mode | `turn_context.collaboration_mode.mode` | `pair`, `autonomous`. |
| Approval policy | `turn_context.approval_policy` | `never-approve` means the user runs agents with no review — security-relevant. |
| Sandbox policy | `turn_context.sandbox_policy` | `danger-full-access` means the agent can touch anything — security-relevant. |
| Timezone | `turn_context.timezone` | `America/New_York` — direct geolocation. |
| Realtime flag | `turn_context.realtime_active` | Whether the user is streaming vs batch. |
| Truncation policy | `turn_context.truncation_policy` | How aggressively history is dropped. |
| Task duration | `task_complete.duration_ms` | `51h30m` (bottom row of the screenshot) — either left a session open overnight or ran a very long workflow. |
| Last agent message | `task_complete.last_agent_message` | Often the "final answer" summary of the whole session. |
| Rate limits snapshot | `token_count.payload.rate_limits` | Which plan / quota bucket the user is on. |
| Model context window | `task_started.model_context_window` | Reveals model tier implicitly (128k vs 256k vs 1M). |

---

## Added by the rollout sender at POST time

| Field | Source | Real-life example |
|---|---|---|
| OS user | `os.userInfo().username` | `"Eli Guy"` — real name leak. |
| Hostname | `os.hostname()` | `"DESKTOP-ELI"` — machine identifier. |
| Platform | `process.platform` | `win32` / `darwin` / `linux`. |
| Argus user header | `X-Argus-User` | Whatever was set at setup — usually the OS user again. |
| Codex source | `X-Argus-Codex-Source` | `rollout` vs `otel` — lets you know which path the data took. |

---

## What we could capture but don't today

- **Client IP** — OTLP ingress is `127.0.0.1`, and the rollout sender doesn't
  expose a client IP; the server-side ingress IP is the public internet
  endpoint, not the user.
- **Git state** — branch / last commit / remote URL are not captured. The
  rollout `cwd` tells you the folder but not what's inside `.git/`.
- **Open editor file / cursor position** — Codex's OTEL surface doesn't emit
  this; the VS Code extension could add it but currently doesn't.
- **Environment variables** — deliberately NOT captured. Would leak secrets
  (API keys, credentials, paths). Do not add without an allow-list.
- **Clipboard / selection** — not captured. Same reason.

---

## Privacy implications (one real-life profile)

From a single Codex session captured by this hook today you can infer:

> User `"Eli Guy"` on host `DESKTOP-ELI` running Windows, active at ~01:18 local
> time, working on the `argus-vscode-extension` project, using Codex CLI
> `0.47.0` against model `gpt-5.4`. Sandbox disabled (`danger-full-access`),
> approval policy `never-approve`. Wrote ~200k input tokens about
> `"waht is xss"` — strongly implies a security-adjacent project, a user who
> works late nights, runs agents with elevated trust, and whose real first
> name is Eli.

That profile is buildable from a **single** `CodexRequest` POST body, without
any cross-session correlation. Treat the payload as sensitive PII + source
code and store/transmit it accordingly.

---

## New as of extension 0.25.4

Each outbound payload now also includes a derived **`session_title`** field —
a short, human-readable label (≤60 chars) built from the first user prompt
on the session. The Argus server uses it as the session display label,
replacing the generic `"Codex — <model>"` fallback. See
[src/session-title.ts](../src/session-title.ts) for the exact slicing rules.
