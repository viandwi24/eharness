# Spec 31 — Channels (`eharness/channels`)

Status: **Draft (0.8)**. Module: `src/channels/*`, conformance in `src/testing/channels.conformance.ts`. Builds on
spec 01 conventions and ADR-0008 (shipped modules use only the public API).

The platform-neutral **delivery machinery** every chat-platform product needs (team chat, live chat,
automation): rate limiting, a reliable outbox and safe mentions.

**Scope of this slice:** delivery (outbox + circuit breaker), rate (governor) and mentions.
**Not in this slice:** the gateway (platform adapters, inbound routing, identities, native
actions). It stays in the team app (`examples/team/server/src/infra/channels/`) and will be
generalised later. Platform specifics (Telegram flood waits, per-chat windows) are options and
errors the app maps onto this module, never code in it.

The module imports no core symbol, fetches nothing, has no Node-only code and uses timers only
through an injectable `sleep`. Apps supply storage (adapters other than memory are examples, ADR-0008).

## 1. Overview

```
app ──enqueue(id, target, payload)──▶ OutboxStore ◀──claim── createOutbox worker
                                                              │ governor.acquire / parkedFor
                                                              ▼
                                                        app send(item)  ──▶ platform
```

## 2. Rate governor

```ts
createRateGovernor({ classes: Record<string, { capacity, refillPerSec }>, now?, sleep? }): RateGovernor
governor.acquire(cls, key?, cost?, { signal? }): Promise<void>
governor.tryAcquire(cls, key?, cost?): boolean
governor.park(key, untilMs, reason): void       // PARK_ALL ('*') holds every key
governor.parkedFor(key?): number                // ms, 0 = free
governor.unpark(key): void
governor.state(): { buckets: [...], parks: [...] }
```

- One bucket per `(class, key)`; it starts full and refills continuously. `key` defaults to `''`.
- `acquire` waits until the bucket holds `cost` tokens **and** no park holds the key, then takes
  them. It rejects with `signal.reason` when aborted. A `cost` above the class capacity or an unknown
  class throws `RangeError` (programmer error).
- `park` is for "the platform said retry after N s": every `acquire`/`tryAcquire` of that key waits.
  A park only extends; it expires by itself. Whole-connection limits use `PARK_ALL`.
- `sleep(ms, signal?)` defaults to `setTimeout`; a custom sleep that ignores the signal is still
  abortable (the governor races it).

## 3. Outbox

### 3.1 `OutboxStore` port (all async)

| Method | Contract |
|---|---|
| `enqueue(item)` | Idempotent by `item.id`: an existing id changes nothing, returns `created: false`. |
| `claim(now, owner, leaseMs, limit)` | Atomic lease of due items (`pending`, `availableAt <= now`, or `claimed` with an expired lease), oldest `availableAt` then id. Each claim increments `attempts`. An expired-lease item with `attempts >= maxAttempts` is dead-lettered, not claimed. |
| `succeed(id, owner, result?)` | `done`. `false` if `owner` lost the lease. |
| `fail(id, owner, { retryAt?, error, permanent? })` | Back to `pending` at `retryAt`, or `dead` when `permanent` or attempts are used up. Returns the new state or `undefined` (lease lost). |
| `defer(id, owner, availableAt)` | Give back **without** counting the attempt (breaker open, target parked). |
| `get`, `list({ state?, limit? })`, `purge(olderThan)` | Read; delete finished (`done`/`dead`) records older than the cutoff. |

States: `pending`, `claimed`, `done`, `dead`. Delivery is **at-least-once**: a crashed worker's lease
expires and the item is sent again; apps that need exactly-once use the item id as the platform's
idempotency key. `memoryOutboxStore()` is the shipped adapter; `outboxStoreConformance` in
`eharness/testing` (`src/testing/channels.conformance.ts`) is the suite for others.

### 3.2 Worker

```ts
createOutbox({ store, send, rate?, governor?, backoff?, breaker?, now?, random?, sleep?,
               owner?, pollMs?, leaseMs?, batch?, onEvent? }): Outbox
outbox.enqueue({ id, target, payload, availableAt?, maxAttempts? })   // defaults: now, 5
outbox.tick() / start() / stop() / drain() / flush(id) / breaker(target) / resetBreaker(target)
```

- `send(record, { signal, attempt })` returns a JSON result or throws:
  `RetryAfter(ms, { parkKey? })` (platform said wait: parks `parkKey ?? target` in the governor,
  retries after `ms`, does not count against the breaker), `PermanentSendError` (dead-letter now),
  anything else (retryable).
- Retry delay: `min(maxMs, baseMs * 2^(attempt-1))` reduced by up to `jitter` (defaults 1 s, 60 s, 0.2).
  After `maxAttempts` the item is `dead`.
- Items of one target are sent one at a time in claim order; different targets run in parallel.
  Strict per-target ordering across retries is **not** guaranteed (a failed item is retried later).
- If a governor is given: a parked target defers its items (no attempt used); `rate(item)` returns the
  class/key/cost to `acquire` before each send.
- Breaker (per target): `threshold` consecutive retryable failures (default 5) open it for `cooldownMs`
  (default 30 s). Open: items are deferred, no send. After the cool-down one trial send passes
  (half-open); success closes, failure reopens. `RetryAfter` and permanent errors do not count.
- `drain()` processes everything due now until nothing is due; `flush(id)` drains then returns the
  record; `stop()` stops polling, aborts the signal given to `send` and awaits in-flight work.
- Events (`onEvent`): `sent`, `retry`, `dead`, `breaker-open`, `breaker-close`, `lease-lost`.

## 4. Mentions

A mention travels in text as a token `U+E010 id U+E012 encodedLabel U+E011` (the format the team example has stored since P41, so existing messages stay valid). `readableMentions` shows tokens as `@label` for logs.

- `mentionToken(id, label)`, `parseMentionTokens(text)`, `plainMentions(text)` (token to plain label,
  for adapters without id mentions), `hasMentionTokens(text)`.
- `neutralizeHandles(text)`: strips the three private-use characters (a model cannot forge a token)
  and inserts a zero-width space after every `@` that starts a handle. URLs (`https://`, `www.`,
  `t.me/`) and emails are untouched; the function is idempotent.

Rule for apps: free text from a model or a person always passes `neutralizeHandles`; only tokens
the app builds from structured input become real mentions.

## 5. Stability and later slices

Draft: may change in a minor release. Later: the gateway, SQL adapters as examples, per-target strict
ordering, flood-storm detection (several `RetryAfter` within a window opening the breaker).
