---
"eharness": minor
---

Structured final output (spec 05 §3.3, ADR-0023).

- New `SendOptions.output = { schema, mode?: 'tool' | 'native', maxRetries?, toolName?, description? }`
  (also for `respond`, `regenerate`, `edit`): the turn's final answer is validated against the
  schema, invalid or missing answers are retried (default 2 retries) and the valid answer is
  returned as `TurnResult.output`, typed from the schema (zod, `jsonSchema<T>()`, Standard Schema).
  Tool mode (default) adds a `final_answer` tool for that turn, appended last in the tool order;
  native mode uses AI SDK `Output.object` on `streamText`. Standard Schemas need JSON Schema
  support (else `EH_INVALID_INPUT`, `details.reason: 'output-schema'`).
- New persisted part `data-eh.output { value, mode, attempts }`, new `metadata.eharness.output
  { ok, attempts }`, new warning `W_OUTPUT_INVALID`, new fixed texts `FINAL_ANSWER_DESCRIPTION`,
  `FINAL_ANSWER_RECORDED`, `OUTPUT_INSTRUCTION`, `OUTPUT_RETRY`; new types `OutputSpec`,
  `SendOptionsWithOutput`, `OutputPartData`. Retries are delivered as `data-eh.input` with source
  `plugin:eh.output` and count as continuations (`loop.maxContinues` / `maxIdleContinues`).
- **Type-level:** `StopReason` gains **`'output-invalid'`** — exhaustive `switch` statements must
  add a case (as with `'stuck'` in 0.3 and `'context-thrash'` in this release). `HarnessRun` gains a
  second type parameter `O` (defaulted to `never`, so `HarnessRun<M>` is unchanged) and
  `TurnResult` a second type parameter `O` (default `unknown`) with the optional field `output`.
  `HarnessSession` methods gain typed overloads (custom implementations stay assignable).
- Turns without `output` are unchanged (same wire, same stored messages).
