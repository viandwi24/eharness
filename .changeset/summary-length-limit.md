---
"eharness": patch
---

Compaction asks for a brief of at most `maxSummaryTokens` (the limit is now in the summarizer prompt) and the agent's `maxOutputTokens` no longer raises the summarizer output cap. A model given a 32k cap wrote summaries as long as the transcript, so a small context window compacted again on almost every turn.
