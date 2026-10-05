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
   order or timestamps. (Postgres `uuid` byte order works too.)
2. **`save` upserts** — same id replaces `role`, `parts` and `metadata`.
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
  messageAdapterConformance,
  stateAdapterConformance,
} from 'eharness/testing'

describe('my storage', () => {
  for (const c of messageAdapterConformance(() => myMessages(), { requireLastId: true })) {
    test(c.name, c.run)
  }
  for (const c of stateAdapterConformance(() => myState())) test(c.name, c.run)
  for (const c of inboxAdapterConformance(() => myInbox())) test(c.name, c.run)
})
```

Each case uses random session ids, so the factory may return adapters on one shared database.

## Several instances (serverless, horizontal scaling)

| Need | Provide |
|---|---|
| Detect history written by another instance | `MessageAdapter.lastId` |
| Exactly-once approvals across instances | `StateAdapter.setIf`, or a `SessionLock` |
| Stop a turn running in another instance (`session.abort()` / `requestAbort()`) | `StateAdapter.setIf` (atomic) |
| At most one running turn per session, exactly | a `SessionLock` (`SessionOptions.lock`) |
| Queue, steer, wake, collect and abort across instances (`session.enqueue()`) | an `InboxAdapter` (`storage.inbox`) |

```ts
import type { SessionLock } from 'eharness'

const lock: SessionLock = {
  // Resolve with a release function, or reject at once if another instance holds the session
  // (the run then ends with EH_SESSION_BUSY). Must not block indefinitely.
  async acquire(sessionId, { signal }) {
    return async () => {}
  },
}
agent.session('s1', { lock })
```

The Postgres example implements it with `pg_try_advisory_lock` on a dedicated connection.
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
  async release(ids) { /* clear the claim */ },
  // optional: notify(sessionId), subscribe(sessionId, onNotify) → unsubscribe, pending({ limit })
}
```

`claim` must give each item to exactly one claimer, oldest first, and never return an item behind
an older item of the session that another owner still holds (head of line: the core keeps the
items after a running unit claimed, so no other instance starts them out of order). A claim by an
owner that already holds items renews those claims (not returned again, `attempts` unchanged), and
an expired claim makes the item ready again — the core relies on that to redeliver the items of an
instance that died. In Postgres, serialize the claims of a session with a transaction-scoped
advisory lock (`FOR UPDATE SKIP LOCKED` alone lets a second claimer skip past a held row). Store the item as JSON and return copies. `memoryInbox()` is the reference.

## Tips

- `persistEachStep` (default `true`) rewrites the assistant message after every step; keep tool
  outputs bounded (`toolOutput.maxChars`) or use `message.beforeSave` to slim messages.
- Store `parts` / `metadata` as JSON documents; do not normalize parts into tables — part shapes
  come from AI SDK and grow over time.
- Validation happens on load in the core (`onInvalidMessage`), so adapters stay dumb.
