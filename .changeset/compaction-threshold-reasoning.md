---
"eharness": patch
---

Compaction now works with a large output reserve and with reasoning models. The effective `summarizeAt` is at most 95% of the guard's hard limit: with a 32k output cap on a 128k window the hard limit (82k) sat below `summarizeAt` (102k), so the guard trimmed every request while the summary never triggered. The summarizer call's `maxOutputTokens` is the agent's `settings.maxOutputTokens` (else `maxSummaryTokens + 12 000`) instead of `maxSummaryTokens`: reasoning models spent the 4 000-token limit on thinking, the summary was cut (`finishReason: 'length'`), and every compaction failed.
