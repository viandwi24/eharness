---
"eharness": minor
---

Cross-process abort (spec 05 §9.1, ADR-0021).

- New `session.requestAbort(reason?)` → `{ target: 'local' | 'remote' | 'idle' | 'unsupported' }`.
  `session.abort()` keeps its signature and now also stops a turn running in another instance when
  no turn of the session runs locally and the `StateAdapter` implements `setIf`. The owning
  instance stops at its next step boundary or heartbeat tick (a running tool's `abortSignal` fires)
  with `stop: 'aborted'`, exactly like a local abort.
- New persisted field `state.core.abortRequest` (turn-scoped: a late Stop never aborts the next
  turn); new option `recovery.abortPollMs` (default 2 000 ms, `0` = off); new warning
  `W_ABORT_UNSUPPORTED`; new types `AbortRequest`, `AbortRequestResult`.
- Behaviour: while a turn runs, the owner's state writes (heartbeat, compaction, end of turn) use
  `setIf` when available and merge a foreign `abortRequest` on conflict; a running turn reads the
  state at most once per `abortPollMs`.
- Type-level: `HarnessSession` gains `requestAbort()` (custom implementations and mocks must add it).
