# Scheduler

`eharness/scheduler` fires cron, interval and one-shot schedules into sessions. Every instance
runs the same scheduler against a shared `ScheduleStore`; compare-and-set claims make one instance
fire each slot, and the deterministic `fireId` makes retries idempotent. Contract:
[spec 29](../specs/29-scheduler.md).

Cron parsing is not bundled. Inject a `next` function from the library you prefer, for example
`croner`:

```ts
import { Cron } from 'croner'
import { createScheduler } from 'eharness/scheduler'
import { memoryScheduleStore } from 'eharness/scheduler'

const scheduler = createScheduler({
  store: memoryScheduleStore(), // use a database-backed ScheduleStore in production
  next: (expr, after, timezone) =>
    new Cron(expr, { timezone }).nextRun(new Date(after))?.getTime(),
  fire: async ({ schedule, scheduledAt, fireId }) => {
    const session = await harness.session(schedule.sessionId)
    await session.enqueue(String(schedule.payload), { id: fireId, availableAt: scheduledAt })
  },
  onError: (error, { scheduleId }) => console.error('schedule', scheduleId, error),
})

await scheduler.create({
  id: 'daily-report',
  sessionId: 'team:reports',
  spec: { kind: 'cron', expr: '0 9 * * 1-5', timezone: 'Europe/Berlin' },
  payload: 'Write the daily report.',
  catchUp: 'once', // after downtime, fire the latest missed slot once
})

scheduler.start() // on shutdown: await scheduler.stop()
```

Notes:

- `catchUp` (`skip` | `once` | `{ max }`) decides what happens to slots missed during downtime;
  `overlap` (`skip` | `queue`) what happens to slots that came due while a slow fire was running.
- Serverless: skip `start()` and call `await scheduler.tick()` from your platform cron.
- A `ScheduleStore` needs an atomic `claim` (a `UPDATE … WHERE id = ? AND version = ?`). Run
  `scheduleStoreConformance` from `eharness/testing` against your adapter.
