# Spec 10 — Errors, warnings, stop reasons

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Module: `src/errors.ts`.

## 1. Errors (thrown)

Thrown only for programmer/configuration errors and explicit API misuse. Never for model or tool
failures during a turn.

```ts
export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly details?: Record<string, unknown>
}
export function isHarnessError(e: unknown, code?: HarnessErrorCode): e is HarnessError
```

| Code | Thrown by | Meaning |
|---|---|---|
| `EH_CONFIG_INVALID` | `defineHarnessAgent`, `definePlugin`; session open (`ready()` / run error, e.g. eager `mcpServer` without `@ai-sdk/mcp`); misuse when `strict: true` | bad names, reserved prefixes, invalid options, missing optional peer |
| `EH_DUPLICATE_TOOL` | boot / session open | two static tools (or a reserved name) collide |
| `EH_DUPLICATE_SKILL` | boot / session open | two static skills collide |
| `EH_DUPLICATE_DATA_PART` | boot | data part / message kind type collision |
| `EH_SERVICE_CONFLICT` | boot | two plugins provide one service |
| `EH_SERVICE_MISSING` | boot / session open / `ctx.services` access | required service not provided |
| `EH_PLUGIN_ORDER` | boot | requirer ordered before provider |
| `EH_SESSION_BUSY` | `send`/`respond`/`regenerate`/`edit` (sync, in-process flag, `ifBusy: 'reject'`), `compact`; lock rejection or a live foreign `activeTurn` → **run error** | a turn is running (here or elsewhere) |
| `EH_SESSION_CLOSED` | any session method | session was closed or evicted |
| `EH_INVALID_INPUT` | `inject` (thrown); turn operations → **run error** | input, kind payload, `SendOptions.options` or `toolsContext` fails validation; `respond`/`regenerate`/`edit` target problems with `details.reason`: `'unknown-id'`, `'incomplete'`, `'stale'`, `'beyond-compaction'`, `'not-found'` (spec 11) |
| `EH_PENDING_RESPONSE` | turn operations → **run error** (only with `approval.onNewInput: 'reject'`) | approvals / client tool calls are waiting; call `respond()` first |
| `EH_INVALID_MESSAGE` | `ready()` / load with `onInvalidMessage: 'throw'`; in `send` → run error | stored message invalid |
| `EH_STORAGE` | `ready()`, `messages()`, `inject`, `compact` (thrown); in `send` → run error | adapter threw; original error in `cause` |
| `EH_COMPACTION_FAILED` | `session.compact()` | summarizer failed |
| `EH_CONTEXT_OVERFLOW` | never thrown; recorded as `metadata.eharness.error.code` of a turn ending with `stop: 'error'` | guard could not fit the context, or the provider still rejected it after the overflow retry (spec 06 §6–7) |

**Notice codes** (never thrown; `code` field of an `eh.notice` kind message):

| Code | Meaning |
|---|---|
| `EH_TURN_INTERRUPTED` | a turn was recovered after its process died (spec 05 §9) |
| `EH_INPUT_BLOCKED` | `input.submit` blocked the input with `persist: true` (spec 05 §3) |
| `EH_TURN_TIMEOUT` | the turn hit `loop.turnTimeoutMs` |
| `EH_CONTEXT_THRASH` | the turn stopped with `'context-thrash'` (level `warning`, spec 06 §4) |

"Run error" = reported through the turn stream and `run.result` (`stop: 'error'`,
`error.code`), never thrown (spec 05 §2). `ready()` rethrows session-open errors for callers who
want them as exceptions.

Storage failures during a turn: a failed `save` of the user message ends the turn before any
model call (`stop: 'error'`, code `EH_STORAGE`). A failed assistant snapshot save is retried once at
the next step (warning only). A failed final save sets `stop: 'error'` / `EH_STORAGE` in
`run.result`; the stream has already been delivered.

### 1.1 `HarnessToolError`

```ts
/** Wraps an error thrown by a tool's execute. Copies `name` and `message`, keeps the original in `cause`. */
export class HarnessToolError extends Error {
  readonly toolName: string; readonly toolCallId: string
  /** The `config.toolErrorText` text, when set; `toString()` returns it. */
  readonly text: string | undefined
}
```

Created by the core's execute wrapper (spec 01 §5) and re-thrown to AI SDK, which turns it into a
tool-error result. Because `name` and `message` are copied, `String(error)` — the text the model
sees — is identical to the original, and the UI stream uses the same text (spec 04 §2). It never
reaches the caller of `send()`.

**`config.toolErrorText`** (0.4.0): `(error, { toolName, toolCallId }) => string` maps a thrown
error to its text; `String(error)` of the `HarnessToolError` is then the mapped text, so the UI
stream, the stored part and the model wire stay identical. Default: `String(error)` of the
original — which may carry secrets (connection strings, tokens) to clients and the model. A mapper
that throws or returns a non-string yields `Error: the tool failed.` (never the original text).
Errors of invalid / unknown tool calls (`AI_InvalidToolInputError`, `AI_NoSuchToolError`) are not
mapped (they carry only the model's own input).

## 2. Warnings (non-fatal)

Delivered to `config.onWarning` (every occurrence; the **default** handler deduplicates per
code + key, remembering the 1 000 most recently used keys so per-turn keys cannot grow it
forever), as transient `data-eh.warning` during a turn, and as session `data` events otherwise.
With `config.strict: true`, misuse warnings (`W_TRANSIENT_OVERRIDE`, `W_UNKNOWN_DATA_PART`,
`W_WRITE_OUTSIDE_TURN`) throw `EH_CONFIG_INVALID` instead.

Plugins and sources emit warnings through `ctx.warn(warning)` (spec 01 §4): same channel, with
`details.plugin` set to the emitting plugin unless given; the default handler deduplicates per
code + plugin + message.

```ts
export interface HarnessWarning { code: WarningCode; message: string; details?: Record<string, unknown> }
```

| Code | Meaning |
|---|---|
| `W_SHADOWED` | dynamic tool/skill name hidden by an earlier one |
| `W_TOOL_SOURCE_FAILED` | a tool source `list()`/connect failed |
| `W_MCP_DRIFT` | MCP tool definition changed; tool excluded |
| `W_INVALID_MESSAGE` | stored message failed validation and was dropped |
| `W_INVALID_SKILL` | skill metadata invalid; skipped |
| `W_SKILL_SOURCE_FAILED` | a skill source `list()` failed (retried next turn), or its `search()` / `locate()` failed (core matcher / no location used) |
| `W_UNKNOWN_DATA_PART` | write of an unregistered data part; dropped |
| `W_UNKNOWN_STORED_PART` | stored message contains an unregistered data part type; ignored in memory, kept in storage (never escalated by `strict`) |
| `W_WRITE_OUTSIDE_TURN` | persistent data part written while idle; dropped |
| `W_COMPACTION_FAILED` | automatic compaction failed; continuing with the guard |
| `W_COMPACTION_FLUSH_SKIPPED` | (0.4.0) a requested pre-compaction flush did not run because it cannot fit: `details: { reason: 'window', trigger, window, tokens }` — the flush model's window is too small for the current context, or (overflow recovery) not larger than the turn model's window (spec 06 §5.2a) |
| `W_CONTEXT_TRUNCATED` | guard dropped/truncated context to fit |
| `W_HOOK_FAILED` | a hook threw; skipped (`details: { hook, owner }`). A failed pre-compaction flush is reported the same way with `details: { hook: 'compaction.before', owner, phase: 'flush' }`; compaction continues (spec 06 §5.2a) |
| `W_INVALID_TOOL_NAME` | a tool source returned an invalid tool name; skipped |
| `W_TRANSIENT_OVERRIDE` | `transient: false` for a transient part; sent as transient |
| `W_DEPRECATED` | a deprecated API was used (once per API) |
| `W_SESSION_OPTIONS_IGNORED` | options passed to a cached session differ |
| `W_DEFAULT_CONTEXT_WINDOW` | `contextWindow` not set (or its function returned `undefined`) for a model; using 128k |
| `W_CONTINUE_LIMIT` | `turn.beforeEnd` asked to continue but the continuation is refused: `details.reason` `'no-progress'` (`loop.maxIdleContinues`) or `'max'` (`loop.maxContinues`) |
| `W_BUDGET` | a USD budget reached `warnAt` or is used up (`details: { scope, limitUsd, spentUsd, exceeded }`, spec 12 §4) |
| `W_MODEL_UNPRICED` | a budget is configured but the step model has no pricing in `models` (`details.model`) |
| `W_LOOP_STUCK` | the progress guard found the turn stuck and reminded the model (`details: { kind, toolName?, count, stepIndex }`, spec 05 §3.2) |
| `W_TOOL_OUTPUT_LIMITED` | a tool output exceeded `toolOutput.maxChars` and was truncated or evicted (spec 09 §4) |
| `W_CACHE_BUST` | the cached prompt prefix changed within a session (instructions/tools changed, spec 02 §6) |
| `W_OVERFLOW_RETRY` | the provider rejected the context as too long; compacting and retrying once (spec 06 §7) |
| `W_CONTEXT_THRASH` | a second automatic compaction within `compaction.thrash.withinSteps` steps of the previous one ran (or was skipped as no-gain) and left the context above `summarizeAt`; the turn stops with `'context-thrash'` (`details: { stepIndex, tokens, summarizeAt, lastCompaction }`, `tokens` = the context after the second compaction, `lastCompaction` = step index of the previous compaction, spec 06 §4) |
| `W_GRANT_IGNORED` | a `remember: 'session'` grant could not apply (e.g. denied by policy) |
| `W_ABORT_UNSUPPORTED` | `abort()` / `requestAbort()` found a turn running in another instance but cannot reach it: the `StateAdapter` has no `setIf`, or `recovery: false` (spec 05 §9.1) |
| `W_OUTPUT_INVALID` | a turn with `SendOptions.output` found no valid final answer within `maxRetries` retries (or a retry was refused by the continuation bounds); the turn stops with `'output-invalid'` (`details: { attempts, lastError }`, spec 05 §3.3; 0.4.0) |
| `W_INBOX_FAILED` | an `InboxAdapter` call failed (`details: { sessionId, operation }`: `claim`, `ack`, `release`, `notify`, `subscribe`, `drain`, `enqueue` of an abort — then the state request is used — or `input` for a stored input that no longer normalizes, which is dropped); items are redelivered after their claim expires (spec 05 §12) |

## 3. `describeError`

Maps any error to a user-safe message for `error` chunks and `eh.notice`:

- walks `.cause` chains and AI SDK `RetryError.lastError` / `errors` (the same error shapes as
  overflow detection, spec 06 §7: `APICallError`, `StreamProviderError`, duck-typed
  `statusCode` / `status`); the first error in that order with a status decides, so a
  `RetryError` whose last attempt has no status (e.g. a network error) but an earlier attempt was
  a 429 / 5xx reads `Rate limited:` / `Provider unavailable:`; prefixes
  `Provider rejected the request:` (400/401/402/403/404/422), `Rate limited:` (429),
  `Provider unavailable:` (5xx);
- the provider's own message follows the prefix only for AI SDK `APICallError` /
  `StreamProviderError` (checked with `isInstance`), with URLs, query strings and key-like tokens
  (`sk-…`, `Bearer …`, long hex/base64 runs) redacted as `[redacted]` and the text capped at 300
  characters (0.4.0). Any other error with a status (a plain `Error` with `status`, fetch or
  gateway wrappers) reads `HTTP <status>` after the prefix — its message may carry URLs with keys
  or connection strings. The redaction patterns are not public API; only the behaviour is;
- never includes headers, API keys, request bodies or stack traces;
- falls back to `Unexpected error (see server logs)`; the full error goes to `ctx.log.error`.

## 4. Stop reasons

```ts
export type StopReason =
  | 'complete'        // model answered without tool calls (finishReason 'stop' or 'other')
  | 'tool-pending'    // waiting for respond(): approval request or client-side tool (spec 11 §2)
  | 'length'          // provider finishReason 'length'
  | 'content-filter'  // provider finishReason 'content-filter'
  | 'error'           // provider/stream/storage/overflow error (see metadata.eharness.error); tool errors do NOT end the turn
  | 'aborted'         // run.abort() / session.abort() / requestAbort() (also from another instance, spec 05 §9.1) / abortSignal
  | 'timeout'         // loop.turnTimeoutMs, or an AI SDK step timeout (settings.timeout)
  | 'blocked'         // an input.submit hook blocked the input (spec 05 §3)
  | 'stuck'           // the progress guard found the turn repeating or failing; a reminder did not help (spec 05 §3.2)
  | 'context-thrash'  // the context filled up again right after a compaction (spec 06 §4; 0.4.0)
  | 'interrupted'     // the process died mid-turn; set by crash recovery (spec 05 §9)
  | 'max-steps'       // step budget reached (loop.maxSteps / SendOptions.maxSteps, + extendSteps)
  | 'cost-cap'        // loop.maxTurnOutputTokens or a budget exceeded
  | 'output-invalid'  // SendOptions.output: no valid final answer within maxRetries (spec 05 §3.3; 0.4.0)
  | `plugin:${string}` // a step.end hook stopped the turn: 'plugin:<plugin>:<reason>'
```

The stop reason is stored in `metadata.eharness.stop` of the assistant message and returned in
`TurnResult`:

```ts
export interface TurnResult<M = HarnessUIMessage, O = unknown> {
  turnId: string
  kind: TurnInfo['kind']
  /** Assistant message written by the turn (for respond(): the continued message). Undefined for early failures and blocks without persist. */
  messageId?: string
  stop: StopReason
  /** Set when stop is 'tool-pending' (spec 11 §2). */
  pending?: PendingState
  /** Messages created by this turn (user, assistant, and any kind messages such as markers). */
  messages: M[]
  /** This turn only; includes addUsage() contributions. Cache fields when the provider reports them. */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number; costUsd?: number }
  steps: number
  durationMs: number
  /** `details` of an EH_* error (e.g. `{ reason: 'stale' }` for respond(), spec 11); not stored. */
  error?: { code?: string; message: string; details?: Record<string, unknown> }
  /**
   * 0.4.0: the validated final answer of a turn started with SendOptions.output (spec 05 §3.3),
   * typed from the schema (HarnessRun<M, O>, spec 04 §7). Set only with stop 'complete'.
   */
  output?: O
}
```

`'output-invalid'` (0.4.0) is a **type-level** addition like `'stuck'` (0.3) and
`'context-thrash'` (0.4.0): exhaustive `switch` statements over `StopReason` must add a case.

## 5. Fixed texts

Model- and UI-visible texts the core writes are constants in `src/messages/texts.ts` (exported for
UIs and tests). Changing one is a minor change (it changes what models see).

| Constant | Text | Used by |
|---|---|---|
| `INTERRUPTED_TURN` | `Interrupted: the turn ended before this tool finished.` | dangling calls at turn end (spec 05 §3) |
| `INTERRUPTED_CRASH` | `Interrupted: the process stopped before this tool finished.` | crash recovery (spec 05 §9) |
| `INTERRUPTED_UNKNOWN` | `Interrupted: no result was recorded for this tool call; it may or may not have taken effect.` | projection and guard (spec 03 §6, spec 06 §6) |
| `DENIED_NEW_INPUT` | `The user sent a new message instead of answering.` | approval denial reason, `onNewInput: 'deny'` (spec 11 §4.1) |
| `NOT_EXECUTED_NEW_INPUT` | `Not executed: the user sent a new message.` | client tool error, `onNewInput: 'deny'` |
| `PROGRESS_NUDGE` | `You are not making progress: {what}. Do not repeat it. Try a different approach, or stop and explain what blocks you.` | progress guard reminder (spec 05 §3.2) |
| `MAX_STEPS_WRAP_UP` | `The step limit of this turn is reached and tools are disabled. Summarize what you did, what is left, and how to continue.` | wrap-up step reminder (spec 05 §3.1) |
| `TOOL_OUTPUT_TRUNCATED` | `…[truncated {n} chars]…` | output limits (spec 09 §4) |
| `TOOL_OUTPUT_PRUNED` | `[output of {tool} pruned: {n} chars]` | prune stage placeholder (`{n}` = characters of the original output; spec 06 §5.0) |
| `FILE_UNAVAILABLE` | `[file unavailable: {mediaType} {filename}]` | a file of an earlier turn whose URL cannot be downloaded (spec 05 §3 step 7) |
| `FINAL_ANSWER_DESCRIPTION` | `Submit the final answer of this turn. Call it once, when you are done; its input is the answer.` | default description of the output tool (`SendOptions.output`, tool mode, spec 05 §3.3; 0.4.0) |
| `FINAL_ANSWER_RECORDED` | `Final answer recorded.` | result of a successful output tool call (spec 05 §3.3; 0.4.0) |
| `OUTPUT_INSTRUCTION` | ``When you are done, call the `{tool}` tool once with your final answer. Its input must match the tool schema; the turn ends when the call succeeds.`` | turn reminder line in tool mode (`{tool}` = output tool name, spec 05 §3.3; 0.4.0) |
| `OUTPUT_RETRY` | `Your final answer is missing or invalid: {error}` + newline + `Give the final answer again; it must match the required schema.` | retry input (`data-eh.input`, source `plugin:eh.output`; `{error}` trimmed to 1 000 characters, spec 05 §3.3; 0.4.0) |
