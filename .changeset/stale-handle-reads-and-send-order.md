---
"eharness": patch
---

Multi-instance correctness. `session.stats()` on a cached idle handle re-reads `pending`, `activeTurn` and `usage` from storage, so `pendingSubagentApprovals` and approval lists no longer show a request another instance already answered (spec 05 section 2.2). A direct `send()` on an idle session with a durable inbox no longer overtakes older queued inbox items: the drain applies them first (spec 05 section 12 rule 7).

Behaviour change (no migration): a direct `send()` waits for older queued inbox items instead of overtaking them, and `stats()` on a cached handle does an extra storage read.
