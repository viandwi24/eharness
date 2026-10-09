---
"eharness": patch
---

Tool parts in state `output-error` that carry the deprecated `rawInput` field (set by AI SDK's UI stream when a tool call's input fails to parse) are normalised to `input` before persisting, validating on load and projecting to the model, so AI SDK's `rawInput` deprecation warning is no longer logged.
