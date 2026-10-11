---
"eharness": minor
---

Status of pre-start failures and cheaper uploads: New `run.accepted` and `run.toResponse()` (the safe HTTP answer; `run.toStreamResponse()` streams at once and keeps these failures in the stream) answer failures before a turn's commit point (busy in this or another instance, a held `SessionLock`, invalid input, no pending answer) with 409 / 400 / 503 and a JSON body, while failures after the stream started stay in-stream; `session.busy()` reports a local or remote running turn with the `recovery.staleMs` check built in; `session.stats().usage` exposes cumulative tokens, turns and `costUsd`; `inputFiles.resolve(url, ctx)` resolves stored file references (a custom protocol) for the model at projection time; `FileSystem.writeBytes(path, bytes, { mediaType })` lets adapters keep the declared media type (`inMemoryFs` does; `fileSystemConformance({ keepsMediaType })`). See spec 03 §6, 04 §7.1, 05 §2, 08 §12.

A run that waits before it starts (queued, `ifBusy: 'wait'`, or held behind an inbox drain) carries the `accepted` of the turn it becomes, so `toResponse()` answers `409` for a lock held by another instance (spec 04 §7.1, ADR-0059).
