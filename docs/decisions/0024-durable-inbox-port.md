# ADR-0024: Durable inbox port

Status: **Proposed** · Date: 2026-10-05

## Context

Steering, queueing and wake-ups (spec 11 §6) worked only inside the process that ran the turn:
the queue was an in-memory FIFO per live session, `inject(…, { wake })` needed the session live
in the right process, and a `SessionLock` rejection was a run error. Behind a load balancer the
follow-up message, the background event or the Stop button usually reaches another instance
than the one running the turn. Applications rebuilt the same thing every time: a job table,
"who runs this session", redelivery and duplicate suppression. Chat apps also want bursts of
messages (WhatsApp, Telegram) answered once, not once per message.

## Decision

- **An optional port, not an application job queue.** `InboxAdapter` (`enqueue`, `claim`, `ack`,
  `release`, optional `notify` / `subscribe` / `pending`) sits next to `MessageAdapter` and
  `StateAdapter` as `storage.inbox`. The core decides what an item means (steer into the running
  turn, next turn, merged burst, wake turn, abort), the adapter only stores and hands out items.
  Without an inbox, 0.3 behaviour and storage are unchanged.
- **Whoever holds the session drains.** There is no session-to-process routing. The instance
  running a turn claims on notify / poll and at turn end; when nobody runs one, any live
  instance that is free claims and runs the next unit. A claimer that finds a live foreign
  `activeTurn` releases what it claimed and stops claiming until that turn is gone. The
  `SessionLock` / `activeTurn` CAS remain the arbiters of who runs a turn; the inbox adds no lock.
- **At-least-once with dedupe.** Items are acked only after their effect is durable (user message
  saved at the commit point, steer in a saved snapshot, wake turn committed, abort applied). A
  claim expires after `claimTtlMs` (default `recovery.staleMs`), so a dead claimer's items are
  redelivered. Redeliveries are recognised by `metadata.eharness.inboxId` / `collected` on user
  messages, `inboxId` on `data-eh.input` parts and `state.core.inboxDelivered` (last 100 ids,
  written with the commit-point state write), and are acked without effect.
- **Explicit API.** `send()` keeps its 0.3 semantics (a session busy in another instance is a run
  error `EH_SESSION_BUSY`). The cross-process path is `session.enqueue(input, { mode, collect })`
  resolving `{ inboxId, target: 'local' | 'remote' }` — no new stop reason, no run for a turn
  that streams in another process (cross-process resumable streams are roadmap).
- **Collect is a debounce, not a batching window.** `collect` inputs are merged into one user
  message after `quietMs` without a new one, `maxWaitMs` since the first, or `maxItems`. Across
  processes the burst is claimed only when due (claim, check, release until then), so one
  claimer gets the whole burst. It also works in-process without an inbox
  (`send(…, { ifBusy: 'collect' })`, `enqueue()` without `storage.inbox`).
- **Memory adapter and conformance only** (ADR-0008). eharness ships `memoryInbox()` and
  `inboxAdapterConformance`; a Postgres adapter (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`) is
  an example in `examples/postgres-inbox.ts`.
- **Abort prefers the inbox.** `requestAbort()` enqueues an `abort` item for the live foreign
  turn (lower latency with `subscribe`); the state request of ADR-0021 stays the fallback when
  the inbox is absent or its enqueue fails.

## Consequences

- One `claim` per `inbox.pollMs` (default 2 s) per live session with an inbox, plus a state read
  when a claim returned items; `subscribe` lowers latency but the poll stays as the safety net
  for lost notifications (`pollMs: 0` turns it off).
- A steer that misses the running turn goes back to the inbox and becomes a queued turn there;
  its `input.submit` hooks run again (`via: 'queue'`).
- `abort()` never drops durable items (they go back to the inbox); only in-memory queued turns
  are dropped.
- `SessionEvent` gains `inbox-enqueued` / `inbox-drained`; exhaustive switches must add cases.
- Rejected: routing every session to one owner process (needs a coordinator), exactly-once
  delivery (needs two-phase commit with the message store), making `send()` silently enqueue for
  another process (a run that never streams), dropping durable items on abort (data loss).

Spec: `docs/specs/05-session-and-storage.md` §12, `docs/specs/11-interaction.md` §6.
