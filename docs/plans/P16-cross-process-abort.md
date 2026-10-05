# P16 — Cross-process abort

Status: in progress · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal item **U4** (state-based part; the inbox-based path is added by P19).

## Goal

A "Stop" request that reaches any instance stops the turn running in another instance at its next
step boundary (or heartbeat), ending with `stop: 'aborted'` exactly like a local abort. It works
with only a `StateAdapter` that implements `setIf` — no inbox needed. P19 later adds an inbox
`abort` item for lower latency.

## Specs / docs to read

- `docs/specs/05-session-and-storage.md` §2 (`abort()`), §3 (step loop order, step barrier,
  heartbeat), §6 (hot cache: "turns perform no reads"), §7 (`StateAdapter.setIf`, `rev`,
  `SessionStateSnapshot.core`), §8 (concurrency), §9 (`activeTurn`, heartbeat cadence,
  `recovery.staleMs`)
- `docs/specs/11-interaction.md` §6.1 (`input-dropped` on `'aborted'`), §6.2 (queue dropped on
  abort)
- `docs/specs/10-errors-and-stop-reasons.md` §4 (`'aborted'`)
- `src/session/state.ts` (CAS write path, `cas` option)
- `docs/guides/writing-a-storage-adapter.md` (`setIf`)

**AI SDK:** no AI SDK API involved beyond the existing `abortSignal` plumbing.

## Owns

`src/session/**` (`state.ts`, `session.ts`, `turn.ts`, new `remote-abort.ts`), `src/loop/steps.ts`
(boundary check), `src/agent/types.ts` (`recovery` option), spec 05 / 11 / 10, ADR-0021,
`docs/guides/long-running-turns.md`, `examples/`.

## Design

```ts
// state (persisted, additive)
core.abortRequest?: { turnId: string; at: number; reason?: string; by?: string /* instance id */ }

// session API (additive)
interface HarnessSession {
  abort(reason?: string): void       // unchanged signature; also requests a remote abort when no local turn runs
  /** Awaitable form: tells where the abort went. */
  requestAbort(reason?: string): Promise<{ target: 'local' | 'remote' | 'idle' | 'unsupported' }>
}

// agent config
recovery?: { staleMs?: number; abortPollMs?: number /* default 2_000; 0 = off */ } | false
```

Rules (spec 05 new §9.1 "Cross-process abort"):

1. **Request.** `requestAbort()`: if a turn of this session runs in this process → local abort
   (`'local'`). Otherwise read state; no fresh `activeTurn` → `'idle'` (nothing written). With a
   live foreign `activeTurn` → write `core.abortRequest = { turnId: activeTurn.turnId, … }` with
   `setIf(rev)`; retry on conflict up to 3 times (re-read) → `'remote'`. Adapter without `setIf`
   → `'unsupported'` and `W_ABORT_UNSUPPORTED` (no blind `set`: it would clobber the owner's
   heartbeat/pending state). `abort()` calls `requestAbort()` fire-and-forget (errors → `ctx.log`)
   when no local turn runs.
2. **Target the turn, not the session.** The request names `turnId`; an owner ignores (and clears)
   a request for another turn id, so a late Stop never kills the next turn.
3. **Owner check.** The owning process checks for a request at every step boundary (before the
   model call) and on the heartbeat timer, but reads state at most every `abortPollMs` (one state
   read per interval, not per step — keeps hot turns close to "no reads", spec 05 §6 updated to
   name this exception). A matching request aborts the turn's controller with the stored reason →
   normal abort path (`stop: 'aborted'`, partial saved, dangling calls answered, queue dropped,
   `input-dropped` for waiting steers).
4. **Owner writes must not clobber requests.** While a turn runs, every owner state write
   (heartbeat, step-time writes, end of turn) uses `setIf` when the adapter has it; on conflict
   the owner re-reads, merges foreign `core.abortRequest` (the only field foreign instances may
   write during a live turn) into its snapshot and retries. The end-of-turn write clears a
   matching request. Spec 05 §7 documents `abortRequest` as the one foreign-writable field.
5. **Long tool calls.** The heartbeat timer also polls, so a turn stuck in a 10-minute tool is
   aborted mid-tool (the tool's `abortSignal` fires).
6. **Stale requests.** A request whose `turnId` is not the active turn is cleared by the next
   owner write or the next turn's commit-point write.
7. **Recovery disabled** (`recovery: false`): no `activeTurn` → remote abort is `'unsupported'`.

## Checklist

- [ ] ADR-0021 "Cross-process abort through state CAS" (why state not a new port, why turn-scoped,
      why polling with a cap, why `setIf` is required).
- [ ] Specs: 05 §2 (`requestAbort`, `abort()` note), §6 (poll exception), §7 (`abortRequest`,
      owner CAS writes), new §9.1; 10 (`W_ABORT_UNSUPPORTED`); 11 §6 (remote abort drops the
      remote queue); `stateAdapterConformance` note that `setIf` enables remote abort.
- [ ] Tests first (`src/session/remote-abort.int.test.ts`: two agent instances sharing
      `memoryState()` / `memoryMessages()`, scripted slow model):
  - [ ] instance B `requestAbort()` while A runs → `'remote'`; A stops at the next boundary with
        `'aborted'`, partial saved, `activeTurn` cleared, request cleared;
  - [ ] abort during a long tool (heartbeat poll) → tool's `abortSignal` fires;
  - [ ] a request for an older turn id does not abort the next turn;
  - [ ] A's heartbeat write racing B's request keeps the request (CAS merge);
  - [ ] adapter without `setIf` → `'unsupported'` + warning, nothing written;
  - [ ] idle session → `'idle'`; local turn → `'local'`;
  - [ ] `abortPollMs: 0` → no polling reads (adapter spy);
  - [ ] hot turn I/O budget: at most one extra state read per `abortPollMs`.
- [ ] Implement; wire the poll into the step boundary and heartbeat timer.
- [ ] Guide: `long-running-turns.md` "Stopping a turn from another instance"; offline example
      `examples/remote-abort.ts` (two agents, shared memory storage) in `examples.test.ts`.
- [ ] `reference.md`; changeset; board.

## Acceptance criteria

- [ ] Remote abort latency ≤ `abortPollMs` + one step boundary (or heartbeat tick during tools).
- [ ] No lost update of `abortRequest`, `pending`, `grants` under concurrent writes (stress test
      with randomized delays).
- [ ] Without `requestAbort` use, state I/O of a hot turn is unchanged except the bounded poll
      reads (documented in spec 05 §11).
- [ ] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New `session.requestAbort()`; `session.abort()` now also stops a turn running in another
  instance when the `StateAdapter` implements `setIf`.
- New persisted field `state.core.abortRequest`; new option `recovery.abortPollMs`; new warning
  `W_ABORT_UNSUPPORTED`.
- Behaviour: owner state writes during a turn use `setIf` when available (adapters must implement
  `setIf` atomically — already required by the conformance suite).
- Type-level: `HarnessSession` gains `requestAbort()` (custom implementations/mocks must add it).

## Open questions

- `abort()` stays `void` (changing it to `Promise` would break interface implementers);
  `requestAbort()` is the awaitable form. Decision made.
- Default `abortPollMs` 2 000 ms: one state read per 2 s per running turn. Conservative
  alternative: off by default. Decision: on, because a Stop button that does nothing is the bug
  being fixed; documented cost.
- Should a remote abort also drop the **remote** process's queued turns? Decision: yes, same as
  local abort (spec 11 §6.2).

## Requests to other phases

- P19 adds the inbox `abort` item (+ `notify`) and makes `requestAbort()` prefer the inbox when
  configured; the state path stays the fallback.
- P20: production guide "multi-instance" section; results table U4.

## Dependencies

P13 recommended first (state load single-flight, item 1; one live handle, item 6).
