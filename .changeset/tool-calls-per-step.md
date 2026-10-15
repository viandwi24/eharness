---
"eharness": patch
---

New `toolCalls.maxPerStep` (default 24): a step runs at most that many tool calls, and an exact repeat of a call in the same step does not run again; the model reads why. A degenerate step of hundreds of parallel calls no longer hammers a tool server.
