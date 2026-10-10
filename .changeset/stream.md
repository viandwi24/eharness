---
"eharness": minor
---

**BREAKING:** the stream of a `respond()` continuation starts with `tool-approval-response` chunks, and reasoning parts carry a duration.

- **BREAKING (chunk order):** a `respond()` continuation writes one `tool-approval-response` chunk per consumed approval (the stored approval id, `approved`, `reason`) between `start` and the first tool output. Readers that rebuild the assistant message from the stream (`readUIMessageStream`, `attach()`, non-`useChat` UIs) now see answered calls leave `approval-requested` at once instead of when the output arrives; `useChat` clients are unaffected. Granted calls deferred behind client outputs or external waits, and approved calls of tools without `execute`, get no chunk. Update golden streams.
- Every `reasoning-end` chunk carries `providerMetadata.eharness.durationMs`, so UIs and stored reasoning parts can show how long the model thought. The key is removed from the provider wire.
