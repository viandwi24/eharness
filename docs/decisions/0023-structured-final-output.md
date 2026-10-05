# ADR-0023: Structured final output per turn (tool and native modes)

Status: **Proposed** · Date: 2026-10-05

## Context

Agents used as pipeline steps or workers need a **typed** final answer, not prose: a
classification, an extracted record, a plan. Applications re-implement the same loop around the
harness — ask for JSON, parse it, validate it, send the error back, give up after a few tries —
and it fights the harness loop (a separate model call outside the turn, no history, no budgets).
AI SDK v7 offers structured output on `streamText` (`output: Output.object({ schema })`), but it
only parses the last step's text: tool loops, retries and storage are left to the caller, and some
providers (or models) handle tools plus `responseFormat` poorly.

## Decision

- **A per-turn option**, `SendOptions.output = { schema, mode, maxRetries, toolName,
  description }`, also accepted by `respond`, `regenerate` and `edit`. `TurnResult.output` is typed
  from the schema through `send()` overloads (`HarnessRun<M, InferSchema<S>>`, second type
  parameter defaulted to `never`, so `HarnessRun<M>` is unchanged).
- **Two modes.**
  - `'tool'` (default): the core appends a core-owned `final_answer` tool (input schema = the
    schema) for this turn and a line to the turn reminder. Works with every tool-calling model,
    keeps tools usable in the same steps, and AI SDK's own tool-input validation produces the
    error the model reads.
  - `'native'`: AI SDK's `Output.object` on every step (rule 2, ADR-0001: no parallel parser);
    the core only awaits `result.output` of the step that ended `'complete'` and maps
    `NoObjectGeneratedError` / `NoOutputGeneratedError` to a failed attempt.
- **`final_answer` is appended last** in the tool order, after `tool_search` (spec 02 §6). The tool
  list is part of the cached prompt prefix (ADR-0013); appending at the end keeps everything
  before it identical, so only the tail of the tool block differs from turns without output. The
  miss is expected and per turn, so no `W_CACHE_BUST`.
- **Retries reuse the continuation machinery** of `turn.beforeEnd` (spec 05 §3.1) instead of a
  second loop: the retry is a `data-eh.input` with source `plugin:eh.output` (`eh` is reserved, so
  no plugin can collide; no change to the persisted source union), counted by
  `loop.maxContinues` / `maxIdleContinues`, budgets and `maxSteps` like any continuation. Stored
  order equals model order (ADR-0011). Plugin `turn.beforeEnd` hooks run first; the output check
  runs on the final `'complete'`.
- **Bounded failure is a stop reason**, `'output-invalid'`, with `W_OUTPUT_INVALID`; every other
  stop keeps its reason and leaves `output` undefined.
- **The answer is stored** as a persistent, never-projected core part `data-eh.output` (audit;
  UIs can render it) plus `metadata.eharness.output = { ok, attempts }`.
- **No carry-over across `respond()`.** A schema is code, not data: it cannot be written to the
  pending state, and silently remembering it in memory would differ between instances. The caller
  passes `output` again.

## Consequences

+ One option turns any agent into a typed worker; the answer, its attempts and failures are
  visible in storage and in `TurnResult`.
+ No new loop, no new persisted types besides one data part and one metadata key; turns without
  output are byte-identical to 0.3.
− `StopReason` gains `'output-invalid'` (type-level change for exhaustive switches).
− Tool mode adds one tool to the cached prefix for that turn; native mode adds `responseFormat`,
  which may change the provider's cache key for the turn.
− Schemas must convert to JSON Schema (Standard Schemas need Standard JSON Schema support).
− The wrap-up step at `'max-steps'` does not force a final answer (roadmap candidate).

## Alternatives considered

- Only native mode (rejected: weaker with tool loops and on providers without structured output).
- A separate `generateObject` call after the turn (rejected: a second request outside budgets,
  history and the stream; duplicates AI SDK's loop).
- A plugin (rejected: needs the stop rules and the tool list of the core; the hook list is
  closed).
- Carrying the spec across `respond()` in memory (rejected: not durable, differs per instance).
