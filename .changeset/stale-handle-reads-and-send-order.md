---
"eharness": patch
---

Multi-instance correctness. `session.stats()` on a cached idle handle re-reads `pending`, `activeTurn` and `usage` from storage, so `pendingSubagentApprovals` and approval lists no longer show a request another instance already answered (spec 05 section 2.2). A direct `send()` on an idle session with a durable inbox no longer overtakes older queued inbox items: the drain applies them first (spec 05 section 12 rule 7).
