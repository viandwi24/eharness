# Writing a storage adapter

eharness stores every session as AI SDK `UIMessage`s through a `MessageAdapter`, plus one small
JSON snapshot per session through a `StateAdapter`; multi-instance deployments can add a durable
`InboxAdapter`. The library ships in-memory versions (`eharness/storage/memory`, the default);
anything persistent is your code — usually under 100 lines. Contract: spec 05 §4–§12. Examples:
[JSON files](../../examples/json-file-storage.ts) ·
[Postgres](../../examples/postgres-storage.ts) ·
[Postgres inbox](../../examples/postgres-inbox.ts).

```ts
import { defineHarnessAgent } from 'eharness'

// yours: model (LanguageModel), myMessages() / myState() (the adapters below)
const agent = defineHarnessAgent({
  model,
  storage: { messages: myMessages(), state: myState() }, // or per session: SessionOptions.storage
})
```

## `MessageAdapter`

```ts
import type { MessageAdapter } from 'eharness'

export function myMessages(): MessageAdapter {
  return {
    // Chronological (ascending id). Exactly one of these query shapes:
    //   { fromId }          → every message with id >= fromId (inclusive), no limit
    //   { beforeId, limit } → the `limit` newest messages with id < beforeId
    //   { limit }           → the `limit` newest messages
    //   {}                  → everything
    async load({ sessionId, fromId, beforeId, limit }) {
      return []
    },
    // Upsert by id: the running assistant message is saved after every step with the same id.
    async save(sessionId, messages) {},
    // Optional: newest id, lets several instances detect foreign writes before a turn.
    async lastId(sessionId) {
      return null
    },
  }
}
```

Requirements:

1. **Order by id string.** Ids are UUIDv7: string order is creation order. Never rely on insertion
   order or timestamps; ids that share a millisecond prefix must still list in one deterministic id
   order. (Postgres `uuid` byte order works too.)
2. **`save` is an atomic upsert** — the same id replaces the whole message (`role`, `parts`,
   `metadata`), never merges. Concurrent saves of one id (two instances, or a retried step) must end
   with exactly one row, and concurrent saves of disjoint batches must all be visible afterwards:
   use `INSERT … ON CONFLICT (session_id, id) DO UPDATE` or a transaction, not read-then-write.
3. **Round-trip JSON losslessly** (unknown keys, part order; object key order may change).
4. **Return copies** — callers may mutate what `load` returns.
5. **Isolate sessions.** Never delete: history is append-only for the core (regenerate/edit hide
   messages with marker messages). Deleting a chat is your application's decision.

The core loads in one range query in the common case (`{ fromId }` from the newest compaction
marker) and pages backwards with `{ beforeId, limit }` otherwise — index `(session_id, id)`.

## `StateAdapter`

```ts
import type { StateAdapter } from 'eharness'

export function myState(): StateAdapter {
  return {
    async get(sessionId) {
      return null // SessionStateSnapshot | null
    },
    async set(sessionId, state) {},
    // Optional compare-and-set on `state.rev` (expectedRev null = no snapshot yet).
    async setIf(sessionId, state, expectedRev) {
      return false // true when written
    },
  }
}
```

The snapshot holds the compaction pointer, pending approvals, grants, the active turn and plugin
state. It is small and written a few times per turn.

## Prove it with the conformance suites

`eharness/testing` returns plain `{ name, run }` cases, so any runner works:

```ts
import { describe, test } from 'bun:test' // or vitest / node:test
import {
  inboxAdapterConformance,
  lockConformance,
  messageAdapterConformance,
  stateAdapterConformance,
} from 'eharness/testing'

describe('my storage', () => {
  for (const c of messageAdapterConformance(() => myMessages(), { requireLastId: true })) {
    test(c.name, c.run)
  }
  for (const c of stateAdapterConformance(() => myState())) test(c.name, c.run)
  for (const c of inboxAdapterConformance(() => myInbox())) test(c.name, c.run)
  // `peer`: a second handle on the same lock space; `expire`: let a holder's lease run out
  for (const c of lockConformance(() => ({ lock: myLock(), peer: () => myLock() }))) {
    test(c.name, c.run)
  }
})
```

Each case uses random session ids, so the factory may return adapters on one shared database.

What the suites pin beyond the basics: `messageAdapterConformance` checks the query shapes, the
upsert, copies and ordering, plus three concurrency cases (concurrent saves of one id end with one
row, concurrent disjoint batches are all visible in id order, ids sharing a millisecond prefix keep
a deterministic order), so a read-then-write `save` fails it. `lockConformance(factory, options?)`
takes a `SessionLock` or `{ lock, peer?, expire? }` and checks acquire / release, prompt rejection
while held (an acquire must never block), an idempotent release that never frees a newer holder,
one winner among parallel acquires, exclusion across `peer`, and takeover of an expired lease via
`expire` (omit `expire` for a lock without a lease, such as an advisory lock). Contributor notes:
[`docs/engineering/testing.md`](../engineering/testing.md#lock-conformance).

## Several instances (serverless, horizontal scaling)

| Need | Provide |
|---|---|
| Detect history written by another instance | `MessageAdapter.lastId` |
| Exactly-once approvals across instances | `StateAdapter.setIf`, or a `SessionLock` |
| Stop a turn running in another instance (`session.abort()`) | `StateAdapter.setIf` (atomic) |
| At most one running turn per session, exactly | a `SessionLock` (`SessionOptions.lock`) |
| Queue, steer, wake, collect and abort across instances (`session.enqueue()`) | an `InboxAdapter` (`storage.inbox`) |
| Reload on another instance while a turn streams (`attachRemote`, `useChat({ resume: true })`) | a `StreamLogAdapter` (`storage.streams`, `inMemoryStreamLog()`, `streamLogConformance`) |

```ts
import type { SessionLock } from 'eharness'

const lock: SessionLock = {
  // Resolve with a release function, or reject at once with
  // `new HarnessError('EH_SESSION_BUSY', …)` if another instance holds the session. Any other
  // rejection is a failing lock service (EH_LOCK_UNAVAILABLE). Must not block indefinitely.
  async acquire(sessionId, { signal }) {
    return async () => {}
  },
}
agent.session('s1', { lock }) // `agent` from the first snippet
```

The Postgres example implements it with `pg_try_advisory_lock` on a dedicated connection. Check
your lock with `lockConformance` (above): a second acquire rejects at once, a release only frees
its own acquire (a stale release must not free a newer holder), and a lease-based lock takes over
an expired holder.
Without a lock, the core still marks the running turn in the state (`activeTurn` + heartbeat), so
a second instance fails fast with `EH_SESSION_BUSY` (best effort), and a turn whose process died
is recovered on the next operation.

## `InboxAdapter`

Optional. A durable per-session queue of inputs, wake-ups and abort requests that the instance
holding a session drains (spec 05 §12, [Running several instances](multi-instance.md)):

```ts
import type { InboxAdapter } from 'eharness'

const inbox: InboxAdapter = {
  async enqueue(sessionId, item) { /* store; return a time-sortable id (uuidv7()) */ },
  async claim(sessionId, owner, { limit, claimTtlMs } = {}) {
    /* atomically mark the oldest ready items claimed until now + claimTtlMs, attempts + 1 */
  },
  async ack(ids) { /* delete */ },
  async release(ids, { owner, delayMs, uncount, lastError } = {}) {
    /* clear the claim; uncount → attempts − 1; delayMs → not claimable before now + delayMs */
  },
  // optional: notify(sessionId), subscribe(sessionId, onNotify) → unsubscribe, pending({ limit })
  // optional (poison items): deadLetter(ids, { reason, lastError }), redrive(ids),
  //   listDead({ sessionId, limit }), stats({ sessionId })
}
```

**Without `notify`/`subscribe` the holder polls.** The instance running a session's turn then
learns about new inbox items only every `inbox.pollMs` (default 2000 ms): each poll is one
`claim` call per session with a running turn, and an item waits up to `pollMs` before a `steer`
or a queued message is seen. That is fine for SQLite or a single process; lower `pollMs` for
latency (more queries), raise it for many idle holders. `claimTtlMs` bounds how long a dead
holder's items stay invisible, so keep it well above `pollMs` plus a turn's longest step. With
Postgres, `LISTEN`/`NOTIFY` in `notify`/`subscribe` removes the wait.

`claim` must give each item to exactly one claimer, oldest first, and never return an item behind
an older item of the session that another owner still holds (head of line: the core keeps the
items after a running unit claimed, so no other instance starts them out of order). A claim by an
owner that already holds items renews those claims (not returned again, `attempts` unchanged), and
an expired claim makes the item ready again — the core relies on that to redeliver the items of an
instance that died. In Postgres, serialize the claims of a session with a transaction-scoped
advisory lock (`FOR UPDATE SKIP LOCKED` alone lets a second claimer skip past a held row). Store the item as JSON and return copies. `inMemoryInbox()` is the reference.

Checklist for retry, dead-letter and dedupe (spec 05 §12 rules 11–15, 17) — needed before an application turns on
`inbox.retry.maxAttempts`:

- `release(ids, opts)`: only claimed rows, and with `owner` only rows still claimed by that owner
  (a stale holder must not free a newer owner's claim; the core always passes it); `uncount` undoes the increment of the claim being
  released (deferrals must not consume attempts); `delayMs` keeps the row in place but
  unclaimable until then, and `send` / `wake` rows behind it wait (`abort` rows do not);
  `lastError` is stored and returned by later claims as `lastError` (omit the field when null).
- `availableAt` on an enqueued item: invisible and holding nothing back until due (a timer).
- An expired claim keeps its attempt (crash loops are counted).
- `deadLetter` keeps the row (never claimed again, holds nothing back); `listDead` returns
  `DeadInboxItem`s (`sessionId`, `deadAt` epoch ms, `reason`, `lastError?`) oldest first;
  `redrive` resets `attempts` to 0 and clears `lastError`; `stats` counts `ready`, `claimed`,
  `delayed` (backoff or future `availableAt`) and `dead`.
- `enqueueOnce(sessionId, item)` (optional, needed for `session.enqueue(…, { id })`, rule 17):
  one atomic statement keyed by `(sessionId, item.dedupeKey)` (Postgres: `INSERT … ON CONFLICT
  (session_id, dedupe_key) DO NOTHING RETURNING id`, then select the existing id). Keep the key
  row for at least 24 hours after the item is acked (delete it with a TTL job, not with the item).
- Prove it: `inboxAdapterConformance(factory, { requireRetry: true, requireDeadLetter: true,
  requireStats: true, requireDedupe: true })`. An adapter without `deadLetter` still works with `retry`: dead items are
  acked after `inbox.onDeadLetter` ran.

## Tips

- `persistEachStep` (default `true`) rewrites the assistant message after every step; keep tool
  outputs bounded (`toolOutput.maxChars`) or use `message.beforeSave` to slim messages.
- Store `parts` / `metadata` as JSON documents; do not normalize parts into tables — part shapes
  come from AI SDK and grow over time.
- Validation happens on load in the core (`onInvalidMessage`), so adapters stay dumb.
