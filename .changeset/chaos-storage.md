---
'eharness': minor
---

`eharness/testing` gains `chaosStorage(inner, { seed, conflictRate, conflictPorts, delayMs, failRate })`, a deterministic fault-injecting wrapper for the message, state, inbox and lock ports (rev conflicts, lock contention, lost inbox claims, slow calls, failing `ack` / `release`, `expireLease`), so adapter authors can run their adapters and `multiInstanceConformance` under real-database conditions. `multiInstanceConformance` cases that let either instance run a queued turn or a wake now share one script, so a slow store cannot fail them.

Fix: when an `InboxAdapter.ack` or `release` call failed, the item stayed claimed for as long as the instance lived (every claim of the same owner renews its own claims instead of returning them). The drain now retries failed acks and releases at its next run.
