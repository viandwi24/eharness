# ADR-0026: Inbox retries and dead-letter

Status: **Proposed** · Date: 2026-10-06 · Amends: ADR-0024

## Context

The 0.4 durable inbox (ADR-0024) is at-least-once with unlimited redelivery. An item whose unit
keeps failing before its commit point (`EH_STORAGE`, a lock race) or whose holder keeps dying is
released or redelivered forever, and — because of head-of-line claims — it blocks every later item
of its session. Every queue in production grows the same three tools: a receive count, a backoff
and a dead-letter store (SQS `maxReceiveCount` + redrive, BullMQ attempts/backoff, Trigger.dev
retry options). P23 (durable wait timeouts) also needs items that become claimable later.

## Decision

- **Attempts are counted at claim** (SQS receive-count semantics), as in 0.4. A holder that dies
  releases nothing, so the expired claim keeps its attempt: crash loops are counted.
- **Deferrals are not attempts.** The core classifies every release. When it held an item without
  trying it (a live foreign `activeTurn`, pending approvals, a `collect` burst not due, a running
  turn, the items parked behind a started unit, a missed steer, `close()` before the commit point,
  a failure to read the session's own state or context) it passes `release(ids, { uncount: true })`
  and the adapter undoes the claim's increment. A **failed attempt** (the unit failed before its
  commit point, a write after it failed) passes `delayMs` from the backoff and `lastError`.
- **Opt-in limits.** `inbox.retry { maxAttempts, backoff, nonRetryable }` and `inbox.onDeadLetter`.
  Without `retry` releases carry no options and behaviour is 0.4. `maxAttempts` defaults to
  unlimited because a 0.4 adapter that ignores `uncount` would dead-letter healthy items behind a
  long foreign turn.
- **Dead items are kept by the adapter** (`deadLetter`, `listDead`, `redrive`, all optional).
  The core dead-letters at claim (`attempts > maxAttempts`, after dedupe, never `abort` items) or
  at once for a non-retryable failure (default `EH_INVALID_INPUT`), then reports
  (`onDeadLetter`, `inbox-dead` event, `W_INBOX_DEAD_LETTER`). Without `deadLetter` the
  application's `onDeadLetter` is the dead store: it runs first and the item is acked only when it
  returned; a failing `deadLetter` / `onDeadLetter` releases the item — never lost.
- **Delays keep their place, timers do not.** A failed attempt delayed by `delayMs` still holds
  back the `send` / `wake` items behind it (id order), but not `abort` items (aborts are never
  held). An item enqueued with a future `availableAt` is a durable timer: invisible and holding
  nothing back until due (P23 builds wait timeouts on it).
- **No core redrive wrapper.** Redrive is an operator action on the adapter (`redrive(ids)`,
  attempts reset to 0, original id order); a second API surface on the session/agent would only
  forward to it. The multi-instance guide shows an admin route.
- `stats()` (optional) gives `ready` / `claimed` / `delayed` / `dead` counts for dashboards.

## Consequences

- `InboxAdapter` gains optional members and `release` options. Adapters written for 0.4 keep
  compiling and working without `retry`; a custom adapter must implement them (and pass
  `inboxAdapterConformance(…, { requireRetry, requireDeadLetter })`) before `retry.maxAttempts` is
  safe to turn on. `SessionEvent` and `WarningCode` gain a member each.
- A storage outage is not an item failure: a drain that cannot read the session releases its items
  as deferrals (with the minimum backoff), so an outage never dead-letters a healthy backlog. A
  unit whose turn fails with `EH_STORAGE` / `EH_SESSION_BUSY` is counted (rule 11; the lock race
  gets the backoff of a first attempt).
- At-least-once and dedupe are unchanged: a redelivered item already applied is acked by the
  stored-view dedupe before any attempt logic runs, so redrive never applies an item twice.
- Rejected: a default `maxAttempts` (unsafe with 0.4 adapters), counting attempts only on
  explicit failures (misses crash loops), a separate dead-letter session or table in the core
  (storage is the application's, ADR-0008), dead-lettering on every failure after the limit
  instead of at the next claim (one path, and the adapter records `lastError` either way).

Spec: `docs/specs/05-session-and-storage.md` §12 (rules 11–15), `docs/specs/04-streaming.md` §6,
`docs/specs/10-errors-and-stop-reasons.md` §2.
