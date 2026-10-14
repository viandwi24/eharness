# ADR-0063: `eharness/scheduler`

Status: **Accepted** · Date: 2026-10-14 · Amends: [ADR-0040](0040-enqueue-timers-and-ids.md) · Plan: [P46](../plans/P46-platform-rings.md)

## Context

ADR-0040 added inbox timers and caller ids and kept the routines pattern (schedule rows, a
compare-and-set tick, overlap and missed-fire policies) as a documented pattern: "no
`eharness/scheduler` module until a second product repeats it". The team app built it (routines,
reminders, programs), and the automation system and the live chat (follow-ups, office hours) need
the same machinery. That meets the rule of two (ADR-0062).

## Decision

- New runtime-neutral module `eharness/scheduler` (Draft, spec 29): a `ScheduleStore` port (async,
  compare-and-set claims with leases), `memoryScheduleStore`, and `createScheduler` that ticks on
  every instance, claims due schedules, applies catch-up and overlap policies and calls the app's
  `fire` with a deterministic fire id `sched:<id>:<scheduledAt>`, so `session.enqueue(…, { id,
  availableAt })` dedupes a retried tick.
- **No cron dependency.** Interval and one-off schedules work out of the box; cron expressions need
  an app-provided `next(expr, after, timezone)` (for example croner). The core keeps zero runtime
  dependencies.
- A conformance suite `scheduleStoreConformance` in `eharness/testing`.

## Consequences

+ One scheduler for routines, reminders, programs, follow-ups and automations.
+ Fires stay idempotent through the inbox ids of ADR-0040.
− Apps with cron schedules wire a parser themselves.
