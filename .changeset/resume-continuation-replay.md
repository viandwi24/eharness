---
"eharness": patch
---

Resume of a `respond()` continuation now works with AI SDK `resumeStream()`: `attach()`, `attachRemote()`, the stream log and `handleResumeRequest()` start with a replay of the continued message (`start` + rebuilt parts), then the continuation chunks. `from` counts chunks of that replay. New export `messageToChunks()`. See ADR-0045 and spec 04 §6.3.
