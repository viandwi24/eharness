---
'eharness': minor
---

Channels (draft): the outbox gains `expiredLeases: 'retry' | 'hold'` (with `hold` an item whose lease
expired is not resent but becomes `held`, emits `held`, and is resolved with `outbox.release(id,
'retry' | 'drop')`), a terminal `skipped` state (`SkipSend`, `store.skip`), `openBreaker(target,
untilMs, reason)`, a shared storm detector (`noteRateLimit(parkKey, retryAfterMs)`, `floods(key)`,
`floodStorm.stormKey`, `RetryAfter({ counted })`), and function forms of `breaker.cooldownMs`,
`floodStorm.count` and `floodStorm.windowMs`. `OutboxStore` gains `holdExpired`, `release` and `skip`,
and `claim` takes `{ reclaimExpired }`; the conformance suite covers them. The rate governor gains
`charge` (take tokens without waiting, the balance may go negative), `waitFor`, `resetBuckets`, an
`acquire` `reserve` for patient callers, and classes that are a function of the key.
