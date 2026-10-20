# Error, warning and notice codes

Reference for every public machine-readable code, who throws or emits it, and how stable it is.
The meaning of each code is in [spec 10](../specs/10-errors-and-stop-reasons.md); this page is the
map and the stability promise. `src/codes.ts` is the single source of truth, and a test checks that
every code is declared once, used only when declared, and documented in spec 10.

## Where codes appear

| Surface | Type | Open to custom strings? |
|---|---|---|
| `HarnessError.code`, `isHarnessError(e, code)` | `HarnessErrorCode` (`EH_*`) | no |
| `TurnResult.error.code` | `HarnessErrorCode \| HarnessNoticeCode`, always set | no |
| `metadata.eharness.error.code`, `NoticePayload.code` (stored; optional for data written before 0.8) | `HarnessErrorCode \| HarnessNoticeCode \| (string & Record<never, never>)` | yes: autocomplete for library codes, any string for app-defined notices (e.g. `EH_REMINDER`) |
| `HarnessWarning.code`, `config.onWarning` | `WarningCode` (`W_*`) | no |
| `eharness/http` error body `error.code` | `HttpErrorCode = HttpLayerErrorCode \| HarnessErrorCode \| HarnessNoticeCode \| 'EH_INTERNAL' \| (string & {})` | yes (apps return their own from `authorize`) |
| `HarnessHttpError.code` (`eharness/client`) | the wire code | yes |

`NoticePayload.code` already has the "union plus open string" shape (it uses
`string & Record<never, never>`, equivalent to `string & {}`). It does not include `WarningCode`
on purpose: warnings are not stored as notices.

## Stability rules

- **Stable** (a change is breaking, api-stability.md item 5): every code in `HARNESS_ERROR_CODES`,
  `HARNESS_NOTICE_CODES` and `WARNING_CODES`; the rule that `EH_*` ends or refuses an operation and
  `W_*` is non-fatal; that a failed turn always carries a code (`EH_RUN_FAILED` at worst).
  New codes are additive (minor). Consumers must treat the lists as open: a `switch` needs a default.
- **Not stable**: `message` wording, `details` keys other than the ones spec 10 names, which of two
  matching codes wins when a failure fits several (for example `EH_PROVIDER` versus `EH_RUN_FAILED`
  for an exotic provider error), log output.
- **Draft modules** (see api-stability.md) may add, rename or retire their own codes in a minor.

## Thrown / returned codes (`HARNESS_ERROR_CODES`)

| Code | Thrown or reported by | Reaches |
|---|---|---|
| `EH_CONFIG_INVALID` | `defineHarnessAgent`, `definePlugin`, session open, `memory`, `ask`, `shell`, `connectors` option validation | thrown at boot; run error at session open |
| `EH_MCP_TIMEOUT` | `mcpServerSource` | reported as `W_TOOL_SOURCE_FAILED` |
| `EH_DUPLICATE_TOOL`, `EH_DUPLICATE_SKILL`, `EH_DUPLICATE_DATA_PART` | static registry, message registry, session open | boot / `ready()` |
| `EH_SERVICE_CONFLICT`, `EH_SERVICE_MISSING`, `EH_PLUGIN_ORDER` | plugin boot (`define-agent`), `ctx.services` | boot / `ready()` |
| `EH_SESSION_BUSY`, `EH_SESSION_CLOSED` | turn operations, locks, `session.abort()`, closed sessions; mapped to 409 by `eharness/http` | thrown by turn operations, otherwise run error |
| `EH_INVALID_INPUT`, `EH_PENDING_RESPONSE`, `EH_INVALID_MESSAGE` | `inject`, turn operations, `output`, `scheduler`, `activity` attention, stored-message validation | `inject` throws; turn operations return a run error |
| `EH_STORAGE`, `EH_LOCK_UNAVAILABLE` | adapters and `SessionLock` failures wrapped by the core | run error / thrown by `ready()`, `messages()`, `compact` |
| `EH_COMPACTION_FAILED` | `session.compact()` (thrown) | thrown; automatic compaction uses `W_COMPACTION_FAILED` |
| `EH_CONTEXT_OVERFLOW` | `loop` (context could not fit) | `error.code` of a stopped turn |
| `EH_EVENTS_OVERFLOW` | `session.events()` slow reader | errors the event stream |
| `EH_PROVIDER_AUTH`, `EH_PROVIDER`, `EH_RUN_FAILED` | `describeError` classification of a failed model call; also `ClassifierUnavailableError`, `JudgeUnavailableError` (`EH_PROVIDER`) | `error.code` only, never thrown |

## Notice codes (`HARNESS_NOTICE_CODES`)

| Code | Emitted by | Stored as |
|---|---|---|
| `EH_TURN_INTERRUPTED` | `session.recover()`, `subagent` background recovery, `activity` plugin | `eh.notice` |
| `EH_INPUT_BLOCKED` | `input.submit` hook block with `persist: true` | `eh.notice` |
| `EH_TURN_TIMEOUT` | turn end after `loop.turnTimeoutMs` | `eh.notice` |
| `EH_CONTEXT_THRASH` | turn end after `stop: 'context-thrash'` | `eh.notice` |
| `EH_COST_CAP` | `budgetNotice()` of `eharness/limits` | `eh.notice` |

## Warning codes (`WARNING_CODES`)

All are stable and delivered through `onWarning` (default: `console.warn`). Grouped by emitter:

| Area | Codes |
|---|---|
| Registry and tools | `W_SHADOWED`, `W_TOOL_SOURCE_FAILED`, `W_INVALID_TOOL_NAME`, `W_TOOL_ORDER`, `W_TOOL_OUTPUT_LIMITED`, `W_TOOL_INPUT_REPAIRED`, `W_TOOL_MEDIA_OFFLOAD`, `W_GRANT_IGNORED`, `W_PAGE_CONTEXT_LIMITED`, `W_DEPRECATED` |
| Skills | `W_INVALID_SKILL`, `W_SKILL_SOURCE_FAILED` |
| MCP | `W_MCP_DRIFT` |
| Messages and stream | `W_INVALID_MESSAGE`, `W_REPAIRED_MESSAGE`, `W_UNKNOWN_DATA_PART`, `W_UNKNOWN_STORED_PART`, `W_WRITE_OUTSIDE_TURN`, `W_TRANSIENT_OVERRIDE`, `W_INVARIANT_VIOLATION`, `W_STREAM_LOG_FAILED` |
| Compaction and context | `W_COMPACTION_FAILED`, `W_COMPACTION_FLUSH_SKIPPED`, `W_CONTEXT_TRUNCATED`, `W_OVERFLOW_RETRY`, `W_CONTEXT_THRASH`, `W_CACHE_BUST` |
| Loop, budget, output | `W_CONTINUE_LIMIT`, `W_LOOP_STUCK`, `W_BUDGET`, `W_BUDGET_LEDGER_FAILED`, `W_MODEL_UNPRICED`, `W_DEFAULT_CONTEXT_WINDOW`, `W_OUTPUT_INVALID` |
| Hooks, sessions, inbox | `W_HOOK_FAILED`, `W_HOOK_TIMEOUT`, `W_SESSION_OPTIONS_IGNORED`, `W_ABORT_UNSUPPORTED`, `W_INBOX_FAILED`, `W_INBOX_DEAD_LETTER` |
| Shipped plugins | `W_GUARD_UNAVAILABLE` (`eharness/guard`, deprecated module), `W_WEB_NO_RESOLVER` (`eharness/web`) |

## Codes outside `codes.ts`

| Code set | Defined in | Stability |
|---|---|---|
| `EH_HTTP_*` (`HttpLayerErrorCode`) and `EH_INTERNAL` | `src/http/wire.ts`, status table in `src/http/errors.ts` | Draft with `eharness/http` (spec 26 §3); `EH_INTERNAL` is the 500 fallback |
| `IdentityErrorCode` (`ACCOUNT_LINKED_ELSEWHERE`, `PERSON_NOT_FOUND`, `INVALID_PERSON`; no `EH_` prefix) | `src/identity/types.ts` (`IdentityError`, `isIdentityError`) | Draft with `eharness/identity` |
| `CdpError.code` (a numeric CDP protocol code) | `src/browser/cdp/client.ts` | Draft with `eharness/browser` |
| `RetryAfter`, `SkipSend`, `PermanentSendError` | `src/channels/outbox.ts` | control-flow errors thrown by a channel sender; Draft |

## Review findings (open)

1. (Fixed) Spec 10 §1.2 said `HttpErrorCode` had no open string; it does, and the spec now says so.
2. `EH_HTTP_*` and `IdentityErrorCode` live outside `codes.ts` and outside the "every code is
   documented" test. Decide before 1.0 whether to fold them in or document the exception.
3. `src/http/errors.ts` has a `statusOfCode` that maps `EH_CONTEXT_OVERFLOW`,
   `EH_EVENTS_OVERFLOW` and `EH_CONFIG_INVALID` to the default 500; confirm that is intended.
4. `IdentityErrorCode` has no `EH_` prefix and `CdpError.code` is a number: the code conventions differ
   per module. Decide before 1.0 whether module errors follow `EH_<MODULE>_*`.
5. Spec 10 only lists `SummarizeError`, `ClassifierUnavailableError` and `HarnessHttpError` as sibling
   classes; `IdentityError`, `JudgeUnavailableError`, `CdpError` and the channel outbox errors
   should be added to that table.
