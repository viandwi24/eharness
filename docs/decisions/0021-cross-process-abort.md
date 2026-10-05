# ADR-0021: Cross-process abort through state compare-and-set

Status: **Proposed** · Date: 2026-10-05

## Context

`session.abort()` only reached a turn running in the same process. Behind a load balancer the Stop
request of a user often lands on another instance than the one running the turn; the button then
does nothing and the turn keeps spending tokens. The harness already persists a per-session state
snapshot with `activeTurn` (owner, heartbeat) and an optional compare-and-set write
(`StateAdapter.setIf`) for exactly-once approvals.

## Decision

- **State, not a new port.** The request is a field of the existing state snapshot,
  `core.abortRequest = { turnId, at, reason?, by? }`. Any deployment that already has a
  CAS-capable `StateAdapter` gets cross-process abort without new infrastructure. A durable inbox
  (P19) may later add a lower-latency path; the state path stays the fallback.
- **Turn-scoped.** The request names `turnId`, never just the session. A requester that re-reads
  after a conflict and finds another turn active gives up (`'idle'`); an owner ignores and clears
  requests for other turns. A late Stop can never kill the next turn.
- **`setIf` is required.** The requester writes only with compare-and-set. A blind `set` from a
  foreign instance would overwrite the owner's heartbeat, pending approvals and grants. Without
  `setIf` the request is `'unsupported'` (`W_ABORT_UNSUPPORTED`) and nothing is written.
- **Owners merge instead of clobbering.** While a turn runs, `abortRequest` is the one field a
  foreign instance may write. Every owner write during the turn uses `setIf`; on conflict the
  owner re-reads, takes over the stored request (and rev) and retries. A merged request for the
  running turn aborts it immediately.
- **Bounded polling.** The owner reads the state at most once per `recovery.abortPollMs`
  (default 2 s), at step ends and on the heartbeat timer (so a long tool call is aborted through
  its `abortSignal`), and not at all for turns shorter than that. This keeps the "hot turns
  perform no reads" property (spec 05 §6) except for one documented, bounded read.
- **API.** `abort()` keeps its `void` signature (changing it to a promise would break
  implementers) and requests the remote abort fire-and-forget when no local turn runs;
  `requestAbort()` is the awaitable form returning `'local' | 'remote' | 'idle' | 'unsupported'`.

## Consequences

- One extra state read per `abortPollMs` per running turn (configurable, `0` = off); owner writes
  during a turn become CAS writes when the adapter has `setIf` (adapters must implement it
  atomically, already required by the conformance suite).
- Latency is bounded by `abortPollMs` plus the current step (or one heartbeat tick in a tool).
- `HarnessSession` gains `requestAbort()`: custom implementations and mocks must add it.
- Rejected: a new `AbortPort` / pub-sub contract (more infrastructure for every app), session-wide
  abort flags (kill the next turn), polling on every step (breaks the no-reads hot path).

Spec: `docs/specs/05-session-and-storage.md` §9.1.
