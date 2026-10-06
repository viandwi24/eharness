# Roadmap

Shipped: 0.1.0 (first release), 0.2.0 (AI SDK helper refactor, `ai@^7.0.123` peer floor),
0.3.0 (long-running turns and progress guard, model catalog / cost / USD budgets, risk-based
approvals with `approval.decided`, `eharness/todos`), 0.4.0 (hardening, prune stage, compaction
thrash stop, skill versions, pre-compaction flush, cross-process abort, `eharness/memory`, durable
inbox, structured final output, production-patterns guide), 0.5.0 (external risk and MCP
annotations, inbox dead-letter, external waits, request-scoped client tools and page context,
budget ledger, `eharness/guard`, `eharness/group`, `eharness/openapi` — released by the next
version PR).
Details: `CHANGELOG.md`.

## Open items

Not scheduled. Each item needs a spec (or spec change) and, where it changes a decision, an ADR
before implementation.

| Item | Notes |
|---|---|
| **Sandbox plugin** (`eharness/sandbox`) | Provides `fs` + `shell` services (conflicts with `filesystem` by design), shell tools, skill materialization via `skill.load` + `locate()`, driver contract (local, Docker, Vercel Sandbox via `@ai-sdk/sandbox-vercel`, AI SDK `experimental_sandbox`). |
| **Loop guard plugin** | Deterministic detection is in core since 0.3 (progress guard, spec 05 §3.2). Remaining: step checkpoints, optional cheap-model auditor. |
| **Subagents plugin** | Ready-made `subagent()` tool: child session with `SessionOptions.parent`, streamed progress via preliminary results, summary return, `addUsage` (tokens + `costUsd`), depth limit. The core pieces exist since 0.1 (guide: `docs/guides/subagents.md`). |
| ~~Todos plugin~~ | Done in 0.3.0 (`eharness/todos`, spec 13). |
| **Code mode / cache-preserving tool discovery** | Support `@ai-sdk/code-mode` with `toolDiscovery: 'conversation'`. |
| **AI SDK `Agent` interface adapter** | `agent.asAgent(session)` implementing `agent-v1` so `createAgentUIStream` and `@ai-sdk/tui` work directly. |
| **HarnessAgent adapter** | Publish `@ai-sdk/harness`-compatible adapter so an eharness agent can run behind `HarnessAgent`. |
| **Binary files** in `FileSystem` | `readBytes` / `writeBytes`, media types, file parts to the model. |
| **Cross-process resumable streams** | Turn buffer adapter (Redis etc.) for `attach()` across instances. |
| **Durable execution** | Suspend/resume a turn across processes (continuation state without secrets), compatible with Workflow DevKit. **Partly done in 0.5.0:** a turn can park at a tool boundary (`externalTool()`, `resolveWait()`, durable timeouts; spec 11 §4.2, ADR-0027) and resume in any instance. Remaining: replaying a turn's earlier steps after a crash and a Workflow DevKit adapter. |
| ~~Memory plugin~~ | Done in 0.4.0 (`eharness/memory`, spec 14; provider-defined tools are app-supplied via the `tool` option). |
| **Package split** | Only if an extension needs its own release cadence (ADR-0007). |
| **Fork** | `session.fork(atMessageId)` → new session id with a copied prefix (needs adapter support or a copy loop). |
| ~~Prune stage~~ | Done in 0.4.0 (`compaction.prune`, spec 06 §5.0, ADR-0019). |
| ~~Output guardrails: schema~~ | Done in 0.4.0 (structured final output: `send(…, { output: { schema } })`, `'output-invalid'`; spec 05 §3.3, ADR-0023). |
| **Output guardrails: policy checks** | Policy checks of the final answer (content rules, a reviewer model) beyond schema validation. |
| ~~USD budget~~ | Done in 0.3.0 (spec 12). |
| **Immediate steer** | Interrupt the current model stream for urgent input instead of waiting for the step boundary. |
| ~~Cross-process queue / wake~~ | Done in 0.4.0 (durable `InboxAdapter`: queue, steer, wake, collect, abort across instances; spec 05 §12, ADR-0024). |
| **Continuation replay on resume** | `attach()` of a `respond()` continuation replays the stored prefix so `useChat` resume needs no re-fetch. |
| **Partial approval answers** | `respond()` with a subset of pending approvals. |
| **Rule-based grants** | `remember` scoped to an input pattern (e.g. `bash: git *`) instead of a whole tool. |
| ~~Approval classifier guard~~ | Done in 0.5.0 (`eharness/guard`, spec 15, ADR-0030). |
| **Goal plugin** | Outer loop: re-prompt after a turn until a goal is met (judge model or `update_goal` tool), paused after empty turns and by budgets. |
| ~~Compaction thrash detection~~ | Done in 0.4.0 (`compaction.thrash`, stop `'context-thrash'`). |
| **Shared task lists** | Todos shared across subagents/sessions (`listId`, owners, dependencies). |

## 0.5.0

P21–P29 (`docs/plans/README.md`), from the 0.5 prior-art analysis. Handoff to the requester:
the 0.5.0 results notes (kept outside the repository).

| Item | Phase | Shipped as |
|---|---|---|
| Tool risk `'external'` + MCP annotation mapping + approval routing | P21 | `ToolRisk` gains `'external'`, `toolTraits()`, `mcpServer({ risk })`; spec 11 §3.2, ADR-0025 |
| Inbox poison items | P22 | `inbox.retry`, `inbox.onDeadLetter`, `availableAt` timers; spec 05 §12, ADR-0026 |
| Park-and-resume (external waits) | P23 | `externalTool()`, `resolveWait()`, `expireWaits()`; spec 11 §4.2, ADR-0027; partly covers **Durable execution** |
| Request-scoped client tools + page context | P24 | `handleChatRequest(…, { clientTools, pageContext })`; spec 11 §7.1, ADR-0028 |
| Cross-session budget ledger | P25 | `BudgetLedger` port, `budget.ledger`; spec 12 §4.1, ADR-0029; partly covers **Budget pre-flight estimate** |
| Approval classifier guard | P26 | `eharness/guard`; spec 15, ADR-0030 |
| Group-chat plugin | P27 | `eharness/group`; spec 16, ADR-0031 |
| OpenAPI → tools | P28 | `eharness/openapi`; spec 17, ADR-0032 |

**Stays application policy (will not become library API):** judge personas and relevance scoring
("when should the bot chime in") in groups, budget scope hierarchies, periods, price lists, soft
limits and alerts (they live in a `BudgetLedger` adapter), approval routing rules per
organisation, who may resolve a webhook, channel adapters (Telegram, Slack, Discord), the choice
of which OpenAPI operations an agent may call, and a rolling summary of a group (use the memory
plugin).

### Found during 0.5.0 (not scheduled)

| Item | Notes |
|---|---|
| **Deferred request tools** | Request-declared client tools sit in the active tool list; a changing set busts the cached prefix (`W_CACHE_BUST`). Behind `tool_search` they would not (ties into **Code mode**). |
| **Durable page context** | Page context is a turn reminder, never stored, so a regenerated turn does not see the old page. A stored variant (opt-in) for apps that need it. |
| **Client-tool declaration in the pending entry** | A continuation after a timeout may have no tool definitions for a stored client call; some providers could reject that. Storing the (size-capped) declaration in the pending entry would remove the risk (not observed so far). |
| **`wait.resolved` hook** | `wait-resolved` events and `turn.end` cover audit; a hook would let plugins react (and carry `actor`). |
| **Core wrappers for dead items** | `session.redrive()` / `agent.inbox.*` over the adapter operations (kept adapter-only in 0.5.0 to avoid a second API surface). |
| **Trusted MCP hints** | `mcpServer({ trustHints: true })` to let `readOnlyHint` lower a risk for a server the app trusts (today `mcpServer({ risk })` covers it explicitly). |
| **Partial usage on aborted steps** | An aborted or timed-out step commits 0 to the budget ledger because AI SDK reports no usage for it; the reservation estimate is the only bound. |
| **OpenAPI extras** | YAML input, response schemas as `outputSchema`, binary / streamed responses, OAuth flows and external `$ref`s (JSON, local refs only in 0.5.0). |
| **Group channel helpers** | Mention / reply extraction for Telegram, Slack and Discord events (the plugin takes the facts as input today). |

## 0.4.0

P13–P20 (`docs/plans/README.md`): hardening, prune stage, compaction thrash detection, skill
versions, pre-compaction flush, cross-process abort, memory plugin, structured final output,
durable inbox (cross-process queue / steer / wake / collect), production-patterns guide. The rows
above that 0.4.0 completes are struck through (P20).
Handoff to the requester: the 0.4.0 results notes (kept outside the repository).

## Found during the 0.4.0 audit (not scheduled)

The audit also re-confirmed three open rows above as the next most requested: **Subagents
plugin**, **AI SDK `Agent` interface adapter** (`asAgent()`) and **HarnessAgent adapter**.

| Item | Notes |
|---|---|
| **Delta persistence** | `persistEachStep` rewrites the whole assistant message every step (write amplification on long turns). Options: optional `MessageAdapter.appendParts(sessionId, messageId, parts)` or batched step saves; must keep upsert-by-id semantics as the fallback. |
| **Projection cache** | Every step re-projects the whole view (quadratic over a long session). Cache the model projection per message id + revision; invalidate on upsert. |
| **Turn-level tracing** | OpenTelemetry spans per turn / step / tool / compaction around AI SDK's own telemetry (`telemetry` is only passed through today). |
| **Typed `runtime` / `callOptions`** | Infer `ctx.runtime` and `ctx.turn.options` types from the agent config instead of `Record<string, unknown>` / `unknown`. |
| **Plugin tools in `InferHarnessUIMessage`** | Tool parts of plugin-contributed tools are not in the inferred UI message type yet. |
| **`TurnBufferAdapter`** | Cross-instance `attach()` (same as "Cross-process resumable streams"; listed here because the inbox makes it the next gap). |
| **`maxSummaryTokens` scaling** | Default 4 000 regardless of window; scale with the summarizer window (e.g. 2–5 %) with a cap. |
| **Budget pre-flight estimate** | Estimate the next step's cost before calling the model and stop early instead of overshooting by one step. **Partly done in 0.5.0:** with `budget.ledger` the core reserves an estimate (`estimateStepCostUsd()`) before every call; the per-turn / per-session `maxTurnUsd` / `maxSessionUsd` still stop after the step that crossed them. |
| **Session-cached instruction runtime leak warning** | A session-refresh instruction that reads `ctx.runtime` caches the first request's runtime for the whole session; warn (or document loudly) when such an instruction reads per-request runtime. |
| **Pruning inside the current turn** | P14 prunes completed turns only; very long single turns could prune old steps by token distance (cache cost per step). |
| **Forced final output on wrap-up** | P18 leaves the `max-steps` wrap-up tool-less; optionally force `final_answer` there. |
| ~~Inbox poison-item limit~~ | Done in 0.5.0 (`inbox.retry`, `inbox.onDeadLetter`, dead-letter / `redrive` / `stats` on `InboxAdapter`; spec 05 §12 rules 11–15, ADR-0026). |
