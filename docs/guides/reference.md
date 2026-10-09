# Reference

Every option and method at a glance, with defaults and the guide or spec that explains it. The
specs in [`../specs`](../specs) are the full contracts.

## `defineHarnessAgent(config)`

| Option | Default | Notes |
|---|---|---|
| `model` | required | AI Gateway string or AI SDK `LanguageModel` |
| `id` | `'agent'` | used in logs and telemetry |
| `contextWindow` | from `models`, else 128k (`W_DEFAULT_CONTEXT_WINDOW`) | number or `(model) => number \| undefined` — [compaction](compaction.md) |
| `models` | none | `ModelCatalog`: record keyed by model id, or function — [models and cost](models-and-cost.md) |
| `budget` | none | `{ maxTurnUsd?, maxSessionUsd?, warnAt? = 0.8, ledger? }` → `'cost-cap'` — [models and cost](models-and-cost.md#budgets); `ledger: { adapter, scopes, estimate?, reservationTtlMs?, onError? = 'stop' }` — [budgets across sessions](models-and-cost.md#budgets-across-sessions) |
| `instructions` | none | string, `{ text, id? }`, function, or `{ text: fn, refresh: 'session' \| 'turn' }` — [tools and MCP](tools-and-mcp.md#instructions) |
| `tools` | none | record of `Tool` / `(ctx) => Tool`, a `ToolSource`, or an array of both |
| `skills` | none | `defineSkill(…)` / `defineSkillSource(…)` — [skills](skills.md) |
| `mcp` | none | `mcpServer(…)` sources (same as putting them into `tools`) |
| `dataParts`, `messageKinds` | none | app parts `data-<key>` and kinds — [rendering data parts](rendering-data-parts.md) |
| `plugins` | `[]` | `definePlugin(…)` values, in order — [writing a plugin](writing-a-plugin.md) |
| `storage` | memory adapters | `{ messages?: MessageAdapter; state?: StateAdapter; inbox?: InboxAdapter }` — [storage adapters](writing-a-storage-adapter.md), [several instances](multi-instance.md) |
| `inbox` | `{ pollMs: 2_000, claimTtlMs: recovery.staleMs, collect: { quietMs: 1_500, maxWaitMs: 10_000, maxItems: 20 } }` | durable inbox drain (`pollMs: 0` = notifications only) and the `collect` debounce (also without an inbox) — [several instances](multi-instance.md) |
| `inbox.retry` (0.5.0) | off (unlimited redelivery, as 0.4) | `{ maxAttempts?, backoff?: { type?: 'fixed' \| 'exponential' = 'exponential', delayMs? = 1_000, maxDelayMs? = 60_000, jitter? = true }, nonRetryable? = EH_INVALID_INPUT }`: attempts are counted at claim; an item past `maxAttempts` or failing non-retryably is dead-lettered — [poison items](multi-instance.md#poison-items) |
| `inbox.onDeadLetter` (0.5.0) | none | `(item: DeadInboxItem) => void \| Promise<void>`, called after the adapter stored the dead item; a throw is `W_HOOK_FAILED` |
| `compaction` | `{ summarizeAt: 0.75, keepLast: 4, maxSummaryTokens: 4_000 }` | or `false` — [compaction](compaction.md) |
| `compaction.prune` | off | `{}` = `{ keepTurns: 2, minChars: 2_000 }`; `exclude`, `replaceWith` — view-only pruning of old tool outputs ([compaction](compaction.md#pruning-old-tool-outputs)) |
| `compaction.thrash` | `{ withinSteps: 2 }` | or `false` — stop `'context-thrash'` when a second compaction within the window cannot get below `summarizeAt` ([compaction](compaction.md#when-a-turn-thrashes)) |
| `guard` | `{ maxContextRatio: 0.9 }` | `reserveTokens` default: `settings.maxOutputTokens` ?? 8% of the window |
| `isContextOverflow` | built-in patterns | extra "context too long" detection |
| `loop` | see below | [long-running turns](long-running-turns.md) |
| `settings` | none | `streamText` settings: `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `reasoning`, `maxRetries`, `headers`, `providerOptions`, `timeout` (per step), `streamRetries` |
| `approval` | `{ onNewInput: 'deny' }` | `policy`, `risk`, `secret`, `onNewInput` — [approvals](approvals-and-interaction.md) |
| `cache` | `{ mode: 'auto' }` | `{ mode?: 'auto' \| 'breakpoints'; ttl?: '5m' \| '1h' }` or `false`; Anthropic models only |
| `toolOutput` | `{ maxChars: 50_000, strategy: 'truncate' }` | plus `perTool` — [tools and MCP](tools-and-mcp.md#tool-output-limits) |
| `toolErrorText` | `String(error)` | `(error, { toolName, toolCallId }) => string`: the text of a thrown tool error in UI, storage and wire (hide secrets) — [tools and MCP](tools-and-mcp.md#tools) |
| `inputFiles` | `{ protocols: ['data:', 'https:'], maxBytes: 20 MB }` | allowed file URL protocols of user input and the decoded `data:` URL cap; others → `EH_INVALID_INPUT` |
| `callOptions` | none | schema for `SendOptions.options` → `ctx.turn.options` |
| `repairToolCall` | none | AI SDK `repairToolCall` |
| `recovery` | `{ staleMs: 120_000, abortPollMs: 2_000 }` | crash recovery of turns whose process died, and the poll for aborts requested by another instance (`abortPollMs: 0` = off); `false` disables both |
| `telemetry` | none | AI SDK telemetry options |
| `strict` | `false` | misuse warnings throw `EH_CONFIG_INVALID` |
| `logger` | debug/info off, warn/error to console | `ctx.log` |
| `onWarning` | `console.warn`, deduplicated | every `HarnessWarning` |
| `generateId` | `uuidv7` | must produce time-sortable ids (`idGeneratorConformance`) |
| `skillsIndexLimit` | 50 | above it, skills switch to `search_skills` |
| `sessionIdleMs` | 30 min | evict idle cached sessions; `0` = never |

`loop`: `maxSteps` 500 · `wrapUp` `true` · `progress` `{ repeats: 3, window: 20, errorStreak: 5,
nudges: 1, ignoreTools }` or `false` · `maxIdleContinues` 3 · `maxContinues` none ·
`maxTurnOutputTokens` none · `turnTimeoutMs` none · `persistEachStep` `true`.

The returned `HarnessAgent` has `id`, `config`, `session(id, options?)`, `closeSession(id)` and
`close()`. `InferHarnessUIMessage<typeof agent>` is its exact message type (for `useChat`).

## Sessions

`agent.session(id, options?)` — `SessionOptions`: `storage` (per-session adapters), `runtime`
(`ctx.runtime`), `toolsContext`, `lock` (`SessionLock`), `onInvalidMessage` (`'drop'` default,
`'keep'`, `'throw'`), `acceptClientMetadata` (default `false`), `parent` (subagents, depth ≤ 8).
Options passed to an already cached session are ignored (`W_SESSION_OPTIONS_IGNORED`).

| Method | Does |
|---|---|
| `send(input?, options?)` | start a turn (`string`, `{ text, files }` or a `UIMessage`; none = continue) |
| `respond({ approvals, toolOutputs, externals }, options?)` | answer pending approvals / client tools / external waits (`externals` is a trusted server call) and continue the same message |
| `regenerate({ messageId?, … })`, `edit(messageId, input, options?)` | answer again / replace a user message |
| `attach()` | replay and follow the running turn (`undefined` when idle) |
| `abort(reason?)` | abort the running turn and drop queued turns; without a local turn, request the abort of a turn running in another instance |
| `requestAbort(reason?)` | awaitable abort → `{ target: 'local' \| 'remote' \| 'idle' \| 'unsupported' }` ([long-running turns](long-running-turns.md#stopping-a-turn-from-another-instance)) |
| `inject(kind, data, { deliver?, wake? })` | store an event message; deliver it into the running turn or wake the agent (with an inbox, also the instance running the turn) |
| `enqueue(input, { mode?, collect? })` | hand input to whichever instance holds the session → `{ inboxId, target: 'local' \| 'remote' }`; `mode`: `'queue'` (default), `'steer'`, `'collect'` ([several instances](multi-instance.md)) |
| `resolveWait(waitId, { output } \| { errorText }, options?)` (0.5.0) | record the result of an external wait (validated against `outputSchema`, compare-and-set, first result wins) and continue the same assistant message when nothing is left open → `{ status: 'continued', run }` \| `{ status: 'recorded', remaining }` \| `'already-resolved'` \| `'not-pending'` ([external waits](external-waits.md)) |
| `expireWaits(now?)` (0.5.0) | apply the `onTimeout` result of every due wait (sweepers) → `{ expired, run? }` |
| `pendingWaits()` (0.5.0) | the stored external waits (`PendingExternal[]`) for UIs and sweepers |
| `compact()` | manual compaction (idle only) |
| `clearGrants()` | forget `remember: 'session'` grants |
| `messages({ beforeId?, limit?, includeHidden? })` | stored history for UIs (pages past hidden messages until `limit` visible ones) |
| `stats()` | `ContextStats` + `pending` + `activeTurn` |
| `events()` | long-lived stream of `SessionEvent`s |
| `idle()` | resolves when no turn runs and nothing is queued (nor a `collect` burst or inbox drain pending) |
| `ready()`, `close()`, `running`, `id` | open now (configuration errors as exceptions), close, state |

`SendOptions`: `ifBusy` (`'reject'` default; `'queue'`, `'steer'` for `send`; `'collect'` for
`send`: merge a burst into one queued turn, debounced by `collect: { quietMs: 1_500, maxWaitMs:
10_000, maxItems: 20 }`; `'wait'` for `send` and `respond`: wait for the running turn and the
queue, then run), `collect`, `model`,
`settings`, `options` (validated by `callOptions`), `maxSteps`, `abortSignal`, `runtime`,
`toolsContext`, `output` (`{ schema, mode?: 'tool' | 'native', maxRetries?, toolName?,
description? }`: a typed, validated final answer in `result.output` —
[structured output](structured-output.md)), and (0.5.0, server code) `clientTools`,
`clientToolsOptions`, `pageContext`, `pageContextOptions` — [frontend tools](client-tools.md). Every turn operation returns a `HarnessRun`: `turnId`, `kind`, `messageId`
(promise), `stream` (AI SDK UI message stream, single consumer), `result` (never rejects),
`abort()`, `toResponse()`, `pipeTo(res)`. The stream ends only after the turn finalized: a client
that saw `finish` can send again at once (unless a queued or other turn started meanwhile). `handleChatRequest(session, body, options?)` maps a
`useChat` request (`ChatRequestBody`) to `send` / `respond` / `regenerate` / `edit`; `options` are
`SendOptions` plus `actor` (given to `approval.decided` for approval answers) and the opt-ins
`clientTools: false | ClientToolsOptions` / `pageContext: false | PageContextOptions` (0.5.0; default
`false`: `body.clientTools` / `body.pageContext` are ignored). It never lets a browser answer an
external wait. It never throws
`EH_SESSION_BUSY`: a busy session returns a failed run whose `toResponse()` answers **409**
`{ error: { code, message } }`.

`SessionEvent`s (`session.events()`): `turn-start`, `turn-end`, `pending`, `input-dropped`,
`message`, `data`, `status`, `wait-resolved` (0.5.0: `waitId`, `by: 'result' \| 'timeout' \|
'cancel'`, in the process that recorded or cancelled the wait), and with an inbox (0.4.0)
`inbox-enqueued` (`inboxId`, `kind`, `mode?`, in the enqueuing process) and `inbox-drained`
(`inboxIds`, `turnId?`, in the draining process); with `inbox.retry` (0.5.0) `inbox-dead`
(`inboxId`, `kind`, `reason`, `attempts`).

File tools (`eharness/filesystem`): `read_file` takes `{ path, offset?, limit?, charOffset? }` —
`charOffset` continues a very long line (the cut line's hint names it); `grep` accepts only a
conservative safe subset of regular expressions (at most one variable-width quantifier — `*`,
`+`, `?`, `{n,m}` — in the whole pattern, no quantified groups, no backreferences or lookarounds;
e.g. `.*foo.*bar` and `(\d+\.)+\d+` are refused), matches the first 2 000 characters of a line, and names `charOffset=<c>` of a match
beyond the shown 300 characters.

## Turn results and stop reasons

`TurnResult`: `turnId`, `kind`, `messageId?`, `stop`, `pending?`, `messages`, `usage`
(`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens?`, `cacheWriteTokens?`,
`costUsd?`), `steps`, `durationMs`, `error?` (`{ code?, message, details? }`), `output?` (the
validated final answer of a turn with `SendOptions.output`, typed from the schema).

| `stop` | Meaning |
|---|---|
| `complete` | the model answered without tool calls |
| `tool-pending` | waiting for `respond()`, or (0.5.0) for `resolveWait()` / a timeout of an external wait or a request-declared client tool |
| `max-steps` | step budget used up (after the wrap-up step) |
| `stuck` | the progress guard stopped a repeating or failing turn |
| `context-thrash` | the context filled up again right after a compaction (`compaction.thrash`) |
| `cost-cap` | `loop.maxTurnOutputTokens` exceeded, a USD budget used up, or a `budget.ledger` reservation refused (`W_BUDGET` with `details.scope: 'ledger'`; 0.5.0 adds no stop reason) |
| `output-invalid` | `SendOptions.output`: no valid final answer within `maxRetries` retries |
| `length`, `content-filter` | provider finish reasons |
| `error` | provider, stream, storage or overflow error (`error.code`, e.g. `EH_CONTEXT_OVERFLOW`) |
| `aborted`, `timeout`, `blocked`, `interrupted` | abort, time limit, `input.submit` block, crashed process |
| `plugin:<name>:<reason>` | a `step.end` hook stopped the turn |

## Hooks

Registered by plugins (`definePlugin({ setup: () => ({ hooks }) })`, spec 01 §5), run in plugin
order (root first); "chainable" hooks receive the previous result.

| Hook | When | May return |
|---|---|---|
| `session.start`, `session.close` | live session opened / closed | — |
| `input.submit` | every user input before it is saved | `{ message }`, `{ block }`, `{ context }` (**stored** as extra text parts) |
| `turn.prepare` | before the turn's model call setup | `{ model?, settings?, activeTools? }` |
| `turn.start`, `turn.end` | committed turn started / finished (`TurnResult`) | — |
| `turn.beforeEnd` | the turn would stop `complete` / `max-steps` / `length` | `{ continue: { reason } }`, `{ extendSteps }` |
| `step.prepare` | before every model call | `{ model?, settings?, activeTools?, toolChoice?, reminder?, providerOptions?, messages? }` (`reminder`: not stored) |
| `step.end` | after every step | `{ stop }` (→ `plugin:<name>:<stop>`), `{ context }` (**stored** as `data-eh.input`) |
| `tool.approve` | before a call runs; the event has `toolName`, `toolCallId`, `input`, `toolMetadata?`, `risk?`, `idempotent?`, `hints?` and `transcript()` (0.5.0: a lazy, restricted view of user messages and tool calls, for judges) | an approval status (most restrictive wins) |
| `approval.decided` | every approval decision (audit) | — |
| `tool.before`, `tool.after` | around `execute` | `{ input }` / `{ output }` |
| `message.beforeSave` | before `MessageAdapter.save` | a message (same id/role) |
| `compaction.before` (0.4.0) | once per compaction, before the summarizer (`messages`, `tokens`, `trigger: 'turn' \| 'auto' \| 'manual' \| 'overflow'`) | `{ flush: { prompt, tools?, maxSteps? = 3, model? } }` — a pre-compaction flush ([compaction](compaction.md#saving-facts-before-summarizing)) |
| `compaction.prompt` | building the summarizer prompt (`out.messages`) | mutate `out.context` / `out.prompt` |
| `compaction.after` | a marker was stored (`{ marker }`) | — |
| `skill.load` | `load_skill` loaded a document (`skill`, `source`, `location?`, `version?`) | `{ skill?, notes? }` |

## Errors

Thrown `HarnessError`s (`isHarnessError(e, code)`) are programmer or configuration errors: boot
conflicts (`EH_CONFIG_INVALID`, `EH_DUPLICATE_TOOL`, `EH_DUPLICATE_SKILL`,
`EH_DUPLICATE_DATA_PART`, `EH_SERVICE_CONFLICT`, `EH_SERVICE_MISSING`, `EH_PLUGIN_ORDER`) and
misuse. Duplicates involving a plugin's `session()` contributions are found when the session
opens (`session.ready()` throws them; otherwise the first turn fails with them), not at boot.
Out-of-range numeric options (`loop.maxSteps: 0`, `compaction.summarizeAt: 1.2`, negative
budgets, …) are `EH_CONFIG_INVALID` at `defineHarnessAgent` (0.4.0). Turn operations throw only `EH_SESSION_BUSY` and `EH_SESSION_CLOSED`; everything else is a
run error in `run.result.error` (`EH_INVALID_INPUT`, `EH_PENDING_RESPONSE`, `EH_INVALID_MESSAGE`,
`EH_STORAGE`, `EH_CONTEXT_OVERFLOW`, …). `session.compact()` may throw `EH_COMPACTION_FAILED`.

```ts
import { isHarnessError } from 'eharness'

try {
  await session.ready() // surfaces configuration errors (missing services, bad MCP config, …)
  const result = await session.send('Hi').result
  if (result.stop === 'error') console.error(result.error?.code, result.error?.message)
} catch (error) {
  if (isHarnessError(error, 'EH_SESSION_BUSY')) console.log('a turn is already running')
  else throw error
}
```

A tool that throws becomes a tool error result wrapped as `HarnessToolError` (`toolName`,
`toolCallId`, same message) — the turn continues. `eh.notice` messages carry
`EH_TURN_INTERRUPTED`, `EH_INPUT_BLOCKED`, `EH_TURN_TIMEOUT` and `EH_CONTEXT_THRASH`
(`HarnessNoticeCode`).

## Warnings

Non-fatal problems go to `onWarning` (`HarnessWarning`: `code`, `message`, `details?`), to the turn
stream as transient `data-eh.warning` parts, and to `session.events()` outside a turn. Plugins emit
their own with `ctx.warn()`. Codes (`WarningCode`, spec 10 §2):

| Area | Codes |
|---|---|
| Loop and cost | `W_LOOP_STUCK`, `W_CONTINUE_LIMIT`, `W_BUDGET` (`details.scope`: `'turn'`, `'session'`, `'ledger'`), `W_MODEL_UNPRICED`, `W_BUDGET_LEDGER_FAILED` (0.5.0, `budget.ledger.onError: 'continue'`), `W_OUTPUT_INVALID` |
| Context | `W_DEFAULT_CONTEXT_WINDOW`, `W_COMPACTION_FAILED`, `W_COMPACTION_FLUSH_SKIPPED`, `W_CONTEXT_TRUNCATED`, `W_OVERFLOW_RETRY`, `W_CONTEXT_THRASH`, `W_CACHE_BUST` (also `details.reason: 'client-tools'`, 0.5.0), `W_PAGE_CONTEXT_LIMITED` (0.5.0) |
| Tools and sources | `W_SHADOWED`, `W_TOOL_SOURCE_FAILED`, `W_INVALID_TOOL_NAME`, `W_MCP_DRIFT`, `W_TOOL_OUTPUT_LIMITED`, `W_GRANT_IGNORED` |
| Skills | `W_INVALID_SKILL`, `W_SKILL_SOURCE_FAILED` |
| Messages and parts | `W_INVALID_MESSAGE`, `W_UNKNOWN_DATA_PART`, `W_UNKNOWN_STORED_PART`, `W_WRITE_OUTSIDE_TURN`, `W_TRANSIENT_OVERRIDE` |
| API use | `W_HOOK_FAILED`, `W_DEPRECATED`, `W_SESSION_OPTIONS_IGNORED` |
| Sessions | `W_ABORT_UNSUPPORTED`, `W_INBOX_FAILED` (operations incl. `deadLetter`, 0.5.0), `W_INBOX_DEAD_LETTER` (0.5.0) |
| Plugins | `W_GUARD_UNAVAILABLE` (0.5.0, `eharness/guard`: the judge failed and the call went to a person) |

## Request-scoped client tools and page context (0.5.0)

Spec 11 §7.1, [guide](client-tools.md). Everything in the request is untrusted.

| Option | Default | Notes |
|---|---|---|
| `ClientToolsOptions.allow` | every valid name | `string[]` or `(declaration) => boolean` |
| `ClientToolsOptions.maxTools` | 16 | more is rejected (all or nothing) |
| `ClientToolsOptions.maxSchemaBytes` | 8 192 | per declared input schema (in-document `$ref` only) |
| `ClientToolsOptions.timeoutMs` | none | a pending call gets `waitId`, `timeoutAt`, `onTimeout` and expires through the external-wait machinery |
| `ClientToolsOptions.onTimeout` | `{ errorText: CLIENT_TOOL_TIMED_OUT }` | `WaitTimeoutResult` |
| `PageContextOptions.maxChars` | 4 000 | all entries together; cut with `W_PAGE_CONTEXT_LIMITED`; at most 32 entries, labels 200 characters |

A declaration is `{ name, description?, inputSchema }` (`ClientToolDeclaration`); a page context
entry is `{ description, value }` (`PageContextEntry`). Failures are `EH_INVALID_INPUT` with
`details.reason` `'client-tools'`, `'page-context'` or `'request-context-with-steer-or-collect'`.
Request tools have risk `unknown`, sit after `tool_search` and before the output tool, sorted by
name; a changed set raises `W_CACHE_BUST` once per turn.

## External waits (0.5.0)

Spec 11 §4.2, [guide](external-waits.md).

```text
externalTool({ description, inputSchema, outputSchema?, start?, timeoutMs?, onTimeout?, metadata? })
  start(input, { waitId, toolCallId, ctx, abortSignal }) → { correlationId?, payload?, timeoutMs?, timeoutAt?, onTimeout? } | void
  onTimeout: { output } | { errorText }       // default { errorText: WAIT_TIMED_OUT }
```

`waitId` is `w_<toolCallId>`. The turn stops `'tool-pending'` with `pending.externals[]`
(`PendingExternal`: `waitId`, `toolCallId`, `toolName`, `correlationId?`, `payload?`,
`timeoutAt?`, `onTimeout`, `result?`). Timeouts run through a timer in the holding process, a
durable inbox item of kind `wait-timeout` (with `availableAt`) or `session.expireWaits()`; all
use the same compare-and-set as `resolveWait()`. New input with `approval.onNewInput: 'deny'`
answers open waits with `WAIT_CANCELLED_NEW_INPUT`. Types: `ExternalToolDef`, `WaitStart`,
`WaitStartEvent`, `ResolveWaitResult`, `PendingExternal`, `WaitResult`, `WaitTimeoutResult`.

## Tool risk and traits (0.5.0)

`ToolRisk` is `'read' | 'write' | 'destructive' | 'external'` (`'unknown'` when none; spec 11
§3.2). `toolTraits(metadata)` returns `{ risk?, idempotent?, hints? }` (`ToolTraits`,
`ToolHints`). App metadata (`tool({ metadata: { risk, idempotent } })`, `mcpServer({ risk })`)
wins and may be lower than the hints; MCP hints only tighten: `destructiveHint: true` gives
`'destructive'`, else `openWorldHint: true` gives `'external'`; `readOnlyHint` and
`idempotentHint` never lower anything and no MCP spec defaults are applied. `mcpServer({ risk })`
takes a `ToolRisk` or a `McpRiskFunction` per server tool. `ApprovalDecision` and
`PendingState.approvals[]` carry `risk` and `idempotent?`. Route with
`approval.risk: { external: 'user-approval' }` ([approvals](approvals-and-interaction.md)).

## Persisted additions in 0.5.0

| Where | Field | Meaning |
|---|---|---|
| `PendingState` | `v: 2` | written by 0.5 on every pending state; no `v` is the 0.3 / 0.4 shape (still works); an unknown `v` authorizes nothing |
| `PendingState` | `externals?` | the parked external waits (`PendingExternal`) |
| `PendingState.clientTools[]` | `waitId?`, `timeoutAt?`, `onTimeout?`, `result?` | timed request-declared client calls (recorded through the wait machinery) |
| `PendingState.approvals[]` | `idempotent?` | trait of the tool, when known |
| inbox item | kind `wait-timeout`, `availableAt?`, `lastError?` | durable timers (every `InboxItemInput` member may carry `availableAt`); `lastError` is set by failed attempts |
| plugin state `guard` | `verdicts`, `calls`, `denials` | the guard's per-session verdict cache, its answer per tool call id and the consecutive-denial counter (all bounded) |
| kind message | `group.message` (`model: 'omit'`) | a gated-out group message; `metadata.group` on user messages carries the speaker |

## Persisted additions in 0.4.0

| Where | Field | Meaning |
|---|---|---|
| core kind | `eh.flush` (`FlushPayload`) | model-invisible audit record of a pre-compaction flush: `trigger`, `prompt`, `model?`, `steps`, `toolCalls` (`toolName`, `status`), `usage`, `costUsd?`, `error?`; stored before the marker. Also streamed once as a transient `data-eh.flush` part |
| `metadata.eharness` | `inboxId`, `collected` | the inbox item a user message came from; the inputs merged by `collect` |
| `data-eh.input` | `inboxId` | a steer delivered through the inbox |
| `state.core` | `abortRequest` | cross-process abort request for the active turn (`turnId`, `at`, `reason?`, `by?`) — the one field another instance may write during a turn |
| `state.core` | `inboxDelivered` | ids of the last 100 `wake` inbox items applied (dedupe; send items and steers are deduped by their stored `inboxId`) |
| `ContextStats` | `pruned?: { outputs, chars }` | tool outputs replaced by the prune stage in the current request |
| assistant message part | `data-eh.output` (`OutputPartData`) | the validated structured answer `{ value, mode, attempts }` (id `output`, never sent to the model); `value` equals `TurnResult.output` |
| `metadata.eharness` | `output` | `{ ok, attempts }` on every turn with `SendOptions.output` (`ok: false` when no valid answer was stored) |
| `SkillMeta` / `Skill` / `SkillDoc` | `version?` | from `SKILL.md` frontmatter `version:`; shown by `load_skill`, never in the index |
| usage `source` | `'compaction'`, `'compaction-flush'` | summarizer and flush usage, charged to the turn and budgets |

## Fixed texts

Model- or UI-visible texts the core writes, exported so apps and tests can match them (changing
one is a minor change): `INTERRUPTED_TURN`, `INTERRUPTED_CRASH`, `INTERRUPTED_UNKNOWN` (results of
tool calls that never finished), `DENIED_NEW_INPUT`, `NOT_EXECUTED_NEW_INPUT` (pending calls
answered by new input), `PROGRESS_NUDGE`, `MAX_STEPS_WRAP_UP` (step reminders),
`TOOL_OUTPUT_TRUNCATED` (truncation marker), `TOOL_OUTPUT_PRUNED` (placeholder of a pruned tool
output), `FLUSH_APPROVAL_DENIED` (denial reason of approval-gated calls in a pre-compaction flush), `FILE_UNAVAILABLE` (a file of an earlier turn that
can no longer be downloaded), `FINAL_ANSWER_DESCRIPTION`, `FINAL_ANSWER_RECORDED`,
`OUTPUT_INSTRUCTION`, `OUTPUT_RETRY` (structured output), and (0.5.0) `WAIT_TIMED_OUT`,
`WAIT_CANCELLED_NEW_INPUT` (external waits), `CLIENT_TOOL_TIMED_OUT` (request-declared client
tools) and `PAGE_CONTEXT_PREAMBLE` (the framing of page context). `eharness/guard` exports
`GUARD_PROMPT`, `GUARD_INSTRUCTIONS`, `GUARD_DEFAULT_POLICY`, `GUARD_DENIED`, `GUARD_ASK`,
`GUARD_BREAKER`, `GUARD_UNAVAILABLE` and `GUARD_TRUNCATED`; `eharness/group` exports
`GROUP_HISTORY_PREAMBLE` and `GROUP_SPEAKER_PREFIX`. `eharness/todos` exports its own
(`TODOS_*`), `eharness/memory` exports `MEMORY_PROTOCOL`, `PINNED_PREAMBLE` and
`MEMORY_FLUSH_PROMPT` (with `MEMORY_TOOLS`, `MEMORY_FLUSH_TOOLS`, `DEFAULT_MAX_FILE_CHARS`,
`DEFAULT_MAX_PINNED_CHARS` and `executeMemoryCommand()` for an app-supplied memory tool).

## Other exports

- Types (0.4.0): `PruneConfig`, `CompactionBeforeEvent`, `CompactionBeforePatch`, `FlushPayload`,
  `AbortRequest`, `AbortRequestResult`, `InboxAdapter`, `InboxItem`, `InboxItemInput`,
  `SerializedInput`, `CollectOptions`, `EnqueueOptions`, `EnqueueResult`, `InputFilesConfig`,
  `ToolErrorTextFn`, `ChatRequestOptions`, `OutputSpec` (the `SendOptions.output` value),
  `SendOptionsWithOutput` (`SendOptions` with a required `output`, used by the typed overloads).
- Types (0.5.0): `ToolTraits`, `ToolHints`, `ClientToolDeclaration`, `ClientToolsOptions`,
  `PageContextEntry`, `PageContextOptions`, `PendingClientTool`, `PendingExternal`, `WaitResult`,
  `WaitTimeoutResult`, `ResolveWaitResult`, `ExternalToolDef`, `WaitStart`, `WaitStartEvent`,
  `DeadInboxItem`, `InboxReleaseOptions`, `InboxStats`, `InboxRetryOptions`,
  `InboxBackoffOptions`, `GuardTranscriptEntry`; helper `neutralizeTags(text, tags)` (frames
  untrusted text as data; shared by memory, group and page context).
- Storage (`eharness/storage/memory`): `memoryMessages()`, `memoryState()`, `memoryInbox()`,
  `memoryBudgetLedger({ limits })` (0.5.0).
- Testing (`eharness/testing`): `scriptedModel()`, `messageAdapterConformance()`,
  `stateAdapterConformance()`, `inboxAdapterConformance()` (0.4.0; 0.5.0 options `requireRetry`,
  `requireDeadLetter`, `requireStats`), `fileSystemConformance()`
  (`requireMove`), `skillSourceConformance()` (`version`), `idGeneratorConformance()`,
  `budgetLedgerConformance()` (0.5.0).
- Messages: `uuidv7()`, `isUuidV7()`, `createKindMessage()`, `isKindMessage()`,
  `defineMessageKind()`, `defineDataPart()`, types `HarnessUIMessage`, `HarnessMetadata`
  (`metadata.eharness`: `createdAt`, `kind`, `turnId`, `model`, `usage`, `stop`, `steps`,
  `durationMs`, `pending`, `error`, `output`, …), `DataChunk`, `OutputPartData` (the
  `data-eh.output` part).
- Skills: `defineSkill()`, `defineSkillSource()`, `parseSkillMarkdown()`, `validateSkillPath()`.
- Models: `modelsDevCatalog()`, `lookupModel()`, `computeCost()`, `estimateStepCostUsd()` (0.5.0);
  budget ledger types `BudgetLedger`, `BudgetLedgerConfig`, `BudgetReservation`,
  `BudgetScopeStatus`, `BudgetEstimateEvent`.
- `version`: the package version of the build.

## Shipped plugins

| Import | Plugin | Options (defaults) | Model-visible |
|---|---|---|---|
| `eharness/filesystem` | `filesystem({ fs, … })` | spec 08 §2 | `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `grep`, `glob` |
| `eharness/todos` | `todos()` | `enforce` (false), `maxNudges` (3), `remindEvery` (5), `maxItems` (50) | `todo_write` |
| `eharness/memory` | `memory({ roots })` | `pinned`, `maxPinnedChars` (2_000), `maxFileChars` (20_000), `protocol` (`MEMORY_PROTOCOL`), `tool`, `onWrite`, `flushOnCompaction` (false) | `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`, `memory_rename` (or the app's `memory` tool) |
| `eharness/guard` | `approvalGuard({ model, … })` | `policy` (`GUARD_DEFAULT_POLICY`), `skipRisks` (`['read']`), `skipTools`, `onlyTools`, `transcript` (`{ maxMessages: 20, maxChars: 12_000 }`), `timeoutMs` (15 000), `maxRetries` (1), `maxConsecutiveDenials` (3; `Infinity` = off), `cache` (`{ maxEntries: 200, ttlMs? }`) | none (a `tool.approve` hook; helpers `canonicalJson()`, `verdictKey()`) |
| `eharness/group` | `groupChat({ botId, … })`, `routeGroupMessage(group, session, message, options?)` | `botName`, `requireMention` (true), `mentionPatterns`, `replyCountsAsMention` (true), `historyLimit` (20), `maxBotTurns` (`{ count: 3, windowMs: 60_000 }`), `allowBots` (false), `shouldRespond`, `formatSpeaker` | none (kind `group.message`, `metadata.group`) |
| `eharness/openapi` | `openApiTools(spec, { name, baseUrl, … })` (a tool source) | `headers`, `include`, `exclude`, `names`, `prefix` (`<name>_`), `risk` (`riskFromMethod`), `maxTools` (64), `defer` (`'auto'`: above 20), `timeoutMs` (30 000), `maxResponseChars` (50 000), `schema`, `useSpecServers` (false), `fetch` | one tool per selected operation; input `{ path?, query?, headers?, body? }` |
| `eharness/filesystem/node` (Node-only) | `diskFs(root, opts?)`, `mountFs(mounts)`, `nodeWorkspace(opts)`, `nodeCheckpointStore(opts)`, `compileIgnore()` | `diskFs`: `maxFileBytes`, `maxBinaryBytes`, `.gitignore` subset; spec 08 §8 | none (a `FileSystem` for `filesystem()`) |
| `eharness/shell` (Node-only) | `shell({ sandbox, … })`, `localSandbox(root, opts?)` | `timeoutMs` (120 000), `maxTimeoutMs` (600 000), `maxOutputChars` (30 000), `background` (false), `onTaskEvent`, `toolName` (`bash`), `risk` (`'external'`); sandbox `os`, `env`, `shell` | `bash`, with `background`: `bash_output`, `kill_shell`; service `shellTasks`, part `data-shell.output` |
| `eharness/permissions` | `permissionsPlugin({ engine })`, `createPermissionEngine({ roots, … })` | `mode` (`'default'`), `rules`, `protectedPaths` (`['.git']`), `builtinAsk`, `readOnlyCommands`, `toolKinds`, `aliases`, `modeCycle`, `persist` | none (a `tool.approve` hook, plan mode, output filter) |
| `eharness/subagent` | `subagents({ agents, approvals, … })`, `subagentChild({ parent })`, `reconcileSubagentWaits()` | `toolName` (`agent`), `maxDepth` (2), `maxConcurrent` (8), `background` (false), `answer`, `policy` (`'deny'`), `timeoutMs`, `selfAgent`, `parentAgent`, `onParentRun` | `agent` (`subagent_type`, `description`, `prompt`); part `data-subagent.run` |
| `eharness/ask` | `askUser(options?)`, `pendingQuestions()`, `answerOutput()` | `toolName`, `maxQuestions` (4), `interactive` (true), `whenNoHuman` (`'dismiss'`) | `ask_user_question` (a client tool, or executed with `interactive: false`) |
| `eharness/web` | `webFetch(options?)`, `webSearch({ search, … })` | `webFetch`: `allow`, `deny`, `onlyAllowed`, `maxBytes` (5 MiB), `maxChars` (30 000), `timeoutMs` (15 000), `maxRedirects` (5), `toMarkdown`, `resolveHost`, `fetch` | `web_fetch`, `web_search` (risk `'external'`) |

`riskFromMethod(method)`: `GET`, `HEAD`, `OPTIONS` give `'read'`, `DELETE` gives `'destructive'`,
the rest `'write'`. Guides: [guard](guard.md), [group chat](group-chat.md),
[OpenAPI tools](openapi-tools.md), [shell](shell.md), [permissions](permissions.md),
[subagents](subagents.md), [ask](ask.md), [web](web.md).

`FileSystem.move` is optional (atomic rename → `MoveResult`; `memoryFs` implements it,
`fileSystemConformance` checks it with `requireMove`).

Patterns that combine these (ephemeral context, episodic memory, background events, heartbeats,
several instances, security): [production patterns](production-patterns.md).
