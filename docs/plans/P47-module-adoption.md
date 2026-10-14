# P47 — Products adopt the P46 modules fully

Status: done (2026-10-14). Owner: maintainer. Builds on [P46](P46-platform-rings.md).

## Why

P46 shipped `scheduler`, `identity`, `channels`, `handoff`, `limits` and `clock`, and the team app
moved its routines, clock, step budget, budget notice and mentions onto them. The people directory,
the outbox and rate governor, and the decision center still run on the team's own copies, and the
coder uses none of the new modules. Database adapter packages and the live chat product are out of
scope here (decided 2026-10-14).

## Work items

| # | Item | Wave | Status |
|---|---|---|---|
| W1 | Library follow-ups: `fire` may report that it did not fire (no `lastFireAt`), `update` with an expected version (compare-and-set edits), outbox flood-storm detection (several `RetryAfter` in a window open the breaker) | 1 | done |
| W2 | Team people directory on `eharness/identity`: pairing helpers and `pairingGuard`, `resolveRole`, `decideByRisk` with the team's member policy, and the SQLite store exposed as an async `PersonStore` passing the conformance suite | 1 | done |
| W3 | Team decision center on `eharness/handoff`: the escalation tools park and resume through the handoff plugin and store; Decision Center answers and chat ya/tidak replies use `resolveHandoff` | 1 | done |
| W4 | Team outbox and rate governor on `eharness/channels` (SQLite `OutboxStore` passing the conformance suite) | 2 | done, see notes |
| W5 | Coder uses `eharness/limits` (step budget, budget notice) and `eharness/clock` where it fits | 2 | done |

Behaviour of the production team app stays the same; any difference is listed in the item's notes.

## W4 notes (outbox and governor)

- Storage: the `channel_outbox` table is the library `OutboxStore` (migration 0034 adds `owner`,
  `lease_until`, `max_attempts`, `result`; old rows keep delivering). `sqliteOutboxStore(...).queue()`
  passes `outboxStoreConformance` (`test/outbox-store.test.ts`). Statuses stay the team's
  (`sending` = claimed, `sent`/`skipped` = done, `failed` = dead); a `skipped` result settles a row as skipped.
- One library `createOutbox` worker per connection (target = connection) replaces `due`, `flushPass`'s
  loop, retry bookkeeping and the backoff. `post` rows (tool calls) still send directly (`deliverOnce`).
- Library follow-ups (W4b, spec 31): `expiredLeases: 'hold'` (+ `held` state, `release`, store
  `holdExpired` and `claim({ reclaimExpired })`), terminal `skipped` (`SkipSend`, `store.skip`),
  `openBreaker`, `noteRateLimit` / `floods` / `floodStorm.stormKey` / `RetryAfter({ counted })`, function
  forms of `breaker.cooldownMs` and `floodStorm.count/windowMs`, and in the governor `charge`, `waitFor`,
  `reserve` (patient callers), `resetBuckets` and classes that are a function of the key.
- Team after W4b: the 10-year lease is gone. Rows use a 15 minute lease and `expiredLeases: 'hold'`; at
  boot `holdStale` holds every row a previous process left `sending` and `recoverRow` settles each
  `held` row as before (found on the platform = sent, absent = `release(id, 'retry')`, unknown =
  failed plus a bell). `held` rows block their conversation like `sending` did.
- Team governor: the buckets are the library governor's (classes are functions of the connection id, so
  per-connection overrides still apply live; `charge`/`waitFor`/`reserve` replace `Bucket`, `refill`,
  `waitOf`, `take`), and the flood storm is the library outbox's (`governor.onPark` calls
  `worker.noteRateLimit(parkKey, ms)`, `stormKey` = connection, count/window from the governor limits;
  a storm still calls `outbound.open`, same reason text and alert). `outbound.ts` keeps the sliding
  windows, `maxWaitMs`, in-process attempts and the failure-counting breaker (it counts every call, not
  only sends), but every trip and reset is mirrored to the worker (`onTrip` -> `openBreaker`,
  `onReset` -> `resetBreaker`). Team-only and kept: audit store, `GovernorLimited`, describe text, the
  adapter wrapper, `maxWaitMs`.
- Limits (unchanged, none edited): bot read 10/120, edit 10/60, admin 5/30, global 30/600 (burst/per
  minute), parkWaitMs 5000, storm 5 per 3 600 000 ms; user read 5/30, edit 3/15, admin 2/6, global 8/45,
  parkWaitMs 10 000, storm 3 per 3 600 000 ms; patient reserve min(2, burst-1) = lib `reserve: 2`
  clamped to `capacity - cost`; send windows (`policy.ts`) chatMinIntervalMs 1000, groupMax 20 per
  60 000, connectionMax 25 per 1000, maxWaitMs 120 000, maxAttempts 5, breakerFailures 5,
  breakerCooldownMs 300 000; delivery retry 5 000 to 300 000 ms, 10 attempts.
- Behaviour differences: (1) the library breaker of a connection is now opened with the outbound one,
  so queued rows of a paused connection wait without using delivery attempts (before they burned
  attempts on the "paused" error); (2) a storm also holds the library breaker for the longest flood wait
  seen in the window when that exceeds `breakerCooldownMs`; (3) new `held` row status (visible in
  `counts`); (4) bucket waits are computed by the library (same formula, float rounding may differ by 1 ms).
- Still open: a claim ordering hook (the team store keeps its conversation-order SQL), and the failure
  breaker over non-outbox calls stays in `outbound.ts`.

## W1–W3, W5 notes

- W1: `fire` may return `{ fired: false }`; optional `ScheduleStore.update(schedule, expectedVersion)`
  (compare-and-set edits, five attempts); outbox flood-storm detection with `rate-limited` and
  `storm` events.
- W2: the team's pairing codes, lockout, directory role rule and tool decisions come from
  `eharness/identity`; a frozen copy of the old `decideTool` is compared with the new one for every
  role, tool, risk and override set (`test/role-decisions.test.ts`); stored pairing codes stay valid.
- W3 (+W3b): Decision Center answers and chat replies to parked decisions go through
  `resolveHandoff` over a `HandoffStore` on the decisions table; the library gained `output`,
  `resume` and `metadata` on `resolveHandoff`, no re-delivery on a lost race, `redeliverHandoff`,
  `answer(…, { metadata })` and `startHandoff`. The team's escalation tools keep their own `start`.
- W5: the coder extends `loop.maxSteps` with `stepBudget` (`stepChunk`, default 50, up to
  `--max-steps`); its turn reminder shows the local date with the time zone.
