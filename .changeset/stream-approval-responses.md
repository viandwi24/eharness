---
"eharness": patch
---

Fix: a `respond()` continuation now streams one `tool-approval-response` chunk per approval it consumes, right after `start` and before the approved calls run.

- Readers that rebuild the assistant message from the stream (`readUIMessageStream`, `attach()`, non-`useChat` UIs) saw the answered calls stay in `approval-requested` until their output arrived, so a long-running approved tool looked like it was still waiting for approval.
- The chunk carries the approval id of the stored part, `approved` and the `reason`. Granted calls deferred behind client outputs or external waits, and approved calls of tools without `execute`, get none.
- Chunk order is public API (spec 04 §2, spec 11 §4): the continuation stream gains these chunks between `start` and the first tool output. `useChat` clients are unaffected (they already set the state locally).
