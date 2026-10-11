# Reference

Every option and method at a glance, with defaults and the guide or spec that explains it. The
specs in [`../specs`](../specs) are the full contracts.

## `defineHarnessAgent(config)`

| Option | Default | Notes |
|---|---|---|
| `model` | required | AI Gateway string or AI SDK `LanguageModel` |
| `id` | `'agent'` | used in logs and telemetry |
| `contextWindow` | from `models`, else 128 000 (`W_DEFAULT_CONTEXT_WINDOW`) | number or `(model) => number \| undefined` — [compaction](compaction.md) |
| `models` | none | `ModelCatalog`: record keyed by model id, or function — [models and cost](models-and-cost.md) |
| `budget` | none | `{ maxTurnUsd?, maxSessionUsd?, warnAt? = 0.8, ledger? }` → `'cost-cap'` — [models and cost](models-and-cost.md#budgets); `ledger: { adapter, scopes, estimate?, reservationTtlMs?, onError? = 'stop' }` — [budgets across sessions](models-and-cost.md#budgets-across-sessions) |
| `instructions` | none | string, `{ text, id? }`, function, or `{ text: fn, refresh: 'session' \| 'turn' }` — [tools and MCP](tools-and-mcp.md#instructions) |
| `tools` | none | record of `Tool` / `(ctx) => Tool`, a `ToolSource`, or an array of both |
| `skills` | none | `defineSkill(…)` / `defineSkillSource(…)` — [skills](skills.md) |
| `mcp` | none | `mcpServerSource(…)` sources (same as putting them into `tools`) |
| `dataParts`, `messageKinds` | none | app parts `data-<key>` and kinds — [rendering data parts](rendering-data-parts.md) |
| `plugins` | `[]` | `definePlugin(…)` values, in order — [writing a plugin](writing-a-plugin.md) |
| `storage` | memory adapters, no inbox, no stream log | `{ messages?: MessageAdapter; state?: StateAdapter; inbox?: InboxAdapter; streams?: StreamLogAdapter }`: [storage adapters](writing-a-storage-adapter.md), [several instances](multi-instance.md) |
| `streams` | `{ flushMs: 100, batchSize: 64, retentionMs: 600_000, pollMs: 500 }` | stream log behaviour (needs `storage.streams`): chunks wait at most `flushMs` / `batchSize` for an append, `retentionMs` is passed to `expire` after the turn closed, `pollMs` is how often `attachRemote` reads when the adapter has no `subscribe` (spec 04 §6.2) |
| `inbox` | `{ pollMs: 2_000, claimTtlMs: recovery.staleMs, collect: { quietMs: 1_500, maxWaitMs: 10_000, maxItems: 20 } }` | durable inbox drain (`pollMs: 0` = notifications only) and the `collect` debounce (also without an inbox) — [several instances](multi-instance.md) |
| `inbox.retry` | off (unlimited redelivery) | `{ maxAttempts?, backoff?: { type?: 'fixed' \| 'exponential' = 'exponential', delayMs? = 1_000, maxDelayMs? = 60_000, jitter? = true }, nonRetryable? = EH_INVALID_INPUT }`: attempts are counted at claim; an item past `maxAttempts` or failing non-retryably is dead-lettered — [poison items](multi-instance.md#poison-items) |
| `inbox.onDeadLetter` | none | `(item: DeadInboxItem) => void \| Promise<void>`, called after the adapter stored the dead item; a throw is `W_HOOK_FAILED` |
| `toolOrder` | default order | final tool names that go first, in that order; unknown names warn once per session (`W_TOOL_ORDER`); keep it stable (prompt cache) — [tools and MCP](tools-and-mcp.md) |
| `deferTools` | none | tool names (app, plugin or source tools) hidden until the model finds them with `tool_search`; the turn reminder lists them by name — [tools and MCP](tools-and-mcp.md) |
| `compaction` | `{ summarizeAt: 0.75, keepLast: 4, maxSummaryTokens: 4_000 }` | or `false` — [compaction](compaction.md) |
| `compaction.prune` | off | `{}` = `{ keepTurns: 2, minChars: 2_000 }`; `exclude`, `replaceWith` — view-only pruning of old tool outputs ([compaction](compaction.md#pruning-old-tool-outputs)) |
| `compaction.thrash` | `{ withinSteps: 2 }` | or `false` — stop `'context-thrash'` when a second compaction within the window cannot get below `summarizeAt` ([compaction](compaction.md#when-a-turn-thrashes)) |
| `guard` | `{ maxContextRatio: 0.9 }` | the context guard (spec 06 §6); `reserveTokens` default: `settings.maxOutputTokens` ?? 8% of the window |
| `isContextOverflow` | built-in patterns | extra "context too long" detection |
| `loop` | see below | [long-running turns](long-running-turns.md) |
| `settings` | `{ maxRetries: 2, timeout: { firstChunkMs: 120_000, chunkMs: 120_000 } }` | `streamText` settings: `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `reasoning`, `maxRetries`, `headers`, `providerOptions`, `timeout`, `streamRetries`. `timeout` is per step: a number means `stepMs`, `totalMs` is rejected (use `loop.turnTimeoutMs`), keys you set override the default per key, `false` turns the idle timeouts off |
| `hooks` | `{ timeoutMs: 30_000 }` | an awaited plugin hook that does not settle counts as throwing (`W_HOOK_TIMEOUT`; `input.submit` still blocks, `tool.approve` still denies); a turn abort cuts hooks short |
| `toolSources` | `{ timeoutMs: 30_000, retryAfterMs: 5_000 }` | a source `list()` that does not settle fails (`W_TOOL_SOURCE_FAILED`); a failed source is not asked again for `retryAfterMs`, doubling per consecutive failure up to 60 000 (`0` retries at the next turn). Sources are listed concurrently |
| `approval` | `{ onNewInput: 'deny' }` | `policy`, `risk`, `secret`, `onNewInput` — [approvals](approvals-and-interaction.md) |
| `cache` | `{ mode: 'auto' }` | `{ mode?: 'auto' \| 'breakpoints'; ttl?: '5m' \| '1h' }` or `false`; Anthropic models only |
| `toolOutput` | `{ maxChars: 50_000, strategy: 'truncate' }` | plus `perTool` — [tools and MCP](tools-and-mcp.md#tool-output-limits) |
| `toolErrorText` | `String(error)` | `(error, { toolName, toolCallId }) => string`: the text of a thrown tool error in UI, storage and wire (hide secrets) — [tools and MCP](tools-and-mcp.md#tools) |
| `inputFiles` | `{ protocols: ['data:', 'https:'], maxBytes: 20 971 520 }` | allowed file URL protocols of user input and the decoded `data:` URL cap; others are `EH_INVALID_INPUT`. `resolve(url, { sessionId, mediaType, filename? })` maps a stored file reference (a custom protocol listed in `protocols`) to `{ data }` or `{ url }` at projection time; the stored message never changes |
| `callOptions` | none | schema for `SendOptions.options` → `ctx.turn.options` |
| `repairToolCall` | none | AI SDK `repairToolCall` |
| `recovery` | `{ staleMs: 120_000, abortPollMs: 2_000, instanceId: random per process }` | crash recovery of turns whose process died, and the poll for aborts requested by another instance (`abortPollMs: 0` = off); `false` disables both. Keep `staleMs` ≥ 1 000. A **stable** `instanceId` (unique among live instances of one storage) lets a restarted process recover its own turns at once (`session.recover()` at boot) instead of after `staleMs` |
| `telemetry` | none | AI SDK telemetry options |
| `observe` | none | `(event) => void`: phase durations (`span`) and counters (`count`) for metrics/tracing, called synchronously, zero cost when unset, a throw is ignored ([guide](observability.md), spec 10 §8) |
| `warnings` | `{ dedupeWindowMs: 60_000 }` | the default warning handler prints a code + key once per window and counts suppressed repeats; `0` = every occurrence, at most 86 400 000 |
| `debug` | `{ invariants: false }` | `invariants: true` throws `EH_INVALID_MESSAGE` for a message that fails AI SDK `UIMessage` validation at save (nothing is saved) and reports `W_INVARIANT_VIOLATION` for an inconsistent turn end; `false` warns (`W_INVALID_MESSAGE`) and saves anyway. Never inferred from `NODE_ENV`: enable it in your tests (spec 05 §15) |
| `strict` | `false` | misuse warnings throw `EH_CONFIG_INVALID` |
| `logger` | debug/info off, warn/error to console | `ctx.log`; the default prints errors as name, message, code, status and cause only |
| `onWarning` | `console.warn`, deduplicated per code + key within `warnings.dedupeWindowMs` | every `HarnessWarning` |
| `generateId` | `uuidv7` | must produce time-sortable ids (`idGeneratorConformance`) |
| `skillsIndexLimit` | 50 | above it, skills switch to `search_skills` |
| `sessionIdleMs` | 30 min | evict idle cached sessions; `0` = never |

`loop`: `maxSteps` 500 · `wrapUp` `true` · `progress` `{ repeats: 3, window: 20, errorStreak: 5,
toolErrorStreak: 8, nudges: 1, ignoreTools }` or `false` · `maxIdleContinues` 3 · `maxContinues` none ·
`maxTurnOutputTokens` none · `turnTimeoutMs` none · `persistEachStep` `true`.

**Validation.** Every numeric option is bounds-checked when the agent is defined: a wrong type or
range throws `EH_CONFIG_INVALID` naming the option (`details.option`). Rules: step, token and count
options are positive integers (`loop.maxSteps`, `compaction.maxSummaryTokens`,
`loop.progress.*` except `nudges`, `toolOutput.maxChars`, `inputFiles.maxBytes`,
`inbox.collect.maxItems`, `inbox.retry.maxAttempts` ≤ 1 000, `streams.batchSize` ≤ 10 000);
`compaction.summarizeAt` is in (0, 1); `guard.maxContextRatio` and `budget.warnAt` are in (0, 1];
budgets and `loop.maxTurnOutputTokens` are positive; every duration option is at most one day
(`hooks.timeoutMs`, `toolSources.*`, `recovery.*`, `streams.*`, `inbox.*`, `settings.timeout.*`,
`warnings.dedupeWindowMs`, `inbox.retry.backoff.*`; `sessionIdleMs` at most 30 days), and
`streams.flushMs` at most 60 s. `0` is valid only where a row says so (`abortPollMs`, `pollMs`,
`retryAfterMs`, `sessionIdleMs`, `turnTimeoutMs`, `dedupeWindowMs`).

The returned `HarnessAgent` has `id`, `config`, `session(id, options?)`, `peek(id, options?)` (a
side-effect-free read handle: messages, stats, busy, pending, children and parent; no turn
operations), `closeSession(id)` and `close()`. `InferHarnessUIMessage<typeof agent>` is its exact message type (for `useChat`).

## Sessions

`agent.session(id, options?)` — `SessionOptions`: `storage` (per-session adapters), `runtime`
(`ctx.runtime`), `toolsContext`, `lock` (`SessionLock`), `onInvalidMessage` (`'drop'` default,
`'keep'`, `'throw'`), `acceptClientMetadata` (default `false`), `parent` (subagents, depth ≤ 8).
Options passed to an already cached session are ignored (`W_SESSION_OPTIONS_IGNORED`).

| Method | Does |
|---|---|
| `send(input?, options?)` | start a turn (`string`, `{ text, files }` or a `UIMessage`; none = continue) |
| `respond({ approvals, toolOutputs, externals }, options?)` | answer pending approvals / client tools / external waits (`externals` is a trusted server call) and continue the same message |
| `regenerate({ messageId?, … })`, `edit({ messageId, input, ...options })` | answer again / replace a user message |
| `attach()` | replay and follow the running turn (`undefined` when idle) |
| `attachRemote({ from, signal })` | the same across instances through `storage.streams` (`undefined`: use the stored messages) |
| `abort(reason?)` | abort the running turn and drop queued turns; without a local turn, request the abort of a turn running in another instance; awaitable → `{ target: 'local' \| 'remote' \| 'idle' \| 'unsupported' }` ([long-running turns](long-running-turns.md#stopping-a-turn-from-another-instance)) |
| `inject(kind, data, { deliver?, wake? })` | store an event message; deliver it into the running turn or wake the agent (with an inbox, also the instance running the turn) |
| `enqueue(input, { mode?, collect?, availableAt?, id? })` | hand input to whichever instance holds the session → `{ inboxId, target: 'local' \| 'remote', duplicate? }`; `mode`: `'queue'` (default), `'steer'`, `'collect'`; `availableAt` (epoch ms) is a durable timer, `id` an idempotency key per session ([several instances](multi-instance.md), [routines](multi-instance.md#routines-on-the-inbox)) |
| `resolveWait(waitId, { output } \| { errorText }, options?)` | record the result of an external wait (validated against `outputSchema`, compare-and-set, first result wins) and continue the same assistant message when nothing is left open → `{ status: 'continued', run }` \| `{ status: 'recorded', remaining }` \| `'already-resolved'` \| `'not-pending'` ([external waits](external-waits.md)) |
| `expireWaits(now?)` | apply the `onTimeout` result of every due wait (sweepers) → `{ expired, run? }` |
| `pendingWaits()` | the stored external waits (`PendingExternal[]`) for UIs and sweepers |
| `recover()` | repair a turn whose process died (needs `recovery`; a stable `recovery.instanceId` recovers its own turns at once) → `RecoverResult`: `{ recovered: true, turnId, messageId }` or `{ recovered: false, reason: 'idle' \| 'live' \| 'locked' \| 'lock-unavailable' \| 'disabled' }` |
| `busy()` | who is running a turn now (`SessionBusy`) or `null` |
| `compact(options?)` | manual compaction (idle only); `{ keepLast?, instructions? }` apply to this call only: `keepLast` overrides `compaction.keepLast` (`0` summarizes everything), `instructions` adds a focus line to the summarizer context |
| `fork(options?)` | new session from a prefix of the history (`beforeMessageId`, `id`, `runtime`, `copyState: 'all' \| 'none'`); returns its opened handle; `EH_SESSION_BUSY` while a turn runs |
| `children()`, `parentInfo()` | child sessions registered with this session as `parent` (`ChildSessionInfo[]`), and the stored parent link (`ParentInfo`) |
| `tools(options?)` | the tools of the next request in request order: `{ name, description?, inputSchema, source, deferred, tokens }` (`source`: `'app' \| 'core' \| 'plugin:<name>' \| 'source:<id>'`) |
| `onRun(listener)` | called synchronously whenever any turn of this session starts in this process (`send`, `respond`, queued turns, wakes); each listener gets its own `HarnessRun` |
| `clearGrants()` | forget `remember: 'session'` grants |
| `messages({ beforeId?, limit?, includeHidden? })` | stored history for UIs (pages past hidden messages until `limit` visible ones) |
| `stats()` | `ContextStats` + `pending` + `activeTurn` |
| `events()` | long-lived stream of `SessionEvent`s; a reader more than 1 000 events behind is closed (open a new one) |
| `idle()` | resolves when no turn runs and nothing is queued (nor a `collect` burst or inbox drain pending) |
| `ready()`, `close()`, `running`, `id` | open now (configuration errors as exceptions), close, state |

`respond(…)`: `approvals: [{ id, approved, note? }]` — a note (max 4 000 characters) is read by the model after the tool result as `<user-note …>`; `endTurn: 'after-answers' \| 'if-denied'` records the answers and runs the approved tools without calling the model (the turn stops `'complete'` with `steps: 0`). `send(input, { ifBusy: 'steer' })` returns a run whose `delivery` promise resolves `'step' \| 'turn' \| 'dropped'` (`SteerDelivery`). Plugins call `ctx.session.inject(kind, data, { deliver?, wake? })` for the plugin's own session (tools, hooks, background work).

`SendOptions`: `ifBusy` (`'reject'` default; `'queue'`, `'steer'` for `send`; `'collect'` for
`send`: merge a burst into one queued turn, debounced by `collect: { quietMs: 1_500, maxWaitMs:
10_000, maxItems: 20 }`; `'wait'` for `send` and `respond`: wait for the running turn and the
queue, then run), `collect`, `model`,
`settings`, `options` (validated by `callOptions`), `maxSteps`, `abortSignal`, `runtime`,
`toolsContext`, `output` (`{ schema, mode?: 'tool' | 'native', maxRetries?, toolName?,
description? }`: a typed, validated final answer in `result.output` —
[structured output](structured-output.md)), and (server code) `clientTools`,
`clientToolsOptions`, `pageContext`, `pageContextOptions` — [frontend tools](client-tools.md). Every turn operation returns a `HarnessRun`: `turnId`, `kind`, `messageId`
(promise), `stream` (AI SDK UI message stream, single consumer), `result` (never rejects),
`abort()`, `toResponse()` (use this in routes), `toStreamResponse()` (stream only: a pre-commit failure stays inside a `200` stream), `pipeTo(res)`. The stream ends only after the turn finalized: a client
that saw `finish` can send again at once (unless a queued or other turn started meanwhile). `handleChatRequest(session, body, options?)` maps a
`useChat` request (`ChatRequestBody`) to `send` / `respond` / `regenerate` / `edit`; `options` are
`SendOptions` plus `actor` (given to `approval.decided` for approval answers) and the opt-ins
`clientTools: false | ClientToolsOptions` / `pageContext: false | PageContextOptions`. It never lets a browser answer an
external wait. It never throws
`EH_SESSION_BUSY`: a busy session returns a failed run whose `toResponse()` answers **409**
`{ error: { code, message } }`.

`SessionEvent`s (`session.events()`): `turn-start`, `turn-end`, `pending`, `input-dropped`,
`message`, `data`, `status`, `wait-resolved` (`waitId`, `by: 'result' \| 'timeout' \|
'cancel'`, in the process that recorded or cancelled the wait), and with an inbox
`inbox-enqueued` (`inboxId`, `kind`, `mode?`, in the enqueuing process) and `inbox-drained`
(`inboxIds`, `turnId?`, in the draining process); with `inbox.retry` `inbox-dead`
(`inboxId`, `kind`, `reason`, `attempts`).

File tools (`eharness/filesystem`): `read_file` takes `{ path, offset?, limit?, charOffset? }` —
`charOffset` continues a very long line (the cut line's hint names it); `grep` accepts only a
conservative safe subset of regular expressions (at most one variable-width quantifier — `*`,
`+`, `?`, `{n,m}` — in the whole pattern, no quantified groups, no backreferences or lookarounds;
e.g. `.*foo.*bar` and `(\d+\.)+\d+` are refused), matches the first 2 000 characters of a line, and names `charOffset=<c>` of a match
beyond the shown 300 characters.

## Which one do I use

**Chat entry points**

| You have | Use | Gives you |
|---|---|---|
| One chat route in your own framework (Next, Hono, Express, ...) | `await handleChatRequest(session, body, options).toResponse()` plus `handleResumeRequest(session, req)` for reconnects | The `useChat` protocol on the routes you write. Auth, ownership checks and every other route are yours. Pre-commit failures answer 409 / 400 / 503. |
| A whole server, or a browser using `eharness/client` | `createHarnessHttp()` from `eharness/http` | The full set of routes (chat, resume, interrupt, session reads, attention, activity) with auth and principals. Always uses the status form. |
| A script, a test, a CLI | `session.send()` and read `run.stream` / `await run.result` | No HTTP. `run.toStreamResponse()` exists for tests that want the raw stream. |

**Input while a turn is running**

| Call | What it does | Use it when |
|---|---|---|
| `send(input, { ifBusy })` | Starts a turn and returns its `HarnessRun`. While busy: `'reject'` (default, `EH_SESSION_BUSY`), `'queue'`, `'steer'`, `'wait'` or `'collect'`. | The user typed in this process and you want the run (stream, result). |
| `enqueue(input, { mode })` | Hands an input to whichever instance holds the session (durably with `storage.inbox`) and returns `{ inboxId }` without a run. `mode`: `'queue'` (default), `'steer'`, `'collect'`; also `availableAt` (timer), `id` (idempotency), `metadata`. | A server-side producer, a webhook, a scheduler, or another instance than the one running the turn. |
| `inject(kind, data, { deliver, wake })` | Saves a kind message (not a user message) and can deliver it at the next step or wake the agent. | Background work or a plugin reporting back to the model, for example a finished job. |

`ifBusy` and `mode` name the same three behaviors (`queue`, `steer`, `collect`); `ifBusy` also has
`reject` and `wait`, which only make sense when you hold the run.

## Turn results and stop reasons

`TurnResult`: `turnId`, `kind`, `messageId?`, `stop`, `pending?`, `messages`, `usage`
(`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens?`, `cacheWriteTokens?`,
`costUsd?`), `steps`, `durationMs`, `error?` (`{ code?, message, details? }`), `output?` (the
validated final answer of a turn with `SendOptions.output`, typed from the schema).

| `stop` | Meaning |
|---|---|
| `complete` | the model answered without tool calls |
| `tool-pending` | waiting for `respond()`, or for `resolveWait()` / a timeout of an external wait or a request-declared client tool |
| `max-steps` | step budget used up (after the wrap-up step) |
| `stuck` | the progress guard stopped a repeating or failing turn |
| `context-thrash` | the context filled up again right after a compaction (`compaction.thrash`) |
| `cost-cap` | `loop.maxTurnOutputTokens` exceeded, a USD budget used up, or a `budget.ledger` reservation refused (`W_BUDGET` with `details.scope: 'ledger'`) |
| `output-invalid` | `SendOptions.output`: no valid final answer within `maxRetries` retries |
| `length`, `content-filter` | provider finish reasons |
| `error` | provider, stream, storage or overflow error (`error.code`, always set: e.g. `EH_PROVIDER_AUTH`, `EH_CONTEXT_OVERFLOW`) |
| `aborted`, `timeout`, `blocked`, `interrupted` | abort, time limit, `input.submit` block, crashed process |
| `plugin:<name>:<reason>` | a `step.end` hook stopped the turn |

## Hooks

Registered by plugins (`definePlugin({ setup: () => ({ hooks }) })`, spec 01 §5), run in plugin
order (root first); "chainable" hooks receive the previous result.

| Hook | When | May return |
|---|---|---|
| `session.start`, `session.close` | live session opened / closed | — |
| `session.fork` | a session was forked (the new handle opens next) | — |
| `input.submit` | every user input before it is saved | `{ message }`, `{ block }`, `{ context }` (**stored** as extra text parts) |
| `turn.prepare` | before the turn's model call setup | `{ model?, settings?, activeTools? }` |
| `turn.start`, `turn.end` | committed turn started / finished (`TurnResult`) | — |
| `turn.beforeEnd` | the turn would stop `complete` / `max-steps` / `length` | `{ continue: { reason } }`, `{ extendSteps }` |
| `step.prepare` | before every model call | `{ model?, settings?, activeTools?, toolChoice?, reminder?, providerOptions?, messages? }` (`reminder`: not stored) |
| `model.call` | after every model call (step, compaction, flush, `ctx.observeModel`), observe-only | nothing |
| `step.end` | after every step | `{ stop }` (→ `plugin:<name>:<stop>`), `{ context }` (**stored** as `data-eh.input`) |
| `tool.approve` | before a call runs; the event has `toolName`, `toolCallId`, `input`, `toolMetadata?`, `risk?`, `idempotent?`, `hints?` and `transcript()` (a lazy, restricted view of user messages and tool calls, for judges) | an approval status (most restrictive wins) |
| `approval.decided` | every approval decision (audit) | — |
| `tool.grantScope` | `remember: 'session'` on an approval: what the grant covers | a narrower grant scope (a shell approval stores the tool plus the command prefix) |
| `tool.before`, `tool.after` | around `execute` | `{ input }` / `{ output }` |
| `message.beforeSave` | before `MessageAdapter.save` | a message (same id/role) |
| `message.saved` | after `MessageAdapter.save` succeeded, observe-only | — |
| `compaction.before` | once per compaction, before the summarizer (`messages`, `tokens`, `trigger: 'turn' \| 'auto' \| 'manual' \| 'overflow'`) | `{ flush: { prompt, tools?, maxSteps? = 3, model? } }` — a pre-compaction flush ([compaction](compaction.md#saving-facts-before-summarizing)) |
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
budgets, …) are `EH_CONFIG_INVALID` at `defineHarnessAgent` (see Validation above). Turn operations throw only `EH_SESSION_BUSY` and `EH_SESSION_CLOSED`; everything else is a
run error in `run.result.error` (`EH_INVALID_INPUT`, `EH_PENDING_RESPONSE`, `EH_INVALID_MESSAGE`,
`EH_STORAGE`, `EH_CONTEXT_OVERFLOW`, `EH_PROVIDER_AUTH`, `EH_PROVIDER`, `EH_LOCK_UNAVAILABLE`, …); `error.code` is always set (`EH_RUN_FAILED` when nothing more is known), and a missing or wrong AI Gateway key reads `EH_PROVIDER_AUTH` with the text "set AI_GATEWAY_API_KEY". A `SessionLock` that rejects with a `HarnessError('EH_SESSION_BUSY')` means contention; any other rejection is `EH_LOCK_UNAVAILABLE` (503). `session.compact()` may throw `EH_COMPACTION_FAILED`. A reader of `session.events()` that falls more than 1 000 events behind is errored with `EH_EVENTS_OVERFLOW`; an MCP connect or tool listing that exceeds `timeoutMs` fails with `EH_MCP_TIMEOUT`. Public paths throw `HarnessError`, never a bare `Error`. Every code is listed in [spec 10](../specs/10-errors-and-stop-reasons.md).

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
| Loop and cost | `W_LOOP_STUCK` (`details.kind` includes `'tool-errors'`), `W_CONTINUE_LIMIT`, `W_BUDGET` (`details.scope`: `'turn'`, `'session'`, `'ledger'`), `W_MODEL_UNPRICED`, `W_BUDGET_LEDGER_FAILED` (`budget.ledger.onError: 'continue'`), `W_OUTPUT_INVALID` |
| Context | `W_DEFAULT_CONTEXT_WINDOW`, `W_COMPACTION_FAILED`, `W_COMPACTION_FLUSH_SKIPPED`, `W_CONTEXT_TRUNCATED`, `W_OVERFLOW_RETRY`, `W_CONTEXT_THRASH`, `W_CACHE_BUST` (also `details.reason: 'client-tools'`), `W_PAGE_CONTEXT_LIMITED` |
| Tools and sources | `W_SHADOWED`, `W_TOOL_SOURCE_FAILED`, `W_INVALID_TOOL_NAME`, `W_MCP_DRIFT`, `W_TOOL_OUTPUT_LIMITED`, `W_GRANT_IGNORED` |
| Skills | `W_INVALID_SKILL`, `W_SKILL_SOURCE_FAILED` |
| Messages and parts | `W_INVALID_MESSAGE`, `W_REPAIRED_MESSAGE`, `W_UNKNOWN_DATA_PART`, `W_UNKNOWN_STORED_PART`, `W_WRITE_OUTSIDE_TURN`, `W_TRANSIENT_OVERRIDE`, `W_INVARIANT_VIOLATION` (`debug.invariants`) |
| API use | `W_HOOK_FAILED`, `W_HOOK_TIMEOUT`, `W_DEPRECATED`, `W_SESSION_OPTIONS_IGNORED` |
| Sessions | `W_ABORT_UNSUPPORTED`, `W_INBOX_FAILED` (operations incl. `deadLetter`), `W_INBOX_DEAD_LETTER`, `W_STREAM_LOG_FAILED` |
| Tools | `W_TOOL_ORDER` (`toolOrder` names no tool) |
| Plugins | `W_GUARD_UNAVAILABLE` (`eharness/guard`: the judge failed and the call went to a person), `W_WEB_NO_RESOLVER` (`webFetch()` without `resolveHost`; once per session) |

## Request-scoped client tools and page context

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

## External waits

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

## Tool risk and traits

`ToolRisk` is `'read' | 'write' | 'destructive' | 'external'` (`'unknown'` when none; spec 11
§3.2). `toolTraits(metadata)` returns `{ risk?, idempotent?, hints? }` (`ToolTraits`,
`ToolHints`). App metadata (`tool({ metadata: { risk, idempotent } })`, `mcpServerSource({ risk })`)
wins and may be lower than the hints; MCP hints only tighten: `destructiveHint: true` gives
`'destructive'`, else `openWorldHint: true` gives `'external'`; `readOnlyHint` and
`idempotentHint` never lower anything and no MCP spec defaults are applied. `mcpServerSource({ risk })`
takes a `ToolRisk` or a `McpRiskFunction` per server tool. `ApprovalDecision` and
`PendingState.approvals[]` carry `risk` and `idempotent?`. Route with
`approval.risk: { external: 'user-approval' }` ([approvals](approvals-and-interaction.md)).

## Persisted fields: pending state, inbox, plugin state

| Where | Field | Meaning |
|---|---|---|
| `PendingState` | `v: 2` | written on every pending state; no `v` is the older shape (still read); an unknown `v` authorizes nothing |
| `PendingState` | `externals?` | the parked external waits (`PendingExternal`) |
| `PendingState.clientTools[]` | `waitId?`, `timeoutAt?`, `onTimeout?`, `result?` | timed request-declared client calls (recorded through the wait machinery) |
| `PendingState.approvals[]` | `idempotent?` | trait of the tool, when known |
| inbox item | kind `wait-timeout`, `availableAt?`, `lastError?` | durable timers (every `InboxItemInput` member may carry `availableAt`); `lastError` is set by failed attempts |
| plugin state `guard` | `verdicts`, `calls`, `denials` | the guard's per-session verdict cache, its answer per tool call id and the consecutive-denial counter (all bounded) |
| kind message | `group.message` (`model: 'omit'`) | a gated-out group message; `metadata.group` on user messages carries the speaker |

## Persisted fields: core state and messages

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

Result texts that land in stored messages or tool results, exported so apps and tests can match
them (changing one is a minor change): `INTERRUPTED_TURN`, `INTERRUPTED_CRASH`,
`INTERRUPTED_UNKNOWN` (results of tool calls that never finished), `DENIED_NEW_INPUT`,
`NOT_EXECUTED_NEW_INPUT` (pending calls answered by new input), `TOOL_OUTPUT_TRUNCATED`
(truncation marker), `TOOL_OUTPUT_PRUNED` (placeholder of a pruned tool output),
`FLUSH_APPROVAL_DENIED` (denial reason of approval-gated calls in a pre-compaction flush),
`FILE_UNAVAILABLE` (a file of an earlier turn that can no longer be downloaded),
`FINAL_ANSWER_RECORDED` (structured output), `WAIT_TIMED_OUT`, `WAIT_CANCELLED_NEW_INPUT`
(external waits) and `CLIENT_TOOL_TIMED_OUT` (request-declared client tools). Subpaths export
their result texts the same way: `eharness/guard` the denial reasons `GUARD_DENIED`, `GUARD_ASK`,
`GUARD_BREAKER` and `GUARD_UNAVAILABLE`, `eharness/subagent` `SUBAGENT_DENIED`,
`SUBAGENT_NO_CLIENT` and `SUBAGENT_NO_USER`, `eharness/permissions` its `*_REASON` texts.

Instruction wording is **internal** and not exported (it may change in any release): the progress
nudge, the max-steps wrap-up, the structured-output instruction and retry, the final-answer tool
description, the page-context preamble, the guard judge prompt, the memory protocol and pinned
preamble, the todo reminders, the group preamble and the subagent message instructions. Where a
plugin has an option for its instruction (`instructions`, `protocol`, `policy`), the option extends
or replaces the default. `eharness/memory` exports `MEMORY_TOOLS`, `MEMORY_FLUSH_TOOLS` and
`executeMemoryCommand()` for an app-supplied memory tool.

## Other exports

- Types: `PruneConfig`, `CompactionBeforeEvent`, `CompactionBeforePatch`, `FlushPayload`,
  `AbortRequest`, `AbortRequestResult`, `InboxAdapter`, `InboxItem`, `InboxItemInput`,
  `SerializedInput`, `CollectOptions`, `EnqueueOptions`, `EnqueueResult`, `InputFilesConfig`,
  `ToolErrorTextFn`, `ChatRequestOptions`, `OutputSpec` (the `SendOptions.output` value),
  `SendOptionsWithOutput` (`SendOptions` with a required `output`, used by the typed overloads).
- Types: `ToolTraits`, `ToolHints`, `ClientToolDeclaration`, `ClientToolsOptions`,
  `PageContextEntry`, `PageContextOptions`, `PendingClientTool`, `PendingExternal`, `WaitResult`,
  `WaitTimeoutResult`, `ResolveWaitResult`, `ExternalToolDef`, `WaitStart`, `WaitStartEvent`,
  `DeadInboxItem`, `InboxReleaseOptions`, `InboxStats`, `InboxRetryOptions`,
  `InboxBackoffOptions`, `GuardTranscriptEntry`; helper `neutralizeTags(text, tags)` (frames
  untrusted text as data; shared by memory, group and page context).
- Storage (`eharness/storage/memory`): `inMemoryMessages()`, `inMemoryState()`, `inMemoryInbox()`,
  `inMemoryBudgetLedger({ limits })`, `inMemoryStreamLog()`.
- Testing (`eharness/testing`): `scriptedModel()`, `scriptedProvider()`, `schemaCheckedMessages()`,
  `assertValidUIMessage()`, `assertStoredSessionInvariants()` and the conformance suites:
  `messageAdapterConformance()`, `stateAdapterConformance()`, `inboxAdapterConformance()`
  (options `requireRetry`, `requireDeadLetter`, `requireStats`, `requireDedupe`),
  `lockConformance()`, `streamLogConformance()`, `multiInstanceConformance()` (a whole storage
  backend shared by several agent instances), `fileSystemConformance()` (`requireMove`,
  `requireVersions`, `keepsMediaType`), `skillSourceConformance()` (`version`),
  `idGeneratorConformance()`, `budgetLedgerConformance()`, `activityStoreConformance()`,
  `httpConformance()`, and the provider and connector store suites (`profileStoreConformance()`,
  `connectionStoreConformance()`, `credentialStoreConformance()`, `enablementStoreConformance()`,
  `flowStoreConformance()`).
- Messages: `uuidv7()`, `isUuidV7()`, `createKindMessage()`, `isKindMessage()`,
  `defineMessageKind()`, `defineDataPart()`, types `HarnessUIMessage`, `HarnessMetadata`
  (`metadata.eharness`: `createdAt`, `kind`, `turnId`, `model`, `usage`, `stop`, `steps`,
  `durationMs`, `pending`, `error`, `output`, …), `DataChunk`, `OutputPartData` (the
  `data-eh.output` part).
- Skills: `defineSkill()`, `defineSkillSource()`, `parseSkillMarkdown()`, `validateSkillPath()`.
- Plugins and judges: `definePlugin()`, `wrapPlugin()`, `createJudge()` (the shared LLM judge engine behind `guard()` and the permissions auto classifier; [LLM judge](llm-judge.md)), `JudgeUnavailableError`.
- Helpers for plugin and subpath authors: `errorText(error)`, `isRecord(value)`, `isPrivateHost(host)`, `untrustedContent()`, `UNTRUSTED_CONTENT_INSTRUCTIONS`, `neutralizeTags()`, `messageToChunks()`.
- Models: `modelsDevCatalog()`, `openRouterCatalog()`, `lookupModel()`, `computeCost()`, `estimateStepCostUsd()`, `observeModel()`;
  budget ledger types `BudgetLedger`, `BudgetLedgerConfig`, `BudgetReservation`,
  `BudgetScopeStatus`, `BudgetEstimateEvent`.
- `version`: the package version of the build.
- `eharness/providers` (spec 23): see the [providers guide](providers-and-profiles.md#reference).

## Shipped plugins

| Import | Plugin | Options (defaults) | Model-visible |
|---|---|---|---|
| `eharness/filesystem` | `filesystem({ fs, … })` | spec 08 §2 | `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `grep`, `glob` |
| `eharness/todos` | `todos()` | `enforce` (false), `maxNudges` (3), `remindEvery` (5), `maxItems` (50) | `todo_write` |
| `eharness/memory` | `memory({ roots })` | `pinned`, `maxPinnedChars` (2_000), `maxFileChars` (20_000), `protocol` (a built-in text; `false` = none), `tool`, `onWrite`, `flushOnCompaction` (false) | `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`, `memory_rename` (or the app's `memory` tool) |
| `eharness/guard` | `guard({ model, … })` | `policy` (a built-in default), `skipRisks` (`['read']`), `skipTools`, `onlyTools`, `transcript` (`{ maxMessages: 20, maxChars: 12_000 }`, transcript only), `maxCallChars` (8 000; longer inputs ask a person), `timeoutMs` (15 000), `maxRetries` (1), `maxConsecutiveDenials` (3; `Infinity` = off), `cache` (`{ maxEntries: 200, ttlMs? }`) | none (a `tool.approve` hook on the shared `createJudge` engine, role `tighten`) |
| `eharness/group` | `group({ botId, … })`, `routeGroupMessage(group, session, message, options?)` | `botName`, `requireMention` (true), `mentionPatterns`, `replyCountsAsMention` (true), `historyLimit` (20), `maxBotTurns` (`{ count: 3, windowMs: 60_000 }`), `allowBots` (false), `shouldRespond`, `formatSpeaker` | none (kind `group.message`, `metadata.group`) |
| `eharness/openapi` | `openApiSource({ spec, name, baseUrl, … })` (a tool source) | `headers`, `include`, `exclude`, `names`, `prefix` (`<name>_`), `risk` (from the HTTP method), `maxTools` (64), `defer` (`'auto'`: above 20), `timeoutMs` (30 000), `maxResponseChars` (50 000), `schema`, `useSpecServers` (false), `wrapUntrusted` (true), `fetch` | one tool per selected operation; input `{ path?, query?, headers?, body? }` |
| `eharness/filesystem/node` (Node-only) | `diskFs({ root, … })`, `mountFs({ mounts })`, `nodeWorkspace({ … })`, `nodeCheckpointStore({ dir, … })`, `compileIgnore()`, `nodeRealpath()` | `diskFs`: `maxFileBytes`, `maxBinaryBytes`, `grepTimeoutMs` (30 000), `grepMaxOutputBytes` (64 MiB), `onGrepFallback`, `.gitignore` subset; spec 08 §8 | none (a `FileSystem` for `filesystem()`) |
| `eharness/shell` (Node-only) | `shell({ sandbox, … })`, `localSandbox({ root, … })` | `timeoutMs` (120 000), `maxTimeoutMs` (600 000), `maxOutputChars` (30 000), `background` (false), `onTaskEvent`, `toolName` (`bash`), `risk` (`'external'`); sandbox `os`, `env`, `inheritEnv` (false), `shell` | `bash`, with `background`: `bash_output`, `kill_shell`; service `shellTasks`, part `data-shell.output` |
| `eharness/permissions` | `permissions({ engine })`, `createPermissionEngine({ roots, … })` | `mode` (`'default'`), `rules`, `protectedPaths` (`['.git']`), `builtinAsk`, `readOnlyCommands`, `toolKinds`, `aliases`, `modeCycle`, `classifier` (auto mode), `realpath`, `persist` | none (a `tool.approve` hook, plan mode, output filter) |
| `eharness/subagent` | `subagent({ agents, approvals, … })`, `subagentChild({ parent })`, `reconcileSubagentWaits()` | `toolName` (`agent`), `maxDepth` (2), `maxConcurrent` (8), `background` (`false`; `true` or `{ default, inChildren, timeoutMs (1 h), stopOnTimeout (true), reconcileEveryMs }` for `'park'` children), `maxChildren`, `messageTool`, `outputTool`, `stopTool` (each `boolean \| { name }`), `maxReportChars` (16 000), `messageLimits`, `answer`, `policy` (`'deny'`), `parkTimeoutMs`, `selfAgent`, `parentAgent`, `onParentRun` | `agent` (`subagent_type`, `description`, `prompt`, `name?`, `run_in_background?`), `send_message`, `agent_output`, `agent_stop`; service `subagentTasks`; part `data-subagent.run` |
| `eharness/ask` | `ask(options?)`, `pendingQuestions()`, `answerOutput()` | `toolName`, `maxQuestions` (4), `interactive` (true), `whenNoHuman` (`'dismiss'`) | `ask_user_question` (a client tool, or executed with `interactive: false`) |
| `eharness/web` | `webFetch(options?)`, `webSearch({ search, … })`, constants `WEB_FETCH_TOOL`, `WEB_SEARCH_TOOL` | `webFetch`: `allow`, `deny`, `onlyAllowed`, `maxBytes` (5 MiB), `maxChars` (30 000), `timeoutMs` (15 000), `maxRedirects` (5), `toMarkdown`, `wrapUntrusted` (true), `userAgent`, `resolveHost` (Node: `nodeResolveHost` from `eharness/web/node`), `fetch` | `web_fetch`, `web_search` (risk `'external'`) |

`openApiSource` derives the risk from the HTTP method: `GET`, `HEAD`, `OPTIONS` give `'read'`,
`DELETE` gives `'destructive'`, the rest `'write'` (override with `risk`). Guides: [guard](guard.md), [group chat](group-chat.md),
[OpenAPI tools](openapi-tools.md), [shell](shell.md), [permissions](permissions.md),
[subagents](subagents.md), [ask](ask.md), [web](web.md).

`FileSystem.move` is optional (atomic rename → `MoveResult`; `inMemoryFs` implements it,
`fileSystemConformance` checks it with `requireMove`).

Patterns that combine these (ephemeral context, episodic memory, background events, heartbeats,
several instances, security): [production patterns](production-patterns.md).
- `eharness/connectors` (spec 24): see the [connectors guide](connectors.md#reference).
