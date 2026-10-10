---
"eharness": minor
---

`ctx.turn.source` and `metadata.eharness.inboxKey` expose the caller id (`enqueue(…, { id })`) and inbox item ids to a turn made from the inbox, so hooks can match a turn to its producer without waiting for `enqueue()` to return. `enqueue(…, { metadata })` stores trusted app metadata as `metadata.app` of the user message (16 KiB cap; it wins over a client `app` key). `FileSystem` gains the optional `versions()` / `readVersion()` (and an `author` hint on writes); `memoryFs` implements them (`maxVersions`) and `fileSystemConformance` checks them with `requireVersions`. See ADR-0043.
