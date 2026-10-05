# P18 — Structured final output

Status: todo · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal item **U6** (roadmap item "Output guardrails", schema part).

## Goal

An agent used as a pipeline step or worker can ask a turn for a **typed** final answer:
`send(input, { output: { schema } })` validates the answer against the schema, feeds validation
errors back to the model a bounded number of times, and returns `TurnResult.output` typed from
the schema. Two modes: `'tool'` (default, a `final_answer` tool) and `'native'` (AI SDK's own
`output: Output.object(...)` on `streamText`). The validated output is stored as a
`data-eh.output` part for audits.

## Specs / docs to read

- `docs/specs/05-session-and-storage.md` §2 (`SendOptions`, `HarnessRun`, failure semantics),
  §3 step 5/9/15–17, §3.1 (stop rules, `turn.beforeEnd`, continuation bounds, wrap-up), §3.2
- `docs/specs/01-agent-and-plugins.md` §5 (`turn.beforeEnd` continuation machinery)
- `docs/specs/11-interaction.md` §4 (`respond()` continuation), §6.4 (hook-provided context as
  `data-eh.input`)
- `docs/specs/02-context-registry.md` §6 (stable tool list, `toolOrder`, `W_CACHE_BUST`)
- `docs/specs/03-messages.md` §4.3 (core data parts)
- `docs/specs/04-streaming.md` §7 (`HarnessRun`)
- `docs/specs/10-errors-and-stop-reasons.md` §4 (`StopReason`, `TurnResult`)
- ADR-0001, ADR-0002 (one `streamText` per step), ADR-0013, ADR-0015

**AI SDK verified (2026-10-05):**

- `streamText({ output })` exists in v7 (installed `ai@7.0.123` `dist/index.d.ts`: `output?:
  OUTPUT` on `streamText`/`generateText` options; `Output` namespace exports `text`, `object`,
  `array`, `choice`, `json`; `Output.object({ schema: FlexibleSchema<OBJECT>, name?,
  description? })`). `StreamTextResult.output: PromiseLike<…>`; `partialOutputStream`.
  `GenerateTextResult.output` throws `NoOutputGeneratedError` "when the final step finishes with
  a `tool-calls` reason, or when it contains no text and does not finish with a `stop` reason";
  parse/validation failures are `NoObjectGeneratedError` (`text`, `finishReason`, `cause`).
  Docs: `https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data` ("structured output
  generation counts as a step"; combine with tools by allowing a step for the output).
- No change to `output` between 7.0.123 and 7.0.127
  (`https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md`).
- **Standard Schema:** `FlexibleSchema<T> = Schema<T> | LazySchema<T> | ZodSchema<T> |
  StandardSchema<T>` where `StandardSchema` is `StandardSchemaV1` with an optional
  `~standard.jsonSchema` converter (`@ai-sdk/provider-utils@5.0.52` d.ts). `asSchema()` validates
  any Standard Schema, but producing a JSON Schema (needed by both modes: the `final_answer` tool
  input and `responseFormat`) throws `Standard schema vendor '<v>' does not support JSON Schema
  conversion` unless the vendor implements Standard JSON Schema (`~standard.jsonSchema.input`).
  Zod (v3.25+/v4), AI SDK `jsonSchema()` and Standard-JSON-Schema vendors work.

## Owns

`src/session/**` (send options, run/result typing, end sequence), `src/loop/**` (stop rule,
retry continuation, per-turn tool), new `src/output/` folder inside core (not a subpath),
`src/messages/{types,data-parts,texts}.ts`, `src/agent/session-types.ts`, specs 03 / 04 / 05 /
10 / 11, ADR-0023, `docs/guides/structured-output.md` (new), `examples/structured-output.ts`.

## Design

```ts
export interface OutputSpec<S extends FlexibleSchema = FlexibleSchema> {
  schema: S
  mode?: 'tool' | 'native'        // default 'tool'
  maxRetries?: number             // default 2
  /** 'tool' mode only. Default 'final_answer'. */
  toolName?: string
  /** Passed to the tool description / Output.object description. */
  description?: string
}

send<S extends FlexibleSchema>(input, options: SendOptions & { output: OutputSpec<S> })
  : HarnessRun<M, InferSchema<S>>
// HarnessRun<M, O = never>: result: Promise<TurnResult<M> & { output?: O }>
```

Normative rules (spec 05 new §3.3 "Structured output"):

1. **Validation of the spec** at turn preparation (step 5): `asSchema(schema).jsonSchema` must
   resolve, else run error `EH_INVALID_INPUT` (`details.reason: 'output-schema'`); `toolName`
   colliding with a turn tool → `EH_INVALID_INPUT` (`'output-tool-name'`).
2. **Tool mode.** For this turn only, the core appends a tool `final_answer` (input schema =
   `schema`, `execute` returns `FINAL_ANSWER_RECORDED`) **at the end** of the tool order (after
   `tool_search`, spec 02 §6 rule 1), plus a turn reminder line `OUTPUT_INSTRUCTION` ("When done,
   call final_answer with …"). Documented cost: the tool list differs from turns without output
   → the cached tool prefix misses once for this turn (and the next turn without output); no
   `W_CACHE_BUST` (expected, per-turn decision). A step whose tool calls include a successful
   `final_answer` ends the turn with **`'complete'`** (new stop rule, evaluated before rule 4 of
   §3.1); other tool calls of that step still execute. Invalid input → AI SDK tool-input error
   → the model sees it and the loop continues (counts as one retry).
3. **Native mode.** Every step of the turn passes `output: Output.object({ schema, name:
   toolName, description })` to `streamText` (AI SDK-first, rule 2). When a step ends
   `'complete'`, the core awaits `result.output`: success → output; `NoObjectGeneratedError` →
   retry; `NoOutputGeneratedError` → retry. Providers without structured-output support: AI SDK
   decides (warning or JSON-in-text); eharness does not emulate. Documented: `responseFormat` is
   part of the request and may change the provider cache key for the turn.
4. **Retries** reuse the `turn.beforeEnd` continuation machinery inside the core (not a plugin):
   when the turn would stop `'complete'` without a valid output, the core continues with a
   `data-eh.input { source: 'plugin:eh.output', text: OUTPUT_RETRY }` (the validation error,
   trimmed to 1 000 chars), and in tool mode sets `toolChoice: { type: 'tool', toolName }` for the
   retry step. Retries count toward `loop.maxContinues` / `maxIdleContinues`, budgets and
   `maxSteps` like any continuation; plugin `turn.beforeEnd` hooks run **before** the output check
   (their continuation wins; the output check runs on the final `'complete'`).
5. **Stop.** After `maxRetries` failed attempts → new stop reason **`'output-invalid'`**, warning
   `W_OUTPUT_INVALID` (`details: { attempts, lastError }`). Any other stop (`'max-steps'`,
   `'error'`, `'aborted'`, `'tool-pending'`, `'cost-cap'`, …) keeps its reason and `output` is
   `undefined`. The wrap-up step is unchanged (`toolChoice: 'none'`, no output).
6. **Storage.** A valid output is written as persistent core part `data-eh.output { value, mode,
   attempts }` (id `output`, reconciled, `model: 'omit'`) into the assistant message;
   `TurnResult.output = value`. `metadata.eharness.output?: { ok: boolean; attempts: number }`.
7. **`respond()` continuation:** the output spec is not serializable, so it is **not** carried
   over pending state; `respond(…, { output })` must pass it again (documented). A turn that ends
   `'tool-pending'` returns `output: undefined`.
8. **`handleChatRequest`** does not accept `output` from the body (server-side option only).

## Checklist

- [ ] ADR-0023 "Structured final output" (tool vs native, why `final_answer` is appended last,
      why retries reuse continuations, why no carry-over across `respond()`).
- [ ] Specs: 05 §2 (`SendOptions.output`, `HarnessRun` generic), new §3.3, §3.1 rule for
      `final_answer`; 03 §4.3 `data-eh.output`, §3 `metadata.eharness.output`; 04 §7
      `HarnessRun<M, O>`; 10 §4 stop reason + `TurnResult.output`, §2 `W_OUTPUT_INVALID`, §5 texts
      (`FINAL_ANSWER_RECORDED`, `OUTPUT_INSTRUCTION`, `OUTPUT_RETRY`); 11 §4 respond note.
- [ ] Type tests first (`src/session/output.test-d.ts`): `result.output` is `z.infer<schema>`
      for zod, `InferSchema` for `jsonSchema<T>()` and a Standard Schema; `send()` without
      `output` keeps `HarnessRun<M>` unchanged.
- [ ] Runtime tests first (`src/session/output.int.test.ts`, scripted model):
  - [ ] tool mode valid first try → `'complete'`, `output`, `data-eh.output` stored;
  - [ ] invalid then valid (retry with forced `toolChoice`) → attempts 2;
  - [ ] never valid → `'output-invalid'` after `maxRetries`, warning;
  - [ ] model answers text without calling `final_answer` → retry reminder;
  - [ ] native mode with a scripted model returning JSON text → `output`; invalid JSON → retry;
        `NoOutputGeneratedError` path;
  - [ ] `final_answer` is last in `toolOrder`; tools of the next turn without output unchanged;
  - [ ] Standard Schema without JSON Schema support → `EH_INVALID_INPUT` run error;
  - [ ] tool name collision → `EH_INVALID_INPUT`;
  - [ ] budgets / `maxSteps` / abort during retry keep their stop reasons;
  - [ ] plugin `turn.beforeEnd` continuation still runs first.
- [ ] Implement.
- [ ] Guide `docs/guides/structured-output.md` (+ `guides/README.md` row); offline example
      `examples/structured-output.ts` in `examples.test.ts`.
- [ ] `reference.md`; changeset; board.

## Acceptance criteria

- [ ] `const { output } = await session.send(x, { output: { schema } }).result` is typed and
      validated in both modes.
- [ ] Failure is bounded (`maxRetries`, continuation bounds, budgets) and observable
      (`'output-invalid'`, warning, metadata).
- [ ] Turns without `output` are byte-identical to 0.3 (wire golden, stored golden).
- [ ] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New `SendOptions.output` (`schema`, `mode: 'tool' | 'native'`, `maxRetries`, `toolName`),
  `TurnResult.output`, persisted part `data-eh.output`, `metadata.eharness.output`, warning
  `W_OUTPUT_INVALID`.
- **Type-level:** `StopReason` gains **`'output-invalid'`** — exhaustive `switch` statements must
  add a case (as with `'stuck'` in 0.3 and `'context-thrash'` in this release); `HarnessRun` gains
  a second type parameter (defaulted, non-breaking for users; custom implementations unaffected).
- Native mode uses AI SDK `Output.object`; Standard Schemas need JSON Schema support.

## Open questions

- Retry input source `plugin:eh.output` reuses the existing `data-eh.input` source union (no
  persisted-type change; `eh` is reserved so it cannot collide with a plugin name). Alternative
  `source: 'system'` would change the persisted union. Decision: `plugin:eh.output`.
- Should the wrap-up step at `'max-steps'` force `final_answer` instead of `toolChoice: 'none'`?
  Decision for 0.4: no (wrap-up unchanged, `output` undefined); roadmap candidate.
- `Output.array` / `Output.choice` in native mode: only `object` in 0.4 (schema-driven);
  `choice` can be expressed as an enum object. Roadmap if requested.

## Requests to other phases

- P14: both new stop reasons are documented together in spec 10 §4 and the changesets.
- P20: guide links, results table U6 (API final: `TurnResult.output`, `'output-invalid'`,
  `plugin:eh.output` source).

## Dependencies

P13 recommended first (loop/session fixes in the same files). No hard dependency.
