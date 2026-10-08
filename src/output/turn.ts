/**
 * Structured final output of one turn (internal): spec validation, the per-turn `final_answer`
 * tool (tool mode), AI SDK `Output.object` (native mode) and the answer checks the step loop runs.
 *
 * @see docs/specs/05-session-and-storage.md#33-structured-output-normative-040
 * @see docs/decisions/0023-structured-final-output.md
 */
import {
  asSchema,
  type GenericToolApprovalFunction,
  type ModelMessage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type Tool,
  type ToolSet,
  tool,
} from 'ai'
import { HarnessError } from '../errors.ts'
import {
  FINAL_ANSWER_DESCRIPTION,
  FINAL_ANSWER_RECORDED,
  OUTPUT_INSTRUCTION,
  OUTPUT_RETRY,
} from '../messages/texts.ts'
import type { TurnRegistry } from '../registry/turn.ts'
import type { OutputSpec } from './types.ts'

/** Default name of the output tool (tool mode). */
export const DEFAULT_OUTPUT_TOOL = 'final_answer'
/** Default `OutputSpec.maxRetries`. */
export const DEFAULT_OUTPUT_RETRIES = 2
/** Validation errors are trimmed to this many characters in `OUTPUT_RETRY`. */
const MAX_ERROR_CHARS = 1_000
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** The answer check of one attempt. */
export type OutputCheck = { ok: true; value: unknown } | { ok: false; error: string }

/** Progress of the answer checks of one turn (written by the step loop). */
export interface TurnOutputState {
  /** Failed answers so far (invalid / missing). */
  failures: number
  /** The latest valid answer. */
  value?: { value: unknown }
  /** Error of the latest failed answer. */
  lastError?: string
}

/** The output machinery of one turn. */
export interface TurnOutput {
  readonly mode: 'tool' | 'native'
  /** Answer checks so far. */
  readonly state: TurnOutputState
  readonly toolName: string
  readonly maxRetries: number
  /** Native mode: `Output.object(…)`, passed to every step except the wrap-up step. */
  readonly native: ReturnType<typeof Output.object> | undefined
  /** Tool mode: the output tool (not wrapped: no hooks, no approval, no output limits). */
  readonly tool: Tool | undefined
  /**
   * Tool mode: the `final_answer` calls of one step's response. `undefined` when the step did not
   * call it; a successful call wins over failed ones (the last successful value is used).
   */
  inspect(response: readonly ModelMessage[]): OutputCheck | undefined
}

function invalid(message: string, reason: string, cause?: unknown): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', message, {
    details: { reason },
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * Validate `SendOptions.output` and build the turn's output machinery (spec 05 §3.3 rule 1).
 * Throws `EH_INVALID_INPUT` (`details.reason`: `'output-spec'`, `'output-schema'`,
 * `'output-tool-name'`).
 */
export async function prepareTurnOutput(
  spec: OutputSpec | undefined,
  turnTools: ReadonlySet<string>,
): Promise<TurnOutput | undefined> {
  if (spec === undefined) return undefined
  if (typeof spec !== 'object' || spec === null || spec.schema === undefined) {
    throw invalid('`output.schema` is required.', 'output-spec')
  }
  const mode = spec.mode ?? 'tool'
  if (mode !== 'tool' && mode !== 'native') {
    throw invalid("`output.mode` must be 'tool' or 'native'.", 'output-spec')
  }
  const maxRetries = spec.maxRetries ?? DEFAULT_OUTPUT_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw invalid('`output.maxRetries` must be a non-negative integer.', 'output-spec')
  }
  // both modes need a JSON Schema: the tool's input schema / the provider's responseFormat
  try {
    await asSchema(spec.schema).jsonSchema
  } catch (error) {
    throw invalid(
      `\`output.schema\` cannot be converted to JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      'output-schema',
      error,
    )
  }
  const toolName = spec.toolName ?? DEFAULT_OUTPUT_TOOL
  if (mode === 'tool') {
    if (!TOOL_NAME.test(toolName)) {
      throw invalid(
        `\`output.toolName\` '${toolName}' must match ${String(TOOL_NAME)}.`,
        'output-tool-name',
      )
    }
    if (turnTools.has(toolName)) {
      throw invalid(
        `\`output.toolName\` '${toolName}' collides with a tool of the turn; choose another name.`,
        'output-tool-name',
      )
    }
  }

  /** Validated inputs of successful output tool calls, by tool call id. */
  const values = new Map<string, unknown>()
  const outputTool =
    mode === 'tool'
      ? (tool({
          description: spec.description ?? FINAL_ANSWER_DESCRIPTION,
          inputSchema: spec.schema,
          // the input arrives validated (and transformed) by AI SDK
          execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
            values.set(toolCallId, input)
            return FINAL_ANSWER_RECORDED
          },
        } as never) as Tool)
      : undefined
  const native =
    mode === 'native'
      ? Output.object({
          schema: spec.schema,
          ...(spec.toolName === undefined ? {} : { name: spec.toolName }),
          ...(spec.description === undefined ? {} : { description: spec.description }),
        })
      : undefined

  return {
    mode,
    state: { failures: 0 },
    toolName,
    maxRetries,
    native,
    tool: outputTool,
    inspect(response) {
      let success: { value: unknown } | undefined
      let error: string | undefined
      for (const message of response) {
        if (message.role !== 'tool') continue
        for (const part of message.content) {
          if (part.type !== 'tool-result' || part.toolName !== toolName) continue
          const output = part.output
          if (output.type === 'error-text') error = output.value
          else if (output.type === 'error-json') error = JSON.stringify(output.value)
          else if (output.type === 'execution-denied') error = output.reason ?? 'denied'
          else if (values.has(part.toolCallId)) success = { value: values.get(part.toolCallId) }
        }
      }
      if (success !== undefined) return { ok: true, value: success.value }
      return error === undefined ? undefined : { ok: false, error }
    },
  }
}

/**
 * The turn registry with the output tool appended **last** (after `tool_search`, spec 02 §6
 * rule 1), exempt from approval, plus `OUTPUT_INSTRUCTION` in the turn reminder. Native mode and
 * turns without output keep the registry unchanged.
 */
export function withOutputTool(
  registry: TurnRegistry,
  output: TurnOutput | undefined,
): TurnRegistry {
  if (output?.tool === undefined) return registry
  const name = output.toolName
  const outputTool = output.tool
  const tools: ToolSet = { ...registry.tools, [name]: outputTool }
  const base = registry.approval
  const approval: GenericToolApprovalFunction<ToolSet, never, unknown> | undefined =
    base === undefined
      ? undefined
      : async (options) => (options.toolCall.toolName === name ? 'not-applicable' : base(options))
  const instruction = OUTPUT_INSTRUCTION.replace('{tool}', name)
  let lastBase: ToolSet | undefined
  let lastStep: ToolSet = tools
  return {
    ...registry,
    turnReminder:
      registry.turnReminder === undefined
        ? instruction
        : `${registry.turnReminder}\n\n${instruction}`,
    instructionBlocks: [
      ...registry.instructionBlocks,
      { owner: 'core:output', refresh: 'turn', text: instruction },
    ],
    entries: [...registry.entries, { owner: 'eh', name, tool: outputTool }],
    tools,
    toolOrder: [...registry.toolOrder, name],
    approval,
    toolsForStep(discovered) {
      const step = registry.toolsForStep(discovered)
      if (step !== lastBase) {
        lastBase = step
        lastStep = step === registry.tools ? tools : { ...step, [name]: outputTool }
      }
      return lastStep
    },
  }
}

/**
 * Native mode: parse the output of a step that ended `'complete'` (AI SDK `result.output`).
 * `NoObjectGeneratedError` (unparsable / invalid JSON) and `NoOutputGeneratedError` are failed
 * attempts; their text goes to `OUTPUT_RETRY`.
 */
export async function checkNative(output: PromiseLike<unknown>): Promise<OutputCheck> {
  try {
    return { ok: true, value: await output }
  } catch (error) {
    return { ok: false, error: describeOutputError(error) }
  }
}

function describeOutputError(error: unknown): string {
  if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
    const cause = (error as { cause?: unknown }).cause
    return cause instanceof Error && cause.message.length > 0
      ? `${error.message} ${cause.message}`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** The `OUTPUT_RETRY` text for a failed attempt (error trimmed to 1 000 characters). */
export function outputRetryText(error: string): string {
  const trimmed = error.length > MAX_ERROR_CHARS ? `${error.slice(0, MAX_ERROR_CHARS)}…` : error
  return OUTPUT_RETRY.replace('{error}', trimmed)
}

/** The error of a tool-mode attempt that ended without calling the output tool. */
export function missingToolError(toolName: string): string {
  return `the \`${toolName}\` tool was not called.`
}
