# Structured output

An agent used as a pipeline step or a worker often needs a **typed** answer — a classification,
an extracted record, a plan — rather than prose. `SendOptions.output` asks a turn for one: the
answer is validated against your schema, validation errors go back to the model a bounded number
of times, and the valid answer comes back typed in `result.output`.

Runnable: [`examples/structured-output.ts`](../../examples/structured-output.ts) ·
Contract: [spec 05 §3.3](../specs/05-session-and-storage.md#33-structured-output-normative-040) ·
Why: [ADR-0023](../decisions/0023-structured-final-output.md)

## A typed answer

```ts
import { z } from 'zod'

const triage = z.object({
  label: z.enum(['bug', 'feature', 'question']),
  priority: z.number().int().min(1).max(3),
  summary: z.string(),
})

const { stop, output } = await session.send(ticketText, { output: { schema: triage } }).result
if (stop === 'complete') {
  output // { label: 'bug' | 'feature' | 'question'; priority: number; summary: string } | undefined
}
```

`output` is typed from the schema for zod, AI SDK `jsonSchema<T>()` and Standard Schemas. It is set
only when `stop` is `'complete'`; a turn that stops for any other reason has `output: undefined`.
`respond()`, `regenerate()` and `edit()` take the same option.

The schema must be convertible to JSON Schema: zod, `jsonSchema()`, or a Standard Schema whose
vendor implements Standard JSON Schema. Anything else fails the turn with `EH_INVALID_INPUT`
(`error.details.reason: 'output-schema'`) before anything is stored.

## Tool mode (default)

```ts
session.send(text, { output: { schema: triage } })             // mode: 'tool'
session.send(text, { output: { schema: triage, toolName: 'submit_triage', description: 'Submit the triage.' } })
```

For this turn only, the core adds a `final_answer` tool whose input schema is your schema, and a
line to the turn reminder (`OUTPUT_INSTRUCTION`). The model works normally — it may call other
tools first — and ends the turn by calling `final_answer`. AI SDK validates the input; a call that
does not match is answered with the validation error, which the model reads and fixes. Works with
every model that calls tools.

The tool is appended **after** every other tool, so the cached prompt prefix of the instructions
and the other tools stays the same; only the tail of the tool list differs from turns without
`output` (one cache miss of that tail for this turn and for the next turn without it). The tool
never asks for approval and stays active even when `turn.prepare` / `step.prepare` restrict
`activeTools`. `toolName` must not collide with a tool of the turn (`EH_INVALID_INPUT`,
`'output-tool-name'`).

## Native mode

```ts
session.send(text, { output: { schema: triage, mode: 'native' } })
```

Every step passes AI SDK's `output: Output.object({ schema })` to `streamText`: the provider's
structured output (`responseFormat`). When the model finishes with text, AI SDK parses and
validates it; an unparsable or mismatching answer (`NoObjectGeneratedError`) is a failed attempt.
Use it with providers that support structured output well; `responseFormat` is part of the request
and may change the provider's cache key for the turn. Providers without it are handled by AI SDK
(a warning or JSON in text); eharness does not emulate it.

## Retries and failure

When the turn would end `'complete'` without a valid answer (tool mode: the model answered in prose
and never called `final_answer`; native mode: the final text did not parse or validate), the core
continues the turn with a retry delivered like any continuation:

- a `data-eh.input` part with `source: 'plugin:eh.output'` and the text `OUTPUT_RETRY` (with the
  validation error, trimmed to 1 000 characters) is written into the assistant message;
- in tool mode the retry step forces the tool (`toolChoice: { type: 'tool', toolName }`).

`maxRetries` (default 2) bounds it: after `maxRetries + 1` failed answers the turn stops with
**`'output-invalid'`** and the warning `W_OUTPUT_INVALID` (`details: { attempts, lastError }`). A
retry is also a continuation: it counts toward `loop.maxContinues` / `loop.maxIdleContinues`
(a refused retry also ends `'output-invalid'`), the step budget (`'max-steps'`, no wrap-up step)
and the budgets (`'cost-cap'`). Aborts, timeouts and errors keep their stop reasons.

Plugin `turn.beforeEnd` hooks run before the output check — a todos plugin that asks the model to
finish its list wins; the answer is checked when the turn would finally end.

```ts
const result = await session.send(text, { output: { schema: triage, maxRetries: 1 } }).result
switch (result.stop) {
  case 'complete':
    save(result.output)
    break
  case 'output-invalid':
    console.warn('no valid answer') // the last error is in the W_OUTPUT_INVALID warning
    break
  default:
    console.warn(`stopped: ${result.stop}`)
}
```

`'output-invalid'` is a new `StopReason` in 0.4.0: an exhaustive `switch` over `StopReason` needs a
case for it.

## Storage and rendering

The valid answer is stored in the assistant message as a persistent `data-eh.output` part
(`{ value, mode, attempts }`, id `output`, never sent to the model), and every turn with an output
spec gets `metadata.eharness.output = { ok, attempts }`. UIs can render the part like any data
part ([rendering data parts](rendering-data-parts.md)); `value` equals `result.output`.

## Approvals and `respond()`

If the turn stops `'tool-pending'` (an approval is waiting), `output` is `undefined` and the output
spec is **not** remembered — a schema is code, not data, so it cannot go into the pending state.
Pass it again when you answer:

```ts
const first = await session.send(text, { output: { schema: triage } }).result
if (first.stop === 'tool-pending') {
  const second = await session.respond(answers, { output: { schema: triage } }).result
  second.output // typed again
}
```

`handleChatRequest` never reads `output` from a request body: it is a server-side option
(`handleChatRequest(session, body, { output })`).
