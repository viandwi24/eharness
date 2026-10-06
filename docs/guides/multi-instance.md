# Running several instances

Behind a load balancer, or on serverless, the request for a session can land on any instance.
eharness keeps one running turn per session and lets the others cooperate through storage. This
guide lists what each guarantee needs, from "works" to "exact". Contract: spec 05 §6–§9, §12;
decisions: ADR-0021 (cross-process abort), ADR-0024 (durable inbox). For the patterns around it
(heartbeats, background jobs, route authorization) see [production patterns](production-patterns.md).

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

## Poison items

An item whose unit keeps failing before its commit point (a store that rejects it, a lock race
that never resolves) or whose holder keeps crashing is redelivered without limit by default — and
because claims are head-of-line, it blocks every later item of its session. `inbox.retry` limits
that (spec 05 §12 rules 11–15, ADR-0026):

```ts
const agent = defineHarnessAgent({
  model,
  storage: { messages, state, inbox },
  inbox: {
    retry: {
      maxAttempts: 5, // counted claims; a crashed holder counts too (its claim expires)
      backoff: { type: 'exponential', delayMs: 1_000, maxDelayMs: 60_000, jitter: true },
      // default: only EH_INVALID_INPUT goes dead at once
      nonRetryable: (error) => error.code === 'EH_INVALID_INPUT',
    },
    onDeadLetter: async (item) => {
      await alerts.page(`inbox item ${item.id} of ${item.sessionId} is dead: ${item.reason}`, item)
    },
  },
})
```

- **Choosing `maxAttempts`.** Attempts are counted at claim; deferrals (a turn of another
  instance runs, approvals are pending, a burst is not due, the items wait behind a running unit)
  are released with `uncount` and do not count. That only holds with an adapter that honours the
  0.5 `release` options — `memoryInbox()`, `examples/postgres-inbox.ts`, or yours once it passes
  `inboxAdapterConformance(…, { requireRetry: true })`. With such an adapter `5` is a good start;
  with a 0.4 adapter leave `retry` off (it would dead-letter healthy items behind long turns).
  A drain that cannot read the session's own state is not an item failure: its items are
  released uncounted, so a storage outage never dead-letters a healthy backlog.
- **Backoff.** A failed attempt waits `delayMs × 2^(attempts − 1)` (or `delayMs` with
  `type: 'fixed'`), capped at `maxDelayMs`, drawn uniformly from `[0, delay]` with `jitter`. The
  delayed item keeps its place: the session's later messages wait for it (id order); Stop
  (`abort` items) does not.
- **Dead items.** An item past `maxAttempts`, or failing with a non-retryable error, is moved to
  the adapter's dead store (`deadLetter`), then reported: `onDeadLetter(item)`, the session event
  `{ type: 'inbox-dead', inboxId, kind, reason, attempts }` and the warning
  `W_INBOX_DEAD_LETTER`. Alert from `onDeadLetter` (a throw is `W_HOOK_FAILED`, the item stays
  dead). Without `deadLetter` on the adapter, `onDeadLetter` *is* the dead store: the item is
  acked only after it returned — "bring a dead table".
- **Redrive.** Dead items are listed with `listDead()` and made ready again with `redrive(ids)`
  (attempts reset, original id order). eharness has no wrapper for it; expose it on an admin
  route next to the cause fix:

  ```ts
  app.get('/admin/inbox/dead', async (c) =>
    c.json(await inbox.listDead?.({ sessionId: c.req.query('session'), limit: 100 })),
  )
  app.post('/admin/inbox/redrive', async (c) => {
    const { ids } = await c.req.json<{ ids: string[] }>()
    await inbox.redrive?.(ids)
    for (const sessionId of (await inbox.pending?.({ limit: 100 })) ?? []) agent.session(sessionId)
    return c.body(null, 204)
  })
  ```

  Dashboards read `stats()` (`ready` / `claimed` / `delayed` / `dead`).
- **Side effects are at-least-once.** A retried unit can run the start of a turn again, and a
  crashed turn after its commit point is redelivered and deduped — but a tool that already
  changed the outside world in the lost attempt does not know that. Mark tools whose effects are
  safe to repeat (`tool({ metadata: { idempotent: true } })`, P21) and give the others an
  idempotency key (the `inboxId` in `metadata.eharness` of the user message is a natural one).

## Sweeper

Items wait in the inbox until an instance with the session live claims them. If every instance
that knew a session went away, an application sweeper picks them up:

```ts
setInterval(async () => {
  for (const id of (await inbox.pending?.({ limit: 100 })) ?? []) agent.session(id) // drains once on open
}, 30_000)
```

## Writing an `InboxAdapter`

Four required methods, the rest optional (`notify`, `subscribe`, `pending`, and for poison items
`deadLetter`, `redrive`, `listDead`, `stats`). `claim` is the one that needs care: it must hand
each ready item to exactly one claimer, oldest first, hide it until `ack` / `release` or until
the claim expires, never return an item behind an older one another owner holds (head of line),
renew the claims the calling owner already holds, skip dead items and future `availableAt`
timers, and not return `send` / `wake` items behind a delayed one (a released item with
`delayMs`; `abort` items pass). In Postgres a function serializes the claims of a session with an
advisory lock (`eh_inbox_claim` in `examples/postgres-inbox.ts`):

```sql
PERFORM pg_advisory_xact_lock(hashtext('eh_inbox:' || p_session));
UPDATE eh_inbox SET claimed_until = v_until                 -- renew the owner's claims
  WHERE session_id = p_session AND claimed_by = p_owner AND claimed_until > v_now;
SELECT id INTO v_head FROM eh_inbox                          -- oldest row another owner holds
  WHERE session_id = p_session AND dead_at IS NULL AND claimed_until > v_now
    AND claimed_by IS DISTINCT FROM p_owner
  ORDER BY id LIMIT 1;                                       -- not min(): no min(uuid) before PG 18
SELECT id INTO v_delay FROM eh_inbox                         -- oldest delayed row (backoff)
  WHERE session_id = p_session AND dead_at IS NULL AND delayed_until > v_now
  ORDER BY id LIMIT 1;
RETURN QUERY UPDATE eh_inbox SET claimed_by = p_owner, claimed_until = v_until,
    attempts = attempts + 1, delayed_until = NULL
  WHERE id IN (SELECT id FROM eh_inbox WHERE session_id = p_session AND dead_at IS NULL
                 AND (claimed_until IS NULL OR claimed_until <= v_now)
                 AND (available_at IS NULL OR available_at <= v_now)
                 AND (delayed_until IS NULL OR delayed_until <= v_now)
                 AND (v_head IS NULL OR id < v_head)
                 AND (v_delay IS NULL OR id < v_delay OR item->>'kind' = 'abort')
               ORDER BY id LIMIT p_limit)
  RETURNING id::text, item::text, attempts, last_error;
```

A 0.4 table is upgraded in place: `ALTER TABLE eh_inbox ADD COLUMN IF NOT EXISTS available_at
timestamptz` (and `delayed_until`, `last_error`, `dead_at`, `dead_reason`; all nullable, so
existing rows stay ready items), then drop and recreate `eh_inbox_claim` (its result gained a
column). `migrateInbox` in the example does exactly that.

`notify` is `SELECT pg_notify('eh_inbox', $sessionId)`; `subscribe` routes the notifications of
one `LISTEN` connection by payload. Full version: `examples/postgres-inbox.ts`. Prove it with
`inboxAdapterConformance` (see [Writing a storage adapter](writing-a-storage-adapter.md)).
`examples/inbox.ts` runs two instances on `memoryInbox()` in one process.
