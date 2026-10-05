---
"eharness": minor
---

Durable inbox: queue, steer, wake, collect and abort across instances (spec 05 §12, ADR-0024).

- New optional port `InboxAdapter` (`storage.inbox`, also `SessionOptions.storage.inbox`) with
  `enqueue` / `claim` / `ack` / `release` and optional `notify` / `subscribe` / `pending`;
  `memoryInbox()` in `eharness/storage/memory`; `inboxAdapterConformance` in `eharness/testing`.
  A Postgres adapter (`FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`) is an example
  (`examples/postgres-inbox.ts`), not a dependency.
- New `session.enqueue(input, { mode: 'queue' | 'steer' | 'collect', collect? })` →
  `{ inboxId, target: 'local' | 'remote' }`: with an inbox the input is stored durably and
  applied by the instance holding the session (at-least-once delivery, deduplicated by id);
  without one it is applied in this process. `send()` keeps its 0.3 semantics.
- `ifBusy: 'collect'` with `SendOptions.collect` (`quietMs` 1 500, `maxWaitMs` 10 000,
  `maxItems` 20): a burst of inputs becomes one user message and one turn (also without an
  inbox). New config `inbox: { pollMs?, claimTtlMs?, collect? }`.
- With an inbox: `requestAbort()` / `abort()` reach a turn running in another instance through
  an `abort` item (the state request stays the fallback); `inject(…, { wake: true })` while
  another instance runs the turn hands the wake to it.
- New session events `inbox-enqueued` and `inbox-drained`; new warning `W_INBOX_FAILED`;
  persisted additions `metadata.eharness.inboxId` / `collected`, `data-eh.input` `inboxId`,
  `state.core.inboxDelivered`. New types `InboxAdapter`, `InboxItem`, `InboxItemInput`,
  `SerializedInput`, `CollectOptions`, `EnqueueOptions`, `EnqueueResult`.
- Type-level: `SendOptions.ifBusy` gains `'collect'`; `SessionEvent` gains two members
  (exhaustive switches must add cases); `HarnessSession` gains `enqueue()` (custom
  implementations and mocks must add it).
