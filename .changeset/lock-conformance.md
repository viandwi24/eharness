---
"eharness": minor
---

`eharness/testing` adds `lockConformance(factory, options?)`: runner-agnostic cases for a `SessionLock` (acquire / release, prompt rejection while held, idempotent release that never frees a newer holder, one winner among parallel acquires, exclusion across a `peer` handle, takeover of an expired lease via `expire`). `httpConformance` gains a `sessionId` option for apps that only serve sessions they know, and `connectionStoreConformance` accepts the `source: 'store'` field a profile-backed store adds.
