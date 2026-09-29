# Spec 10 — Errors, warnings, stop reasons

Status: **Accepted (reviewed for 0.1.0)**. Module: `src/errors.ts`.

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
export class HarnessToolError extends Error { readonly toolName: string; readonly toolCallId: string }
```

Created by the core's execute wrapper (spec 01 §5) and re-thrown to AI SDK, which turns it into a
tool-error result. Because `name` and `message` are copied, `String(error)` — the text the model
sees — is identical to the original, and the UI stream uses the same text (spec 04 §2). It never
reaches the caller of `send()`.

## 2. Warnings (non-fatal)

Delivered to `config.onWarning` (every occurrence; the **default** handler deduplicates per
code + key), as transient `data-eh.warning` during a turn, and as session `data` events otherwise.
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
| `W_CONTEXT_TRUNCATED` | guard dropped/truncated context to fit |
| `W_HOOK_FAILED` | a hook threw; skipped |
| `W_INVALID_TOOL_NAME` | a tool source returned an invalid tool name; skipped |
| `W_TRANSIENT_OVERRIDE` | `transient: false` for a transient part; sent as transient |
| `W_DEPRECATED` | a deprecated API was used (once per API) |
| `W_SESSION_OPTIONS_IGNORED` | options passed to a cached session differ |
| `W_DEFAULT_CONTEXT_WINDOW` | `contextWindow` not set (or its function returned `undefined`) for a model; using 128k |
| `W_CONTINUE_LIMIT` | `turn.beforeEnd` asked to continue more than `loop.maxContinues` times; ignored |
| `W_TOOL_OUTPUT_LIMITED` | a tool output exceeded `toolOutput.maxChars` and was truncated or evicted (spec 09 §4) |
| `W_CACHE_BUST` | the cached prompt prefix changed within a session (instructions/tools changed, spec 02 §6) |
| `W_OVERFLOW_RETRY` | the provider rejected the context as too long; compacting and retrying once (spec 06 §7) |
| `W_GRANT_IGNORED` | a `remember: 'session'` grant could not apply (e.g. denied by policy) |

## 3. `describeError`

Maps any error to a user-safe message for `error` chunks and `eh.notice`:

- walks `.cause` chains; prefers the provider's own message for API errors (status 4xx) with
  prefixes `Provider rejected the request:` (400/401/402/403/404/422), `Rate limited:` (429),
  `Provider unavailable:` (5xx);
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
  | 'aborted'         // run.abort() / session.abort() / abortSignal
  | 'timeout'         // loop.turnTimeoutMs, or an AI SDK step timeout (settings.timeout)
  | 'blocked'         // an input.submit hook blocked the input (spec 05 §3)
  | 'interrupted'     // the process died mid-turn; set by crash recovery (spec 05 §9)
  | 'max-steps'       // step budget reached (loop.maxSteps / SendOptions.maxSteps, + extendSteps)
  | 'cost-cap'        // loop.maxTurnOutputTokens exceeded
  | `plugin:${string}` // a step.end hook stopped the turn: 'plugin:<plugin>:<reason>'
```

The stop reason is stored in `metadata.eharness.stop` of the assistant message and returned in
`TurnResult`:

```ts
export interface TurnResult<M = HarnessUIMessage> {
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
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }
  steps: number
  durationMs: number
  /** `details` of an EH_* error (e.g. `{ reason: 'stale' }` for respond(), spec 11); not stored. */
  error?: { code?: string; message: string; details?: Record<string, unknown> }
}
```

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
| `TOOL_OUTPUT_TRUNCATED` | `…[truncated {n} chars]…` | output limits (spec 09 §4) |
