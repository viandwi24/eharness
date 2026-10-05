---
"eharness": minor
---

Durable inbox delivery guarantees (spec 05 §12, ADR-0024):

- A durable steer that waits for a long step is delivered once: the holder renews the claims of the items it holds, and a running turn takes a steer once per inbox id.
- No item is lost when a process dies between a state write and the save of the item's effect: send items and steers are deduped by the `inboxId` of their stored messages only; `state.core.inboxDelivered` now lists `wake` items only, written with the wake turn's end-of-turn state write (a wake is acked after it).
- Id order holds with two live holders: the items after a started unit stay claimed until its turn commits or ends.
- `InboxAdapter.claim` contract (checked by `inboxAdapterConformance`): head of line — never return an item behind an older item of the session that another owner holds — and renewal — a claim by the owner extends the claims it already holds (not returned again, `attempts` unchanged). `memoryInbox()` implements both and `pending()` lists only sessions whose oldest item is claimable; custom adapters must follow (see `examples/postgres-inbox.ts`).
