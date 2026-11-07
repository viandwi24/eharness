---
"eharness": minor
---

`SessionLock.acquire(sessionId, { signal, owner })` receives `recovery.instanceId` as `owner` (only when set), so a lease lock can take over a lease its restarted self left behind at once. The option is additive: locks that ignore it keep working. `lockConformance` gains the opt-in `leaseOwnerTakeover` case.
