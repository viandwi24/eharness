---
"eharness": minor
---

`session.enqueue()` gains `availableAt` (a durable timer on the inbox) and `id` (a caller-supplied idempotency key per session; a repeat returns `{ duplicate: true }` and stores nothing, also after the item was processed, within a 24 hour dedupe horizon). `InboxAdapter` gains the optional `enqueueOnce` and `InboxItemInput.dedupeKey`; `memoryInbox()` implements them (`dedupeWindowMs`), and `inboxAdapterConformance` checks them with `requireDedupe`. See ADR-0040 and spec 05 §12 rule 17.
