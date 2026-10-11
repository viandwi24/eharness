---
"eharness": minor
---

New subpath `eharness/activity` (spec 25, ADR-0058), lifted from the team example. The **session activity feed**: the `activity({ store })` plugin turns session lifecycle hooks into events (`turn-started` with its source, `step-finished`, `turn-ended`, `pending-changed`, `approval-decided`, `message-saved`, `child-reported`, `session-recovered`, `compaction`); the `ActivityStore` port (append with a strictly increasing `seq`, read after a cursor, prune by age / count with a monotonic `prunedThrough`, free-form event types so apps share the feed) with `memoryActivityStore()` and `activityStoreConformance` in `eharness/testing`; SSE helpers on Web APIs only (`activityStream`, `handleActivityStream`, `readActivityPage`: initial flush, `boot` event, keep-alives, `id:` = seq, `Last-Event-ID`, `resync` for a cursor behind the prune mark or ahead of the head). The **attention queue**: `listAttention` (approvals, client-tool questions and optional external waits across a parent and its children, with routing info) and an idempotent `answerAttention` (`resumed | recorded | already-answered | not-found`, routed to the owning session, from any instance).

Core: new observe-only hook `message.saved` (after `MessageAdapter.save` succeeded).
