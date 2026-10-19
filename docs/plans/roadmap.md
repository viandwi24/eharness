# Roadmap

Shipped: 0.1.0 (first release), 0.2.0 (AI SDK helper refactor, `ai@^7.0.123` peer floor),
0.3.0 (long-running turns and progress guard, model catalog / cost / USD budgets, risk-based
approvals with `approval.decided`, `eharness/todos`), 0.4.0 (hardening, prune stage, compaction
thrash stop, skill versions, pre-compaction flush, cross-process abort, `eharness/memory`, durable
inbox, structured final output, production-patterns guide), 0.5.0 (external risk and MCP
annotations, inbox dead-letter, external waits, request-scoped client tools and page context,
budget ledger, `eharness/guard`, `eharness/group`, `eharness/openapi`), 0.6.0 (`wrapPlugin`,
approvals combined with tools without `execute`), 0.7.0 (`eharness/permissions`, `eharness/shell`,
`eharness/subagent`, `eharness/ask`, `eharness/web`, `eharness/filesystem/node`, fork, binary
files, glob and multi-edit, `session.stats()` of the whole request, security defaults for MCP
results and kind messages), 0.8.0 (published 2026-10-11, git tag `eharness@0.8.0`; see
[0.8.0](#080)). **0.9.0 is next** (see [0.9.0](#090-next)): 39 changesets are pending on `main`
(18 minor, 21 patch) and the version PR has not been cut yet. Nothing after 0.8.0 is published.
Details: `CHANGELOG.md` and `docs/guides/upgrading.md`.

## Open items

The proposed 1.0 stability list (stable / experimental / internal-candidate per export) is in
[stability-1.0.md](../engineering/stability-1.0.md).

Not scheduled. Each item needs a spec (or spec change) and, where it changes a decision, an ADR
before implementation.

| Item | Notes |
|---|---|
| ~~Sandbox plugin~~ | Done in P31 as `eharness/shell` (`shell()` + `localSandbox()`, Node-only; spec 19, ADR-0036). A Docker / remote driver implements the `Sandbox` interface; skill materialization via `locate()` stays open. |
| **Loop guard plugin** | Deterministic detection is in core since 0.3 (progress guard, spec 05 §3.2). Remaining: step checkpoints, optional cheap-model auditor. |
| ~~Subagents plugin~~ | Done in P31 (`eharness/subagent`, spec 20, ADR-0035): inline / park / policy approvals, background children, usage and progress. |
| ~~Todos plugin~~ | Done in 0.3.0 (`eharness/todos`, spec 13). |
| **Code mode / cache-preserving tool discovery** | Support `@ai-sdk/code-mode` with `toolDiscovery: 'conversation'`. |
| **AI SDK `Agent` interface adapter** | `agent.asAgent(session)` implementing `agent-v1` so `createAgentUIStream` and `@ai-sdk/tui` work directly. |
| **HarnessAgent adapter** | Publish `@ai-sdk/harness`-compatible adapter so an eharness agent can run behind `HarnessAgent`. |
| ~~Binary files~~ in `FileSystem` | Done in P31 (`readBytes` / `writeBytes`, `FileMeta.binary`, media outputs; spec 08 §12). |
| ~~Cross-process resumable streams~~ | Done in 0.8.0 (`StreamLogAdapter`, `storage.streams`, `attachRemote()`, `handleResumeRequest()`; spec 04 §6.2, ADR-0039). |
| **Durable execution** | Suspend/resume a turn across processes (continuation state without secrets), compatible with Workflow DevKit. **Partly done in 0.5.0:** a turn can park at a tool boundary (`externalTool()`, `resolveWait()`, durable timeouts; spec 11 §4.2, ADR-0027) and resume in any instance. Remaining: replaying a turn's earlier steps after a crash and a Workflow DevKit adapter. |
| ~~Memory plugin~~ | Done in 0.4.0 (`eharness/memory`, spec 14; provider-defined tools are app-supplied via the `tool` option). |
| **Package split** | Only if an extension needs its own release cadence (ADR-0007). |
| ~~Fork~~ | Done in P31 (`session.fork()`, `session.children()`; spec 05 §13–14, ADR-0037). |
| ~~Prune stage~~ | Done in 0.4.0 (`compaction.prune`, spec 06 §5.0, ADR-0019). |
| ~~Output guardrails: schema~~ | Done in 0.4.0 (structured final output: `send(…, { output: { schema } })`, `'output-invalid'`; spec 05 §3.3, ADR-0023). |
| **Output guardrails: policy checks** | Policy checks of the final answer (content rules, a reviewer model) beyond schema validation. |
| ~~USD budget~~ | Done in 0.3.0 (spec 12). |
| **Immediate steer** | Interrupt the current model stream for urgent input instead of waiting for the step boundary. |
| ~~Cross-process queue / wake~~ | Done in 0.4.0 (durable `InboxAdapter`: queue, steer, wake, collect, abort across instances; spec 05 §12, ADR-0024). |
| ~~Continuation replay on resume~~ | Done in 0.8.0 (the resumed stream starts with a replay of the continued message; spec 04 §6.3, ADR-0045). |
| ~~Partial approval answers~~ | Done in 0.8.0 (`respond()` records a subset; the last answer continues; spec 11, ADR-0044). |
| ~~Rule-based grants~~ | Done in P31 via `eharness/permissions` (`Tool(spec)` rules such as `Bash(git *)`, spec 18); the core `remember` stays per tool. |
| ~~Approval classifier guard~~ | Done in 0.5.0 (`eharness/guard`, spec 15, ADR-0030). |
| **Goal plugin** | Outer loop: re-prompt after a turn until a goal is met (judge model or `update_goal` tool), paused after empty turns and by budgets. |
| ~~Compaction thrash detection~~ | Done in 0.4.0 (`compaction.thrash`, stop `'context-thrash'`). |
| **Shared task lists** | Todos shared across subagents/sessions (`listId`, owners, dependencies). |

## 0.9.0 (next)

State on 2026-10-19: `package.json` and `CHANGELOG.md` say 0.8.0, which is on npm (published
2026-10-11; `npm view eharness versions` ends at 0.8.0). Everything below is in pending changesets
(`.changeset/`) and ships with the next `bun run release:version`; versions are not touched until
then. Source of truth for the final text is the generated `CHANGELOG.md`.

| Area | Contents | Changesets |
|---|---|---|
| New Draft modules | `eharness/scheduler`, `channels`, `identity`, `handoff`, `limits` (`stepBudget`, `budgetNotice`, `longRun`), `clock`, `code` (Python over the virtual file system), `browser` + `browser/node` (P44, P46-P48; specs 28-35, ADR-0061-0064) | scheduler-module, channels-module, identity-module, handoff-module, limits-module, long-run, clock-module, code-sandbox-python, browser-module |
| Follow-ups of those modules | scheduler `fired: false`, outbox `expiredLeases`, handoff `resolveHandoff` options and `redeliverHandoff`, `browser_scroll`, neutralised mentions | scheduler-outbox-followups, outbox-governor-followups, handoff-followups, browser-scroll-tool, inline-allowed-mentions |
| Deprecations | `eharness/group`, `eharness/guard`, `eharness/openapi` (ADR-0062), removed at 1.0 | deprecate-unused-modules |
| Subagents and attachments | `subagent({ files })`, `onPark: 'notice'`, stop keeps the result, `childSessionId` receives the agent key | attachments-delegation-modalities, subagent-on-park-notice, subagent-stop-keeps-result, subagent-child-id-agent |
| Http, client, connectors | clipped message reads (`?clip=`), `ConnectionCredentials.session`, client clears the error after status | clipped-message-reads, connectors-session-qr-resend, client-clear-error-after-status |
| Tool output and media | `toolOutput.keepImages`, media of MCP results offloaded to the `toolMedia` service (`media-ref` parts), offloaded path note, stale sources | tool-output-media, tool-media-offload, tool-media-path-and-stale-sources |
| Tool loop safety | `toolCalls.maxPerStep`, `toolCalls.maxIdenticalResults`, `tool_search` `select:`, deferred auto-load, leaked tool-markup stripping | tool-calls-per-step, tool-identical-results, tool-search-select-and-grep-flags, deferred-tool-autoload, leaked-tool-markup |
| Models and compaction | unsupported-file notes (projection and instruction text), compaction threshold with large output reserve | unsupported-files-history-note, unsupported-file-note-instructs, compaction-threshold-reasoning |
| Other | `probeOsSandbox()`, remote MCP `refresh: 'turn'` and `reviewToolChanges`, `W_MCP_DRIFT` session id, `NoticePayload.code` accepts app strings, AI SDK experimental options isolated | os-sandbox-probe, remote-mcp-refresh, mcp-review-tool-changes, mcp-drift-session-id, typed-agent-generics, ai-sdk-alignment |

### Breaking-risk review (api-stability.md checklist)

The bump is a minor (0.x), so breaking changes are allowed, but they must be named in the
changeset. The four items that looked like patches:

| Changeset | Verdict | Why |
|---|---|---|
| `typed-agent-generics` | additive | `NoticePayload.code` is widened with `(string & Record<never, never>)`; literal autocomplete stays. The only break is a user `switch` that relied on the union being closed for exhaustiveness; unlikely, patch is fine. |
| `tool-output-media` | behaviour change, no break | Media of MCP results is no longer counted or cut by the output limits, and `keepImages` is new and optional. The model-visible text of a truncated screenshot changes (it was truncated base64), which api-stability.md treats as a minor-level wording change in 0.x. |
| `tool-media-offload` | **highest risk** | On by default for the `filesystem` plugin (`toolMedia !== false`): it writes files under `/.eharness/tool-media` and changes the **persisted format** of MCP media tool outputs (`media-ref` parts instead of base64) and adds `W_TOOL_MEDIA_OFFLOAD`. A store written by 0.9 and read by 0.8 loses the images. Upgrade direction (0.8 data into 0.9) is safe: inline base64 still projects. Needs a "persisted format / new default" line and the downgrade caveat in the generated changelog; consider changing the bump of this changeset to `minor`. |
| `subagent-child-id-agent` | additive | A third argument is passed to the `childSessionId` callback; callbacks with fewer parameters keep working. |

Also checked: the deprecations only add `@deprecated` and (per ADR-0062) no removal before 1.0; the
module exports snapshot (`scripts/exports-snapshot.ts`) is the authoritative list of additions.

## 0.8.0

P33–P39 (`docs/plans/README.md`), driven by the team example (`examples/team`) and an internal
multi-perspective review. Six new Draft subpaths, many session APIs, and a breaking hardening pass
(renames, trimmed exports, safer defaults; migration lines in the changesets and
`docs/guides/upgrading.md`).

| Item | Shipped as |
|---|---|
| Providers | `eharness/providers`: definitions, profiles, `createProviderManager()`, catalogs (models.dev, OpenRouter), secret vault; spec 23, ADR-0048, 0052, 0053 |
| Connectors | `eharness/connectors`: definitions, connections, per-agent enablement, server-driven setup flows, OAuth, activation; spec 24, ADR-0049-0053 |
| Activity and attention | `eharness/activity`: `activity({ store })`, `ActivityStore`, SSE helpers, `listAttention` / `answerAttention`; spec 25, ADR-0058 |
| HTTP and client | `eharness/http` (`createHarnessHttp`), `eharness/client`, `eharness/client/react`; specs 26-27, ADR-0059 |
| Multi-instance and restarts | stream log and `attachRemote()`, `handleResumeRequest()`, held wakes, `recovery.instanceId`, `session.recover()`, `reconcileBackgroundChildren`, session invariants and fuzz suite, stale-handle reads (ADR-0039, 0054-0057) |
| Interaction | partial resolution of approvals, continuation replay on resume, `run.accepted` / `toResponse()`, `enqueue` timers, ids and metadata (ADR-0040, 0043-0045) |
| Subagents | `agent.peek()`, child identity, `maxChildren`, park-mode messaging, durable background children (ADR-0041, 0042, 0046) |
| Observability | `model.call` hook and `observeModel`, `openRouterCatalog`, `session.stats().usage` (ADR-0047) |
| Security hardening | secrets bound to endpoints, case-insensitive deny/ask, dot-glob asks, prefix-scoped shell grants, remote MCP `read` asks, private-host checks, bounded event queues |
| Hardening review (P39) | naming (`ask`, `guard`, `permissions`, `group`, `subagent`, `inMemory*`, `*Source`, one options object, `toResponse()` / `toStreamResponse()`, awaitable `session.abort()`), trimmed exports with a committed snapshot (`scripts/exports.snapshot.json`), timeouts for hooks, model streams, MCP, tool sources and OAuth, fail-closed `authorize`, `data:`-only client file URLs, OAuth private-host refusal, shell env allow-list, untrusted framing of OpenAPI and MCP structured output, one shared LLM judge (`createJudge`, ADR-0060), `config.observe`, one error taxonomy (`src/codes.ts`), one glob compiler, bounded background children, tests fail on `W_INVARIANT_VIOLATION`, core and subagent split into phase modules without import cycles |

### After 0.8.0 (not scheduled)

| Item | Notes |
|---|---|
| **Stability pass toward 1.0** | Promote the Draft modules that settled in real use (permissions, subagent, shell, http, client). The export surface was already trimmed in P39 (`eharness/connectors` exports 35 runtime names); remaining candidates are reviewed through the exports snapshot diff. |
| **One input verb** | `send({ ifBusy })`, `enqueue({ mode })` and `inject()` overlap; align names before 1.0 (the which-one table in `docs/guides/reference.md` covers the gap meanwhile). |
| **Split the big files** | `src/subagent`, `src/session` and the turn lifecycle were split in P39; `src/permissions/engine.ts` is the remaining large module (no behaviour change). |
| **Open items above** | The unstruck rows (code mode, `Agent` adapter, durable execution replay, goal plugin, shared task lists, immediate steer). |

## 0.5.0

P21–P29 (`docs/plans/README.md`), from the 0.5 prior-art analysis. Handoff to the requester:
the 0.5.0 results notes (internal).

| Item | Phase | Shipped as |
|---|---|---|
| Tool risk `'external'` + MCP annotation mapping + approval routing | P21 | `ToolRisk` gains `'external'`, `toolTraits()`, `mcpServerSource({ risk })`; spec 11 §3.2, ADR-0025 |
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
| **Trusted MCP hints** | `mcpServerSource({ trustHints: true })` to let `readOnlyHint` lower a risk for a server the app trusts (today `mcpServerSource({ risk })` covers it explicitly). |
| **Partial usage on aborted steps** | An aborted or timed-out step commits 0 to the budget ledger because AI SDK reports no usage for it; the reservation estimate is the only bound. |
| **OpenAPI extras** | YAML input, response schemas as `outputSchema`, binary / streamed responses, OAuth flows and external `$ref`s (JSON, local refs only in 0.5.0). |
| **Group channel helpers** | Mention / reply extraction for Telegram, Slack and Discord events (the plugin takes the facts as input today). |

## 0.4.0

P13–P20 (`docs/plans/README.md`): hardening, prune stage, compaction thrash detection, skill
versions, pre-compaction flush, cross-process abort, memory plugin, structured final output,
durable inbox (cross-process queue / steer / wake / collect), production-patterns guide. The rows
above that 0.4.0 completes are struck through (P20).
Handoff to the requester: the 0.4.0 results notes (internal).

## Found during the 0.4.0 audit (not scheduled)

The audit also re-confirmed three open rows above as the next most requested: **Subagents
plugin** (done in P31), **AI SDK `Agent` interface adapter** (`asAgent()`) and **HarnessAgent adapter**.

| Item | Notes |
|---|---|
| **Delta persistence** | `persistEachStep` rewrites the whole assistant message every step (write amplification on long turns). Options: optional `MessageAdapter.appendParts(sessionId, messageId, parts)` or batched step saves; must keep upsert-by-id semantics as the fallback. |
| **Projection cache** | Every step re-projects the whole view (quadratic over a long session). Cache the model projection per message id + revision; invalidate on upsert. |
| **Turn-level tracing** | OpenTelemetry spans per turn / step / tool / compaction around AI SDK's own telemetry. **Partly done in 0.8.0:** `config.observe` reports phase durations and counters (an OpenTelemetry bridge is in `docs/guides/observability.md`); `telemetry` stays the AI SDK pass-through. |
| **Typed `runtime` / `callOptions`** | Infer `ctx.runtime` and `ctx.turn.options` types from the agent config instead of `Record<string, unknown>` / `unknown`. |
| **Plugin tools in `InferHarnessUIMessage`** | Tool parts of plugin-contributed tools are not in the inferred UI message type yet. |
| **`TurnBufferAdapter`** | Cross-instance `attach()` (same as "Cross-process resumable streams"; listed here because the inbox makes it the next gap). |
| **`maxSummaryTokens` scaling** | Default 4 000 regardless of window; scale with the summarizer window (e.g. 2–5 %) with a cap. |
| **Budget pre-flight estimate** | Estimate the next step's cost before calling the model and stop early instead of overshooting by one step. **Partly done in 0.5.0:** with `budget.ledger` the core reserves an estimate (`estimateStepCostUsd()`) before every call; the per-turn / per-session `maxTurnUsd` / `maxSessionUsd` still stop after the step that crossed them. |
| **Session-cached instruction runtime leak warning** | A session-refresh instruction that reads `ctx.runtime` caches the first request's runtime for the whole session; warn (or document loudly) when such an instruction reads per-request runtime. |
| **Pruning inside the current turn** | P14 prunes completed turns only; very long single turns could prune old steps by token distance (cache cost per step). |
| **Forced final output on wrap-up** | P18 leaves the `max-steps` wrap-up tool-less; optionally force `final_answer` there. |
| ~~Inbox poison-item limit~~ | Done in 0.5.0 (`inbox.retry`, `inbox.onDeadLetter`, dead-letter / `redrive` / `stats` on `InboxAdapter`; spec 05 §12 rules 11–15, ADR-0026). |
