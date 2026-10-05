# Running several instances

Behind a load balancer, or on serverless, the request for a session can land on any instance.
eharness keeps one running turn per session and lets the others cooperate through storage. This
guide lists what each guarantee needs, from "works" to "exact". Contract: spec 05 §6–§9, §12;
decisions: ADR-0021 (cross-process abort), ADR-0024 (durable inbox).

| Need | Provide |
|---|---|
| History written by another instance is seen (hot cache validation) | `MessageAdapter.lastId` |
| A second turn fails fast while one runs elsewhere (best effort) | nothing: `state.core.activeTurn` + heartbeat (`recovery`) |
| At most one running turn per session, exactly | a `SessionLock` (`SessionOptions.lock`) |
| Exactly-once approvals across instances | `StateAdapter.setIf`, or a `SessionLock` |
| Stop a turn running in another instance | `StateAdapter.setIf` (state path), or `storage.inbox` |
| Queue, steer, wake, collect across instances | `storage.inbox` (an `InboxAdapter`) |
| Low latency for the above | `InboxAdapter.notify` + `subscribe` (e.g. `LISTEN`/`NOTIFY`) |
| Work left behind by instances that went away | an app sweeper over `InboxAdapter.pending()` |

## Lock, `setIf` and `lastId`

`lastId` lets an instance notice that another one wrote the session (it reloads state and
messages before the next turn). `setIf` makes the commit point a compare-and-set: two instances
that both try to start a turn, or both accept the same approval answer, cannot both win. A
`SessionLock` (e.g. `pg_try_advisory_lock`) makes "one turn per session" exact. See
[Writing a storage adapter](writing-a-storage-adapter.md) and `examples/postgres-storage.ts`.

Without an inbox, a `send()` that reaches an instance while the turn runs in another one is a run
error `EH_SESSION_BUSY` (HTTP 409 from `handleChatRequest`). `ifBusy` only applies to a turn of
the same process.

## The inbox

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  storage: { messages, state, inbox: postgresInbox(db, { listener }) },
  inbox: { pollMs: 2_000, collect: { quietMs: 1_500 } }, // defaults
})

const { inboxId, target } = await agent.session(chatId).enqueue(text, { mode: 'queue' })
// target: 'local' (this instance applies it) or 'remote' (the turn runs elsewhere)
```

`session.enqueue(input, { mode })` stores the input in the inbox and returns at once. Whichever
instance holds the session applies it:

- `'queue'` (default): a turn of its own after the running one;
- `'steer'`: delivered into the running turn at its next step boundary (a `data-eh.input` part,
  exactly where the model saw it); a queued turn when no turn takes it;
- `'collect'`: a burst of messages (WhatsApp, Telegram) is merged into **one** user message and
  answered once — after `quietMs` without a new message, `maxWaitMs` after the first, or
  `maxItems` messages. The merged message lists its inputs in `metadata.eharness.collected`.

The instance running the session's turn claims inbox items when notified, every `pollMs` and when
its turn ends; when no turn runs anywhere, any live instance claims and runs the next one. Items
are acknowledged only after their effect is stored, and an item that comes back (its claimer
died, an ack was lost) is recognised by its id and skipped — at-least-once delivery, applied
exactly once. While approvals are pending, queued items wait (like the in-memory queue).

`send()` is unchanged. A chat route that wants cross-instance queuing calls `enqueue()` itself:

```ts
export async function POST(req: Request) {
  const body = await req.json()
  const session = agent.session(body.id)
  const { activeTurn } = await session.stats()
  if (activeTurn !== null && !session.running) {
    // a turn of this chat runs in another instance: hand the message to it (best effort check;
    // a run that still ends with EH_SESSION_BUSY can be retried the same way)
    const { inboxId } = await session.enqueue(body.messages.at(-1), { mode: 'steer' })
    return Response.json({ inboxId }, { status: 202 })
  }
  return handleChatRequest(session, body).toResponse()
}
```

Without `storage.inbox`, `enqueue()` applies the input in the calling process (the same modes),
and `send(input, { ifBusy: 'collect' })` debounces bursts in-process.

## Wake-ups and Stop from another instance

`inject(kind, data, { wake: true })` on an instance where the session is idle starts a turn
there. When the turn runs in another instance, it saves the event and enqueues a `wake` item; the
holder runs a wake turn after its current turn.

`session.abort()` / `requestAbort()` on an instance without the turn: with an inbox, an `abort`
item for the running turn is enqueued (the holder applies it at its next drain — at once with
`subscribe`, within `pollMs` otherwise, also during a long tool call); without one, an abort
request is written into the state (`StateAdapter.setIf`, polled every `recovery.abortPollMs`).
Both target the **turn**, never the session: a late Stop does not kill the next turn. Durable
inbox items are never dropped by `abort()`.

## Sweeper

Items wait in the inbox until an instance with the session live claims them. If every instance
that knew a session went away, an application sweeper picks them up:

```ts
setInterval(async () => {
  for (const id of (await inbox.pending?.({ limit: 100 })) ?? []) agent.session(id) // drains once on open
}, 30_000)
```

## Writing an `InboxAdapter`

Seven methods, three of them optional. `claim` is the one that needs care: it must hand each
ready item to exactly one claimer, oldest first, and hide it until `ack` / `release` or until the
claim expires. In Postgres:

```sql
UPDATE eh_inbox SET claimed_by = $2, attempts = attempts + 1,
       claimed_until = now() + ($3::integer * interval '1 millisecond')
WHERE id IN (
  SELECT id FROM eh_inbox
  WHERE session_id = $1 AND (claimed_until IS NULL OR claimed_until <= now())
  ORDER BY id LIMIT $4 FOR UPDATE SKIP LOCKED
)
RETURNING id, item, attempts
```

`notify` is `SELECT pg_notify('eh_inbox', $sessionId)`; `subscribe` routes the notifications of
one `LISTEN` connection by payload. Full version: `examples/postgres-inbox.ts`. Prove it with
`inboxAdapterConformance` (see [Writing a storage adapter](writing-a-storage-adapter.md)).
`examples/inbox.ts` runs two instances on `memoryInbox()` in one process.
