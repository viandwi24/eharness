# Spec 34 — Clock (`eharness/clock`)

Status: **Draft (0.8)**. Module: `src/clock/*`. Builds on spec 01 (plugins) and 09 (tools).

A `datetime` tool, a `sleep` tool (§1.1, ADR-0067) and pure zone arithmetic. Models get dates, weekdays and time differences wrong
by hand. The module imports core only through `src/index.ts`, uses `Intl.DateTimeFormat` only (no
date library, runtime-neutral, no Node-only code). Generalised from the team app.

## 1. Plugin

```ts
clock({
  timezone: string | (() => string | Promise<string>),  // IANA; a function is read on every call
  toolName?: string,                                     // default 'datetime'
  now?: () => number,                                    // test seam
  sleep?: boolean | { toolName?, maxMinutes?, description? },  // also offer `sleep` (default off)
}): HarnessPlugin<'clock'>
```

One static tool (`metadata.risk: 'read'`, it never asks), identical for every session so it sits
in the cached prefix. Input: `action` (`now` default, `convert`, `add`, `diff`), `time`, `to`,
`from_zone`, `zone`, `months`, `weeks`, `days`, `hours`, `minutes`.

- `now`: the time in the default zone, in `zone` when given, and in UTC.
- `convert`: a moment shown in the default zone, `zone` and UTC.
- `add`: calendar-aware months, weeks and days in `from_zone` (the wall clock is kept across DST;
  Jan 31 + 1 month is the last day of February), then exact hours and minutes.
- `diff`: exact duration (words and minutes) and the calendar days apart in the default zone.
- A moment is `now`, `YYYY-MM-DD` (local midnight), `YYYY-MM-DD HH:MM[:SS]` in `from_zone`, or
  ISO 8601 with an offset or `Z`.
- Errors are strings starting `ERROR:` (unknown zone, unreadable moment, `add` without a unit);
  the tool never throws. An invalid default zone falls back to `UTC`.

### 1.1 `sleep` (ADR-0067)

```ts
sleepTool({ timezone, maxMinutes?: number /* 240 */, description?, now? }): Tool<{ minutes, reason? }, string>
```

Pause a turn for whole minutes without holding a process, so a worker can loop "do a batch,
sleep, repeat". It is an `externalTool()` (spec 11 §4.2) with `metadata.risk: 'read'`:

- The call parks the turn (`tool-pending`). Its `start` sets the wait's `timeoutAt` to now +
  `minutes` and `onTimeout` to `{ output: 'Woke up after sleeping N minutes (reason). It is now
  about <time in zone>. …' }`, plus `payload: { sleep: true, minutes, until }`.
- The session's wait timer continues the turn when it is due; after a restart the inbox timer or
  `session.expireWaits()` does. The tool's own `timeoutMs` is `maxMinutes`, so a wait whose
  `start` never ran (a crash right after the commit) still wakes.
- `minutes` outside 1..`maxMinutes` is an input error the model reads; nothing parks.
- An explicit `send()` to the session cancels the wait like any parked wait (the sleep ends
  early). Queued and inbox input is held while the session is parked (spec 11 §6.2); for a park
  child, `send_message` wakes a sleep and hands it the message (spec 20 §5.9).
- A durable background child parked only on external waits does not report to its parent
  (spec 20); it reports when it finishes.
- Nothing bounds the number of sleeps: use step or cost budgets (`eharness/limits`) and
  `session.abort()` / closing the session to stop a loop.

## 2. Helpers (pure, exported)

`isValidTimeZone`, `zonedParts(at, zone)`, `fromZoned(date, time, zone)` (a DST gap resolves
forward, an overlap to the first occurrence), `offsetLabel`, `formatInZone`, `nowLine` (one line
for a turn reminder), `parseDate`, `parseMoment`, `addDays`, `addToMoment`, `diffMoments`,
`durationWords`, `runDatetime` (the text answer of one call). Instants are epoch milliseconds;
`zonedParts` throws `RangeError` for an unknown zone, so check with `isValidTimeZone` first.

## Security notes

Read-only, no I/O, no secrets. `sleep` changes nothing; a parked sleep holds no lock and no
process.
