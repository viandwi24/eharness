---
"eharness": minor
---

Inbox retries and dead-letter: poison items no longer cycle forever or block their session
(spec 05 §12 rules 11–15, ADR-0026). Opt-in: without `inbox.retry` behaviour and storage are
those of 0.4.

- New config `inbox.retry { maxAttempts?, backoff?: { type?: 'fixed' | 'exponential', delayMs?,
  maxDelayMs?, jitter? }, nonRetryable? }` (defaults: unlimited attempts, exponential from 1 s
  capped at 60 s with full jitter, `EH_INVALID_INPUT` non-retryable) and `inbox.onDeadLetter(item)`
  (a throw is `W_HOOK_FAILED`). Attempts are counted at claim (a crashed holder counts); the core
  releases deferrals with `uncount` so a long turn of another instance never consumes attempts,
  and failed attempts with a backoff and `lastError`. An item past `maxAttempts`, or failing with a
  non-retryable error (including a stored input that no longer validates), is dead-lettered and
  reported: session event `inbox-dead`, warning `W_INBOX_DEAD_LETTER`.
- `InboxAdapter` gains optional `deadLetter`, `redrive`, `listDead`, `stats` and `release(ids,
  opts?)` options (`delayMs`, `uncount`, `lastError`); `InboxItem.lastError?`; every
  `InboxItemInput` member gains `availableAt?` (a durable timer: invisible and holding nothing back
  until due). New types `DeadInboxItem`, `InboxReleaseOptions`, `InboxStats`,
  `InboxRetryOptions`, `InboxBackoffOptions`. `memoryInbox()` implements all of it;
  `inboxAdapterConformance` gains `requireRetry`, `requireDeadLetter` and `requireStats`.
  `examples/postgres-inbox.ts` adds the columns (in-place `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS` upgrade of a 0.4 table) and recreates `eh_inbox_claim`.
- **Breaking for custom `InboxAdapter`s (only when `inbox.retry` is used):** the new members are
  optional and 0.4 adapters keep compiling and working without `retry`, but `retry.maxAttempts`
  is only safe with an adapter that honours the `release` options and `availableAt` (pass
  `inboxAdapterConformance(…, { requireRetry: true })`); an adapter without `deadLetter` acks dead
  items after `onDeadLetter` ran.
- Type-level: `SessionEvent` gains `inbox-dead` (exhaustive switches must add it); `WarningCode`
  gains `W_INBOX_DEAD_LETTER`; `W_INBOX_FAILED` gains the operation `deadLetter`.
