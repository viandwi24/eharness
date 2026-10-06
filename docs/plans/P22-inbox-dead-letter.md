# P22 — Inbox poison items, retries and dead-letter

Status: done · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art item **#8** and the 0.4.0 audit row "Inbox poison-item limit"
(`docs/plans/roadmap.md`). Verdict: GENERIC-core (eharness owns a durable inbox port).

Process (0.5.0): develop first, one gate at the end of the phase, consolidated review at the end
of the release.

## Goal

An inbox item that keeps failing — its unit fails before the commit point, or its holder keeps
dying — no longer cycles forever. Attempts are counted **at claim** (SQS receive-count semantics,
so crashes count), retries back off (fixed / exponential, jitter, cap), non-retryable failures go
straight to dead, and an item past `maxAttempts` becomes **dead**: kept by the adapter, reported
through an `inbox.onDeadLetter` callback, a session event and a warning, and recoverable with
`redrive(id)`. Optional `stats()` gives counts for dashboards. All of it is opt-in: without
`inbox.retry` behaviour is 0.4 (at-least-once, unlimited redelivery), and 0.4 adapters keep
working.

## Specs / docs to read

- `docs/specs/05-session-and-storage.md` §12 (whole section: `InboxAdapter`, rules 3, 5, 7, 8,
  10), §9 (`recovery.staleMs`), §3 (commit point)
- `docs/specs/04-streaming.md` §6 (`SessionEvent`)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (`EH_STORAGE`, `EH_INVALID_INPUT`), §2
  (`W_INBOX_FAILED`)
- ADR-0024 (durable inbox port), ADR-0008 (memory adapters only)
- `docs/plans/P19-durable-inbox.md` (design and decided open questions)
- `src/session/inbox/driver.ts` (claim / release / ack paths, `attempts > 1` reload),
  `src/storage/memory.ts` (`memoryInbox`), `src/testing/inbox-adapter.conformance.ts`,
  `examples/postgres-inbox.ts` (`eh_inbox_claim`), `docs/guides/multi-instance.md`,
  `docs/guides/writing-a-storage-adapter.md`

**AI SDK:** none (storage port). Prior art used for the semantics: SQS `maxReceiveCount` + redrive
(`https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html`),
BullMQ attempts/backoff (`https://docs.bullmq.io/guide/retrying-failing-jobs`), Trigger.dev retry
options (`https://trigger.dev/docs/errors-retrying`). Postgres facts for the example: re-verify
`FOR UPDATE SKIP LOCKED` and `pg_notify` against the Postgres 17 docs (as in P19). **No
devDependency bump.**

## Owns

`src/session/inbox/**`, the inbox types in `src/agent/types.ts` / `src/agent/session-types.ts`
(config `inbox.retry`, `onDeadLetter`, `SessionEvent` member), `memoryInbox()` in
`src/storage/memory.ts`, `src/testing/inbox-adapter.conformance.ts`, spec 05 §12, spec 04 §6,
spec 10 §2, ADR-0026 (new), `examples/postgres-inbox.ts`, `examples/inbox.ts`,
`docs/guides/multi-instance.md`, `docs/guides/writing-a-storage-adapter.md` (inbox section).

## Design

```ts
// InboxAdapter additions (all optional — 0.4 adapters stay valid)
release(ids: string[], opts?: {
  /** Item becomes claimable again only after now + delayMs (backoff). */
  delayMs?: number
  /** Deferral without an attempt: the core held the item (foreign turn, pending approvals,
   *  collect not due, turn running) — the adapter undoes the claim's attempt increment. */
  uncount?: boolean
  lastError?: string
}): Promise<void>
/** Move items to dead (kept, never claimed). Without it the core acks them after reporting. */
deadLetter?(ids: string[], info: { reason: string; lastError?: string }): Promise<void>
/** Dead → ready again (attempts reset to 0). Unknown / not dead ids are ignored. */
redrive?(ids: string[]): Promise<void>
/** Dead items, oldest first (for an admin UI). */
listDead?(opts?: { sessionId?: string; limit?: number }): Promise<DeadInboxItem[]>
/** Counts for metrics; `sessionId` omitted = whole inbox. */
stats?(opts?: { sessionId?: string }): Promise<{ ready: number; claimed: number; delayed: number; dead: number }>

export type InboxItem = InboxItemInput & { id: string; attempts: number; lastError?: string }
// every InboxItemInput member gains `availableAt?: number` (epoch ms): claimable only from then on
// (durable timers for P23 wait timeouts; a future item never blocks the head of line)
export type DeadInboxItem = InboxItem & { sessionId: string; deadAt: number; reason: string }

// config
inbox?: {
  …0.4 options,
  retry?: {
    maxAttempts?: number                         // default undefined = unlimited (0.4)
    backoff?: { type?: 'fixed' | 'exponential'; delayMs?: number /* 1_000 */; maxDelayMs?: number /* 60_000 */; jitter?: boolean /* true, full jitter */ }
    nonRetryable?: (error: { code?: string; message: string }) => boolean   // default: EH_INVALID_INPUT
  }
  onDeadLetter?: (item: DeadInboxItem) => void | Promise<void>               // errors → W_HOOK_FAILED-style warning
}
// SessionEvent: { type: 'inbox-dead'; inboxId; kind; reason; attempts }
// Warning: W_INBOX_DEAD_LETTER (details: { sessionId, inboxId, kind, attempts, reason })
```

Normative rules (spec 05 §12 new rules 11–15):

11. **Attempts at claim.** Every claim increments `attempts` (unchanged). A release that is a
    *deferral* (the core did not try to apply the item: foreign `activeTurn`, pending approvals,
    collect burst not due, running turn, items behind a started unit) passes `uncount: true`;
    a release after a **failed attempt** (unit failed before commit with `EH_STORAGE` /
    `EH_SESSION_BUSY` from the lock race, or a renewal could not be kept) passes `delayMs` from
    the backoff and `lastError`. A holder that dies releases nothing, so the claim expiry keeps
    the attempt (crash loops are counted).
12. **Dead.** With `retry.maxAttempts` set, a claimed item with `attempts > maxAttempts` is not
    applied: the core dead-letters it (`deadLetter?` or, without it, `ack`), then reports it
    (`onDeadLetter`, `inbox-dead`, `W_INBOX_DEAD_LETTER`). Reporting happens after the adapter
    call succeeded; a failed `deadLetter` is `W_INBOX_FAILED` (`operation: 'deadLetter'`) and the
    item is released (`uncount`), never lost.
13. **Non-retryable.** A unit that fails before its commit point with an error for which
    `nonRetryable` is true goes to dead immediately (reason `'non-retryable'`) instead of the 0.4
    silent ack. Blocked input (`input.submit` block) and an abort by its caller stay acks (they
    are outcomes, not failures). Without `retry` the 0.4 behaviour (ack) is kept.
14. **Ordering and holds.** A delayed item keeps its place: claims never return a `send` /
    `wake` item behind a delayed or held older item of the same session (head of line, rule 3);
    `abort` items are claimable regardless (rule 8: aborts are never held). The conformance suite
    checks both.
15. **Redrive.** `redrive(ids)` resets `attempts` and makes items claimable in their original id
    order; the core exposes no wrapper (it is an adapter operation; the guide shows an admin
    route). `abort` items are never dead-lettered (they are acked when stale, rule 4).

At-least-once and dedupe (rule 5) are unchanged: a redelivered item already applied is acked by
the stored-view dedupe before any attempt logic runs.

## Checklist

- [x] ADR-0026 "Inbox retries and dead-letter" (amends ADR-0024): attempts at claim, `uncount`
      deferrals, opt-in limits, dead kept by the adapter, why no core redrive wrapper.
- [x] Spec 05 §12: adapter additions (optional members, `release` options), config, rules
      11–15; spec 04 §6 `inbox-dead`; spec 10 §2 `W_INBOX_DEAD_LETTER`, `W_INBOX_FAILED`
      operations `deadLetter`.
- [x] Driver: classify every release as deferral / failed attempt; backoff computation (pure
      function with unit tests: fixed, exponential `delayMs × 2^(attempts-1)`, cap, full jitter
      with an injectable random); dead path; non-retryable classification.
- [x] `InboxItemInput.availableAt?` (rule 14): an item with a future `availableAt` is invisible
      and does **not** block older-to-newer ordering of other items (it is a timer, not a queue
      entry). Conformance case under `requireRetry`.
- [x] `memoryInbox()`: `availableAt`, `delayMs`, `uncount`, `lastError`, `deadLetter`, `redrive`, `listDead`,
      `stats`; head-of-line respects delayed items; abort items bypass.
- [x] Conformance (`inboxAdapterConformance(factory, { requireRetry?, requireDeadLetter?,
      requireStats? })`): attempts increment at claim and survive expiry; `uncount` restores;
      delayed item invisible until due and blocks later send/wake of its session but not abort;
      `lastError` round trip; dead items never claimed, listed, redriven in id order with
      attempts 0; `stats` counts; JSON round trip. Existing cases unchanged.
- [x] Integration (`src/session/inbox.int.test.ts` style, two simulated instances): a send whose
      unit always fails with `EH_STORAGE` goes dead after `maxAttempts` and the next item runs;
      a holder that "dies" after claim N times → dead (counted via expiry); a long foreign turn
      with 20 polls does **not** consume attempts (`uncount`); non-retryable invalid stored input
      → dead at once; without `retry` → 0.4 goldens; `onDeadLetter` failure does not lose the item.
- [x] `examples/postgres-inbox.ts`: columns `attempts`, `available_at`, `last_error`,
      `dead_at`, `dead_reason`; `eh_inbox_claim` respects `available_at` and head of line;
      `deadLetter` / `redrive` / `listDead` / `stats`; migration note for 0.4 tables (`ALTER TABLE
      … ADD COLUMN … DEFAULT`); conformance on the CI Postgres service (`DATABASE_URL`).
- [x] Guides: multi-instance "Poison items" section (choosing `maxAttempts`, alerting from
      `onDeadLetter`, redrive route, idempotency of side effects — read `idempotent` from P21);
      adapter guide checklist for the new members.
- [x] Changeset; board; gate.

## Acceptance criteria

- [x] A poison item stops blocking its session after `maxAttempts`; nothing is lost (dead items
      are listable and redrivable); nothing is applied twice.
- [x] Deferrals never consume attempts with `memoryInbox()` and the Postgres example.
- [x] Without `inbox.retry` behaviour and storage are identical to 0.4 (goldens, existing tests).
- [x] A 0.4-style adapter (no new members, `release` ignoring options) still passes the 0.4
      conformance cases and works without `retry`; with `retry` set and no `deadLetter`, dead
      items are acked after reporting (documented).
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- Inbox retries and dead-letter: `inbox.retry { maxAttempts, backoff, nonRetryable }`,
  `inbox.onDeadLetter`, session event `inbox-dead`, warning `W_INBOX_DEAD_LETTER`.
- `InboxAdapter` gains optional `deadLetter`, `redrive`, `listDead`, `stats` and `release`
  options (`delayMs`, `uncount`, `lastError`); `InboxItem.lastError?`; `memoryInbox()` and
  `inboxAdapterConformance` support them.
- Type-level: `SessionEvent` gains `inbox-dead` (exhaustive switches must add it); `WarningCode`
  gains a member.

## Open questions

1. **Default `maxAttempts`.** Pick: unlimited (opt-in), because 0.4 adapters may not implement
   `uncount` and would dead-letter healthy items behind long foreign turns. The guide recommends
   `maxAttempts: 5` with an adapter that passes `requireRetry`.
2. **Where dead items live** without `deadLetter`. Pick: acked after `onDeadLetter` ran
   (reported, then dropped) — documented as "bring a dead table".
3. **Lock-race `EH_SESSION_BUSY`** counted as an attempt? Pick: yes but with the minimum
   backoff (it is a real failed start); a foreign `activeTurn` seen before starting is a
   deferral.
4. Core-level `session.redrive()` / `agent.inbox.*` wrappers? Pick: none in 0.5.0 (adapter
   operations; avoids a second API surface).
5. **Drain-level failures** (state read / context load in an idle drain) — attempt or deferral?
   Picked (implementation): a deferral (`uncount`) with the minimum backoff and `lastError`, so a
   storage outage never dead-letters a healthy backlog; a crash loop is still counted by claim
   expiry. Errors of the *turn* before its commit point stay counted (rule 11).
6. **Other errors before the commit point** (neither `EH_STORAGE` / `EH_SESSION_BUSY` nor
   non-retryable, e.g. a throwing hook): 0.4 acked them silently. Picked: with `retry` they are
   failed attempts (backoff, then dead after `maxAttempts`) — nothing is dropped silently; without
   `retry` they are still acked (0.4).
7. **`close()` after the commit point** (a wake unit whose end-of-turn write did not happen):
   counted as a failed attempt so the next claimer reloads before dedupe (`attempts > 1`);
   `close()` before the commit point is a deferral.
8. **Aborts behind a held item.** Rule 14 lets `abort` items pass a *delayed* item only; behind an
   item another owner holds nothing is claimable, as in 0.4 (most conservative: an abort claimed
   by a non-holder would be acked without effect).
9. **Default backoff type** not fixed by the design: picked `'exponential'`.
10. **"A renewal could not be kept"** (rule 11 draft): the driver cannot observe a lost claim, so
    it is not a separate case; an expired claim is counted by the next claim (crash semantics).
11. **0.4 hot loop.** Without `retry`, a unit that always fails with `EH_STORAGE` is released and
    claimed again at once (unchanged 0.4 behaviour; with in-memory adapters this starves timers).
    The integration test simulates I/O latency; the guide recommends `retry` for production.
12. **Postgres delay column.** The design listed `available_at` only; the example adds
    `delayed_until` as well, because a backoff delay keeps its place (holds back later
    `send` / `wake` rows) while an `availableAt` timer holds nothing back.

## Requests to other phases

- P23: uses `availableAt` (built here) for durable wait timeouts and adds the item kind
  `wait-timeout`; P23 extends rule 14 for that kind only.
- P29: production guide + results table row #8.

## Dependencies

None (wave W1, parallel with P21). P23 depends on this phase.
