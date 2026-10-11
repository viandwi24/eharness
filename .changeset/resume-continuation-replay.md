---
"eharness": minor
---

**BREAKING (stream shape and cursor):** Resume of a `respond()` continuation now works with AI SDK `resumeStream()`: `attach()`, `attachRemote()`, the stream log and `handleResumeRequest()` start with a replay of the continued message (`start` + rebuilt parts), then the continuation chunks. `from` counts chunks of that replay. New export `messageToChunks()`. See ADR-0045 and spec 04 §6.3.

Migration: a client that resumes a `respond()` continuation now receives the replay chunks first, and stored `from` cursors count them; drop cursors saved before the upgrade (resume from `0`). Readers that already rebuild messages from the stream (`useChat`, `readUIMessageStream`) need no change.
