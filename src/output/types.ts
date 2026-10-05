/**
 * Structured final output of a turn (0.4.0): `SendOptions.output`.
 *
 * @see docs/specs/05-session-and-storage.md#33-structured-output-normative-040
 */
import type { FlexibleSchema } from 'ai'

/**
 * Ask a turn for a typed final answer: the answer is validated against `schema`, validation
 * errors are fed back to the model up to `maxRetries` times, and the valid answer is returned as
 * `TurnResult.output` (typed from the schema) and stored as a `data-eh.output` part.
 *
 * The schema must be convertible to JSON Schema (zod, AI SDK `jsonSchema()`, or a Standard Schema
 * that implements Standard JSON Schema); otherwise the turn fails with `EH_INVALID_INPUT`.
 *
 * @example
 * ```ts
 * const run = session.send('Classify this ticket', {
 *   output: { schema: z.object({ label: z.enum(['bug', 'question']), confidence: z.number() }) },
 * })
 * const { stop, output } = await run.result // output typed from the schema, or undefined
 * ```
 * @see docs/specs/05-session-and-storage.md#33-structured-output-normative-040
 */
export interface OutputSpec<S extends FlexibleSchema = FlexibleSchema> {
  /** Schema of the final answer. */
  schema: S
  /**
   * - `'tool'` (default): the core adds a `final_answer` tool (input schema = `schema`) for this
   *   turn; a successful call ends the turn. Works with every tool-calling model.
   * - `'native'`: AI SDK `Output.object({ schema })` on every step (the provider's structured
   *   output / `responseFormat`); the final text is parsed and validated by AI SDK.
   */
  mode?: 'tool' | 'native'
  /** Retries after an invalid or missing answer. Default 2 (at most 3 answers are checked). */
  maxRetries?: number
  /**
   * Tool mode: name of the output tool (default `'final_answer'`). Native mode: passed as the
   * `name` of `Output.object`. In tool mode it must not collide with a tool of the turn.
   */
  toolName?: string
  /** Tool description (tool mode) / `Output.object` description (native mode). */
  description?: string
}
