---
"eharness": minor
---

New Draft subpath `eharness/channels`: the platform-neutral delivery machinery for chat products. `createRateGovernor` (token buckets per call class and key, park state for "retry after N s", abortable `acquire`), `createOutbox` with the `OutboxStore` port (idempotent enqueue, leased claims, retry with exponential backoff and jitter, dead-letter, per-target circuit breaker) and `memoryOutboxStore`, and structured mentions (`mentionToken`, `parseMentionTokens`, `neutralizeHandles`) so a model can never ping by typing `@handle`. `outboxStoreConformance` lives in `src/testing/channels.conformance.ts` (barrel export pending). Spec 31.
