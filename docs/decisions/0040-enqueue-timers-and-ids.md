# ADR-0040: `enqueue()` timers and caller ids (routines on the inbox)

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0024](0024-durable-inbox-port.md), [ADR-0026](0026-inbox-retries-and-dead-letter.md)

## Context

Products built on eharness need routines (cron-like fires), reminders and retried webhooks. The
durable inbox already has timers (`availableAt`), claims, leases, retry and dead-letter, but
`session.enqueue()` did not expose the timer, and a producer that retries (a tick that crashed
between "advance the schedule" and "enqueue") had no way to make a fire idempotent. A scheduler
port was considered and rejected: cron, queues and timers are the application's infrastructure.

## Decision

`EnqueueOptions` gains `availableAt?: number` and `id?: string`. `EnqueueResult` gains
`duplicate?: true`.

- `availableAt` is stored on the inbox item (rule 14 timer). The enqueuing process arms a drain at
  that time; other instances use notify or poll. Refused with `mode: 'collect'` and, in the future,
  without an inbox (no durable timer).
- `id` is stored as `item.dedupeKey`. The inbox item id stays adapter-assigned and time-sortable
  (adapters rely on it for ordering), so the caller id cannot be the item id. A new optional
  adapter method `enqueueOnce(sessionId, item)` returns `{ id, duplicate }` atomically; plain
  `enqueue` keeps its `Promise<string>` signature, so existing adapters and callers are untouched
  (an adapter without `enqueueOnce` makes `enqueue(…, { id })` an `EH_INVALID_INPUT`).
- **Dedupe horizon: 24 hours after the ack** (minimum an adapter must keep; `memoryInbox` default,
  configurable). Keys of items still stored in any state always dedupe. Forever-uniqueness would
  need an unbounded key table; the horizon covers at-least-once producers, and ids that embed the
  logical event (`sched:<id>:<scheduledAt>`) never collide with later events.

The routines pattern (schedule row, compare-and-set tick, overlap and missed-fire skip, pause) is
documented in the multi-instance guide; no `eharness/scheduler` module until a second product
repeats it.

## Consequences

+ Routines, reminders and idempotent producers with no new port.
+ Additive: no adapter or caller breaks.
− Database adapters need a unique `(session_id, dedupe_key)` index and a TTL job for key rows.
