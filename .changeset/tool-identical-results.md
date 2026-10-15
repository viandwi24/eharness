---
'eharness': patch
---

Add `toolCalls.maxIdenticalResults` (default 3; 0 disables): within one turn, the same tool with the same input returning the same result or error text that many times is no longer run again and the model reads a refusal. Changing results (polling) stay allowed.
