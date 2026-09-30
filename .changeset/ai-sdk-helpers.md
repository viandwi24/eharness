---
"eharness": patch
---

- Context overflow recovery now also works after AI SDK retries: a "prompt too long" rejection
  wrapped in a `RetryError` (e.g. a 429 followed by a 400) and `StreamProviderError`s with status
  400/413 are recognised. `describeError` uses the same classification.
- The `step.end` event exposes AI SDK's `StepResult` of the step as `step`. `toolCalls` and
  `toolResults` keep their shape and are derived from it.
- Tool errors for invalid tool input and unknown tools now reach the UI stream and stored
  messages with the same text the model got (`AI_InvalidToolInputError: …`,
  `AI_NoSuchToolError: …`) instead of `Unexpected error (see server logs)`.
- The built-in skill tools (`load_skill`, `read_skill_file`, `search_skills`) validate their
  input with AI SDK: malformed input now returns AI SDK's
  `AI_InvalidToolInputError: Invalid input for tool …` error instead of
  ``ERROR: `<field>` must be a string``. Their JSON input schemas now include a `$schema` key.
- `DataChunk` is now derived from AI SDK's `UIMessageChunk` (same shape).
