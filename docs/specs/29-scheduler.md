# Spec 29 — Scheduler (`eharness/scheduler`)

Status: **Draft (0.8)**. Module: `src/scheduler/*`. Builds on spec 05 (sessions, inbox), ADR-0040
(`enqueue` timers and ids), ADR-0062 (supersedes the "no scheduler module" line of ADR-0040).

Cron-like, interval and one-shot schedules that fire into sessions, safe across many instances.
Four products repeat the pattern (team routines, automation, live chat reminders, coder), so the
library ships it. The module imports core only through `src/index.ts`, has no Node-only code and
no dependency: the **cron calculator is injected** (rule 10), storage is a port, and what a fire
does is an app callback (normally `session.enqueue`).

## 1. API

```ts
const scheduler = createScheduler({
  store,                       // ScheduleStore (memoryScheduleStore() ships)
  fire,                        // ({ schedule, scheduledAt, fireId }) => void | { fired?: boolean } | Promise<…>
  next?,                       // (expr, after, timezone?) => number | undefined  (cron)
  now?, tickMs?, leaseMs?, graceMs?, maxPerTick?, owner?, onError?,
})
scheduler.start(); await scheduler.stop(); await scheduler.tick()
scheduler.create(input); update(id, patch); pause(id); resume(id); remove(id); fireNow(id)
```

`Schedule`: `id`, `sessionId`, `spec` (`{ kind: 'cron', expr, timezone? }` | `{ kind: 'interval',
everyMs }` | `{ kind: 'once', at }`), `payload` (JSON), `state` (`active` | `paused`), `overlap`
(`skip` | `queue`), `catchUp` (`skip` | `once` | `{ max }`), `nextFireAt` (`null` when exhausted),
`lastFireAt?`, `claimedBy?`, `claimedUntil?`, `version`, `metadata?`.

Defaults: `tickMs` 15 000, `leaseMs` 30 000, `graceMs` `max(2 × tickMs, 1000)`, `maxPerTick` 50,
`owner` a UUIDv7, `overlap` and `catchUp` `skip`.

## 2. The store port

`get`, `list({ sessionId?, state?, limit?, cursor? })` (ordered by id, `nextCursor`), `put`, `delete`,
`update?(schedule, expectedVersion)`, `due(now, limit)`, `claim(id, version, owner, leaseUntil)`, `complete(id, owner, { nextFireAt,
lastFireAt? })`, `release(id, owner)`. All async.

1. `put` creates or replaces; **the store assigns `version`** (previous + 1, `1` on create) and
   returns the stored row.
2. `due(now, limit)` returns active rows with `nextFireAt <= now` that are unclaimed or whose claim
   expired (`claimedUntil <= now`), oldest first.
3. `claim` is a compare-and-set on `version` (and `state === 'active'`). Every claim bumps
   `version`, so of several claimers holding the same row exactly one wins. It returns the updated
   row or `undefined`.
4. `complete` and `release` act only when `claimedBy === owner`; otherwise they return
   `undefined` / `false` (a dead owner's late completion is a no-op).
5. `update(schedule, expectedVersion)` (optional) is a compare-and-set replace: it writes only
   when the row exists with `expectedVersion`, bumps the version and returns the row, otherwise
   it returns `undefined` and writes nothing.
6. Results are copies; callers never share mutable state with the store.

## 3. Tick

`tick()` (also run by `start()` every `tickMs`; ticks of one scheduler never overlap):

1. `due(now, maxPerTick)`.
2. For each row `claim(row.version, owner, now + leaseMs)`. A lost claim is skipped silently. A row
   that was already claimed (expired lease) counts as `recovered`.
3. Collect the slots `nextFireAt … now` (latest 1000 kept). A slot older than `graceMs` is
   **missed**, the others are **fresh**.
4. Missed slots follow `catchUp`: `skip` drops them, `once` fires the latest, `{ max: n }` the
   latest `n`. Fresh slots follow `overlap`: `queue` fires all, `skip` fires only the latest.
5. `fire({ schedule, scheduledAt, fireId })` per slot, oldest first, awaited.
6. `complete` with the slot after `now` (`null` for `once` or an exhausted cron) and `lastFireAt`.

`fire` may resolve to `{ fired: false }` ("slot handled, nothing fired"): the slot is reported in
`TickReport.skipped` with reason `declined`, not in `fired`, and `lastFireAt` is set only from slots
that fired (when none did, `complete` carries no `lastFireAt` and the stored one is unchanged).
`nextFireAt` advances either way. `void`, `undefined` and `{ fired: true }` mean fired.

If `fire` throws, the error goes to `onError`, the row is **released without advancing** and the
slot is retried on the next tick. Slots already fired in that tick fire again with the same ids.

## 4. Idempotence

`fireId = "sched:<id>:<scheduledAt>"` is deterministic. The app passes it as
`session.enqueue(prompt, { id: fireId, availableAt: scheduledAt })` (ADR-0040), so a retried or
recovered tick enqueues each slot at most once (within the inbox dedupe horizon).

## 5. Overlap

A row claimed with a live lease is invisible to `due`, so while one instance is still inside a slow
`fire` no other instance fires the same schedule. Slots that came due meanwhile are fresh when the
claimer completes: `overlap: 'skip'` collapses them to the latest, `'queue'` fires each. Apps that
need "previous run still working" semantics beyond the claim (a busy session) check it in `fire`
and return without enqueueing.

## 6. Management

1. `create` refuses an existing id, validates the spec and computes `nextFireAt` (`interval`:
   now + `everyMs`; `cron`: `next(expr, now, timezone)`; `once`: `at`, even if past, so
   `catchUp` decides).
2. `update` merges the patch; a new `spec` recomputes `nextFireAt` from now.
3. `pause` sets `state: 'paused'` (never due, never claimable). `resume` recomputes `nextFireAt`
   from now, so slots that passed while paused are dropped; a pending `once` keeps its slot.
4. `remove` deletes the row (`true` when it existed).
5. `fireNow(id)` fires immediately with `scheduledAt = now` and returns the `fireId`; it does not
   move `nextFireAt` and does not claim.
6. `update`/`pause`/`resume` are read-modify-write with compare-and-set: they write through
   `store.update(row, readVersion)` and, on a conflict (a concurrent fire, claim or edit), re-read
   and re-apply the change, up to 5 attempts, then throw `EH_INVALID_INPUT` with reason `conflict`.
   A fire's `nextFireAt`/`lastFireAt` advance is therefore never overwritten by an edit and vice
   versa. A store without `update` falls back to `put` (last writer wins).

## 7. Cron

Core has no cron parser. `next(expr, after, timezone?)` returns the first slot strictly after
`after`, or `undefined` when none remains. A cron schedule without `next` is refused at `create`.

## 8. Errors

Programmer errors throw `HarnessError('EH_INVALID_INPUT')` with `details.reason`:
`cron-unsupported` (no `next`), `spec-invalid`, `spec-exhausted` (cron without a future slot),
`exists`, `not-found`, `conflict` (edit kept conflicting). Fire failures never throw out of `tick()`; they are counted in
`TickReport.failed` and sent to `onError`. `fireNow` rethrows the callback's error.

## 9. Conformance

`scheduleStoreConformance(factory)` from `eharness/testing` returns cases for the store port:
version assignment, list filters and paging, `due` selection, single-winner `claim`, lease expiry
and takeover, owner-only `complete`/`release`, paused rows, `update` compare-and-set (skipped when the store has no `update`), copy isolation.
