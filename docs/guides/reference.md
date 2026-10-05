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
| `budget` | none | `{ maxTurnUsd?, maxSessionUsd?, warnAt? = 0.8 }` → `'cost-cap'` — [models and cost](models-and-cost.md#budgets) |
| `instructions` | none | string, `{ text, id? }`, function, or `{ text: fn, refresh: 'session' \| 'turn' }` — [tools and MCP](tools-and-mcp.md#instructions) |
| `tools` | none | record of `Tool` / `(ctx) => Tool`, a `ToolSource`, or an array of both |
| `skills` | none | `defineSkill(…)` / `defineSkillSource(…)` — [skills](skills.md) |
| `mcp` | none | `mcpServer(…)` sources (same as putting them into `tools`) |
| `dataParts`, `messageKinds` | none | app parts `data-<key>` and kinds — [rendering data parts](rendering-data-parts.md) |
| `plugins` | `[]` | `definePlugin(…)` values, in order — [writing a plugin](writing-a-plugin.md) |
| `storage` | memory adapters | `{ messages?: MessageAdapter; state?: StateAdapter; inbox?: InboxAdapter }` — [storage adapters](writing-a-storage-adapter.md), [several instances](multi-instance.md) |
| `inbox` | `{ pollMs: 2_000, claimTtlMs: recovery.staleMs, collect: { quietMs: 1_500, maxWaitMs: 10_000, maxItems: 20 } }` | durable inbox drain (`pollMs: 0` = notifications only) and the `collect` debounce (also without an inbox) — [several instances](multi-instance.md) |
| `compaction` | `{ summarizeAt: 0.75, keepLast: 4, maxSummaryTokens: 4_000 }` | or `false` — [compaction](compaction.md) |
| `compaction.prune` | off | `{}` = `{ keepTurns: 2, minChars: 2_000 }`; `exclude`, `replaceWith` — view-only pruning of old tool outputs ([compaction](compaction.md#pruning-old-tool-outputs)) |
| `compaction.thrash` | `{ withinSteps: 2 }` | or `false` — stop `'context-thrash'` instead of compacting again ([compaction](compaction.md#when-a-turn-thrashes)) |
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
| `respond({ approvals, toolOutputs }, options?)` | answer pending approvals / client tools and continue the same message |
| `regenerate({ messageId?, … })`, `edit(messageId, input, options?)` | answer again / replace a user message |
| `attach()` | replay and follow the running turn (`undefined` when idle) |
| `abort(reason?)` | abort the running turn and drop queued turns; without a local turn, request the abort of a turn running in another instance |
| `requestAbort(reason?)` | awaitable abort → `{ target: 'local' \| 'remote' \| 'idle' \| 'unsupported' }` ([long-running turns](long-running-turns.md#stopping-a-turn-from-another-instance)) |
| `inject(kind, data, { deliver?, wake? })` | store an event message; deliver it into the running turn or wake the agent (with an inbox, also the instance running the turn) |
| `enqueue(input, { mode?, collect? })` | hand input to whichever instance holds the session → `{ inboxId, target: 'local' \| 'remote' }`; `mode`: `'queue'` (default), `'steer'`, `'collect'` ([several instances](multi-instance.md)) |
| `compact()` | manual compaction (idle only) |
| `clearGrants()` | forget `remember: 'session'` grants |
| `messages({ beforeId?, limit?, includeHidden? })` | stored history for UIs (pages past hidden messages until `limit` visible ones) |
| `stats()` | `ContextStats` + `pending` + `activeTurn` |
| `events()` | long-lived stream of `SessionEvent`s |
| `idle()` | resolves when no turn runs and nothing is queued (nor a `collect` burst or inbox drain pending) |
| `ready()`, `close()`, `running`, `id` | open now (configuration errors as exceptions), close, state |

`SendOptions`: `ifBusy` (`'reject'` default; `'queue'`, `'steer'` for `send`; `'wait'` for `send`
and `respond`: wait for the running turn and the queue, then run), `model`,
`settings`, `options` (validated by `callOptions`), `maxSteps`, `abortSignal`, `runtime`,
`toolsContext`, `output` (`{ schema, mode?: 'tool' | 'native', maxRetries?, toolName?,
description? }`: a typed, validated final answer in `result.output` —
[structured output](structured-output.md)). Every turn operation returns a `HarnessRun`: `turnId`, `kind`, `messageId`
(promise), `stream` (AI SDK UI message stream, single consumer), `result` (never rejects),
`abort()`, `toResponse()`, `pipeTo(res)`. The stream ends only after the turn finalized: a client
that saw `finish` can send again at once (unless a queued or other turn started meanwhile). `handleChatRequest(session, body, options?)` maps a
`useChat` request (`ChatRequestBody`) to `send` / `respond` / `regenerate` / `edit`; `options` are
`SendOptions` plus `actor` (given to `approval.decided` for approval answers). It never throws
`EH_SESSION_BUSY`: a busy session returns a failed run whose `toResponse()` answers **409**
`{ error: { code, message } }`.

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
| `tool-pending` | waiting for `respond()` |
| `max-steps` | step budget used up (after the wrap-up step) |
| `stuck` | the progress guard stopped a repeating or failing turn |
| `context-thrash` | the context filled up again right after a compaction (`compaction.thrash`) |
| `cost-cap` | `loop.maxTurnOutputTokens` exceeded or a USD budget used up |
| `output-invalid` | `SendOptions.output`: no valid final answer within `maxRetries` retries |
| `length`, `content-filter` | provider finish reasons |
| `error` | provider, stream, storage or overflow error (`error.code`, e.g. `EH_CONTEXT_OVERFLOW`) |
| `aborted`, `timeout`, `blocked`, `interrupted` | abort, time limit, `input.submit` block, crashed process |
| `plugin:<name>:<reason>` | a `step.end` hook stopped the turn |

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
| Loop and cost | `W_LOOP_STUCK`, `W_CONTINUE_LIMIT`, `W_BUDGET`, `W_MODEL_UNPRICED`, `W_OUTPUT_INVALID` |
| Context | `W_DEFAULT_CONTEXT_WINDOW`, `W_COMPACTION_FAILED`, `W_COMPACTION_FLUSH_SKIPPED`, `W_CONTEXT_TRUNCATED`, `W_OVERFLOW_RETRY`, `W_CONTEXT_THRASH`, `W_CACHE_BUST` |
| Tools and sources | `W_SHADOWED`, `W_TOOL_SOURCE_FAILED`, `W_INVALID_TOOL_NAME`, `W_MCP_DRIFT`, `W_TOOL_OUTPUT_LIMITED`, `W_GRANT_IGNORED` |
| Skills | `W_INVALID_SKILL`, `W_SKILL_SOURCE_FAILED` |
| Messages and parts | `W_INVALID_MESSAGE`, `W_UNKNOWN_DATA_PART`, `W_UNKNOWN_STORED_PART`, `W_WRITE_OUTSIDE_TURN`, `W_TRANSIENT_OVERRIDE` |
| API use | `W_HOOK_FAILED`, `W_DEPRECATED`, `W_SESSION_OPTIONS_IGNORED` |
| Sessions | `W_ABORT_UNSUPPORTED`, `W_INBOX_FAILED` |

## Fixed texts

Model- or UI-visible texts the core writes, exported so apps and tests can match them (changing
one is a minor change): `INTERRUPTED_TURN`, `INTERRUPTED_CRASH`, `INTERRUPTED_UNKNOWN` (results of
tool calls that never finished), `DENIED_NEW_INPUT`, `NOT_EXECUTED_NEW_INPUT` (pending calls
answered by new input), `PROGRESS_NUDGE`, `MAX_STEPS_WRAP_UP` (step reminders),
`TOOL_OUTPUT_TRUNCATED` (truncation marker), `TOOL_OUTPUT_PRUNED` (placeholder of a pruned tool
output), `FLUSH_APPROVAL_DENIED` (denial reason of approval-gated calls in a pre-compaction flush), `FILE_UNAVAILABLE` (a file of an earlier turn that
can no longer be downloaded), `FINAL_ANSWER_DESCRIPTION`, `FINAL_ANSWER_RECORDED`,
`OUTPUT_INSTRUCTION`, `OUTPUT_RETRY` (structured output). `eharness/todos` exports its own (`TODOS_*`),
`eharness/memory` exports `MEMORY_PROTOCOL` and `MEMORY_FLUSH_PROMPT` (with `MEMORY_FLUSH_TOOLS`).

## Other exports

- Messages: `uuidv7()`, `isUuidV7()`, `createKindMessage()`, `isKindMessage()`,
  `defineMessageKind()`, `defineDataPart()`, types `HarnessUIMessage`, `HarnessMetadata`
  (`metadata.eharness`: `createdAt`, `kind`, `turnId`, `model`, `usage`, `stop`, `steps`,
  `durationMs`, `pending`, `error`, `output`, …), `DataChunk`, `OutputPartData` (the
  `data-eh.output` part).
- Skills: `defineSkill()`, `defineSkillSource()`, `parseSkillMarkdown()`, `validateSkillPath()`.
- Models: `modelsDevCatalog()`, `lookupModel()`, `computeCost()`.
- `version`: the package version of the build.

## Shipped plugins

| Import | Plugin | Options (defaults) | Model-visible |
|---|---|---|---|
| `eharness/filesystem` | `filesystem({ fs, … })` | spec 08 §2 | `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `grep` |
| `eharness/todos` | `todos()` | `enforce` (false), `maxNudges` (3), `remindEvery` (5), `maxItems` (50) | `todo_write` |
| `eharness/memory` | `memory({ roots })` | `pinned`, `maxPinnedChars` (2_000), `maxFileChars` (20_000), `protocol` (`MEMORY_PROTOCOL`), `tool`, `onWrite`, `flushOnCompaction` (false) | `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`, `memory_rename` (or the app's `memory` tool) |

`FileSystem.move` is optional (atomic rename; `memoryFs` implements it, `fileSystemConformance`
checks it with `requireMove`).
