---
'eharness': minor
---

Scheduler: `fire` may resolve to `{ fired: false }` (slot handled, nothing fired: `nextFireAt`
advances, `lastFireAt` stays; reported as `skipped` with reason `declined`). `ScheduleStore` gains an
optional compare-and-set `update(schedule, expectedVersion)`; `scheduler.update/pause/resume` use it
with a retry loop so a concurrent fire and an edit no longer overwrite each other. The conformance
suite covers it. Channels: the outbox detects flood storms (`floodStorm: { count, windowMs, scope }`,
N `RetryAfter`s in a window open the breaker for the longest retry-after seen, per key or global) and
emits `rate-limited` and `storm` events.
