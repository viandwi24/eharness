---
"eharness": minor
---

`followSessionStream` stays fast on long turns. Consecutive text and reasoning deltas of the same part are merged before the AI SDK folds them (`deltaHoldMs`, default 50 ms; `0` keeps one message state per delta), so a turn of hundreds of steps no longer produces one full copy of the message per chunk. The built message is unchanged. The new `clip` option replaces big tool inputs/outputs and data payloads with `?clip=` previews (`isClippedPart`) while following.
