---
"eharness": minor
---

Resumable streams across instances: a `StreamLogAdapter` port (`storage.streams`, `streams` options), `inMemoryStreamLog()` (`eharness/storage/memory`), `streamLogConformance` (`eharness/testing`), `session.attachRemote({ from, signal })`, `handleResumeRequest()` for AI SDK `useChat({ resume: true })`, and the `W_STREAM_LOG_FAILED` warning. See ADR-0039 and spec 04 §6.2.
