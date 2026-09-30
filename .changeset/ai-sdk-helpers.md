---
"eharness": minor
---

**BREAKING:** the minimum peer versions are now `ai@^7.0.123` and `@ai-sdk/mcp@^2.0.63` (the tested
versions). eharness imports values such as `StreamProviderError` and `toolSearch` that early
`ai` 7.0.x releases do not export; 0.1.0 already needed `ai` ≥ ~7.0.90 in practice.
Migration: `npm install ai@^7.0.123` (and `@ai-sdk/mcp@^2.0.63` if you use `eharness/mcp`).

**BREAKING (model-visible behaviour):** the built-in skill tools (`load_skill`, `read_skill_file`,
`search_skills`) now validate their input with AI SDK. Malformed input (a missing or non-string
field) is a tool error (`output-error` part, `step.end` status `'error'`) with AI SDK's text
`AI_InvalidToolInputError: Invalid input for tool <tool>: …` instead of a result text
``ERROR: `<field>` must be a string``. Their JSON input schemas now include a `$schema` key
(draft-07), which changes the tool definitions sent to the model once (one prompt-cache miss).
Migration: if you match the old `ERROR: … must be a string` text, match the tool error instead.

**Behaviour change:** `StepEndEvent.toolResults` is now derived from AI SDK's `StepResult`: results
are listed in call order, and a tool whose `toModelOutput` returns `error-text` now has status
`'output'` (it was `'error'`). Migration: to inspect the model output, read `event.step` or
`event.responseMessages`.

- Context overflow recovery now also works after AI SDK retries: a "prompt too long" rejection
  wrapped in a `RetryError` (e.g. a 429 followed by a 400, or behind a gateway error's `cause`)
  and `StreamProviderError`s with status 400/413 are recognised.
- `describeError` uses the same classification. A `RetryError` whose last attempt has no HTTP
  status (e.g. a network error) but an earlier attempt was a 429 / 5xx now reads `Rate limited: …`
  / `Provider unavailable: …` instead of `Unexpected error (see server logs)`.
- New: the `step.end` event exposes AI SDK's `StepResult` of the step as `step`.
- Tool errors for invalid tool input and unknown tools now reach the UI stream and stored
  messages with the same text the model got (`AI_InvalidToolInputError: …`,
  `AI_NoSuchToolError: …`) instead of `Unexpected error (see server logs)`.
- `DataChunk` is now derived from AI SDK's `UIMessageChunk` (same shape).
