---
"eharness": minor
---

**BREAKING:** session APIs for interactive and multi-session harnesses; a few results change.

- **BREAKING:** `send(input, { ifBusy: 'steer' })` returns the queued turn's run when the running turn refuses the steer at once (its step loop ended, or a manual `compact()` runs); before it returned an `attach()` of the running turn. `run.delivery` (`Promise<'step' | 'turn' | 'dropped'>`, type `SteerDelivery`) says what happened.
- **BREAKING:** `PendingState.clientTools[]` entries gain `input` (plus `inputTruncated: true` and no `input` above 16 KB). The pending state stays `v: 2`; assertions that compare entries with `toEqual` now see `input`.
- **BREAKING:** state writes of an owner with a `setIf` adapter are compare-and-sets that take over `core.children` on conflict (before, only writes during a turn were); the commit-point write no longer fails with `EH_SESSION_BUSY` when only a child registered meanwhile. Make sure your `StateAdapter.setIf` is a real compare-and-set.
- **BREAKING (type-level):** `WarningCode` gains `W_TOOL_ORDER`; `SessionStateSnapshot.core` gains `parent`, `children`, `forkedFrom`.
- `session.fork({ beforeMessageId?, id?, runtime?, copyState? })` creates a session from a prefix of the history and returns its opened handle (message ids kept; usage, grants, plugin state and compaction / rewind pointers copied; lineage in `core.forkedFrom`; `EH_SESSION_BUSY` while a turn runs). The new `session.fork` hook runs after the copy (a throwing hook is `W_HOOK_FAILED`; the fork succeeds).
- `session.children()` and `session.parentInfo()` read a durable parent / child index (`SessionOptions.parent` registers the child; append-only, capped at 500). `ctx.session.parent` is also set when an existing child session is opened without options.
- `session.onRun(listener)` is called synchronously whenever any turn of the session starts in this process (`send`, `respond`, `regenerate`, `edit`, queued turns, steer fallbacks, wakes from `inject`, inbox drains); every listener gets its own `HarnessRun`.
- `ctx.session.inject(kind, data, options?)` lets a plugin inject a kind message into its own session from tools, hooks and background work, with the semantics of `session.inject()`.
- `respond({ approvals: [{ id, approved, note }] })` takes a note (max 4 000 characters): an approved call's note is read by the model right after the tool result as `<user-note>` and stored as `approvalNote` of `data-eh.input`; a note on a denial is appended to its `reason`. `respond(…, { endTurn: 'after-answers' | 'if-denied' })` runs the approved tools without calling the model (the turn stops `'complete'` with `steps: 0`). `StepPrepareEvent.continuing` lists the tools a `respond()` answered on step 0.
- `TurnInfo.addUsage()` accepts plain token counts (`PlainUsage`, `AddUsageInput`) besides AI SDK usage.
