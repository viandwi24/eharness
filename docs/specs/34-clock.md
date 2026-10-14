# Spec 34 — Clock (`eharness/clock`)

Status: **Draft (0.8)**. Module: `src/clock/*`. Builds on spec 01 (plugins) and 09 (tools).

A `datetime` tool and pure zone arithmetic. Models get dates, weekdays and time differences wrong
by hand. The module imports core only through `src/index.ts`, uses `Intl.DateTimeFormat` only (no
date library, runtime-neutral, no Node-only code). Generalised from the team app.

## 1. Plugin

```ts
clock({
  timezone: string | (() => string | Promise<string>),  // IANA; a function is read on every call
  toolName?: string,                                     // default 'datetime'
  now?: () => number,                                    // test seam
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

## 2. Helpers (pure, exported)

`isValidTimeZone`, `zonedParts(at, zone)`, `fromZoned(date, time, zone)` (a DST gap resolves
forward, an overlap to the first occurrence), `offsetLabel`, `formatInZone`, `nowLine` (one line
for a turn reminder), `parseDate`, `parseMoment`, `addDays`, `addToMoment`, `diffMoments`,
`durationWords`, `runDatetime` (the text answer of one call). Instants are epoch milliseconds;
`zonedParts` throws `RangeError` for an unknown zone, so check with `isValidTimeZone` first.

## Security notes

Read-only, no I/O, no secrets.
