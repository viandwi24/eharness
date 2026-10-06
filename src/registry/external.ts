/**
 * `externalTool()`: an AI SDK tool without `execute` whose result comes from the outside world
 * (a webhook, a job, another agent, a person). The turn parks at the tool boundary (pending kind
 * `external`) and `session.resolveWait()` delivers the result later, in any instance.
 *
 * The tool stays a plain AI SDK `tool()`; the harness-side definition (`start`, timeouts) rides
 * on a symbol property that survives object spreads.
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 * @see docs/decisions/0027-external-waits-park-at-the-tool-boundary.md
 */
import { type FlexibleSchema, type JSONValue, type Tool, tool } from 'ai'
import type { ToolRisk, WaitTimeoutResult } from '../messages/types.ts'
import type { HarnessContext } from '../plugin/types.ts'

/** What `start` receives (spec 11 §4.2 rule 1). */
export interface WaitStartEvent {
  /** `w_<toolCallId>`: stable, so the outside system can deduplicate a retried `start`. */
  waitId: string
  toolCallId: string
  ctx: HarnessContext
  /** The turn's abort signal. */
  abortSignal: AbortSignal
}

/** What `start` may return: per-wait overrides of the tool's defaults. */
export interface WaitStart {
  /** Id the outside work was started with (shown in `pendingWaits()` and pending state). */
  correlationId?: string
  /** Opaque JSON for UIs and sweepers. */
  payload?: JSONValue
  /** Relative timeout; overrides the tool's `timeoutMs`. */
  timeoutMs?: number
  /** Absolute timeout (epoch ms); wins over `timeoutMs`. */
  timeoutAt?: number
  /** Result the wait takes when it times out; overrides the tool's `onTimeout`. */
  onTimeout?: WaitTimeoutResult
}

/** Definition of {@link externalTool}. */
export interface ExternalToolDef<INPUT, OUTPUT> {
  description: string
  inputSchema: FlexibleSchema<INPUT>
  /** Validates results given to `resolveWait()` (`EH_INVALID_INPUT`, `'invalid-result'`). */
  outputSchema?: FlexibleSchema<OUTPUT>
  /**
   * Starts the outside work after the step ended and the pending state was committed, so a fast
   * callback finds the wait pending. Idempotent by `waitId`: a crash between the commit and
   * `start` dispatches it again. A throwing `start` is `W_HOOK_FAILED`; the wait stays parked
   * until a result or its timeout.
   */
  start?: (
    input: INPUT,
    event: WaitStartEvent,
    // biome-ignore lint/suspicious/noConfusingVoidType: a `start` that returns nothing is fine
  ) => Promise<WaitStart | void> | WaitStart | void
  /** Default timeout of every wait of this tool, in ms (`start` may override). */
  timeoutMs?: number
  /** Result on timeout. Default `{ errorText: WAIT_TIMED_OUT }`. */
  onTimeout?: { errorText: string } | { output: OUTPUT }
  /** Tool traits (spec 11 §3.2). */
  metadata?: { risk?: ToolRisk; idempotent?: boolean }
}

/** The symbol property carrying the harness-side definition. `Symbol.for` so package copies agree. */
export const EXTERNAL_TOOL: unique symbol = Symbol.for('eharness.externalTool')

/** The harness-side part of an external tool (internal). */
export interface ExternalToolMeta {
  start?: ExternalToolDef<unknown, unknown>['start']
  timeoutMs?: number
  onTimeout?: WaitTimeoutResult
}

/**
 * Create an external tool: a tool without `execute` whose result is delivered later through
 * `session.resolveWait()`.
 *
 * @example
 * ```ts
 * const build = externalTool({
 *   description: 'Run a CI build and wait for its result',
 *   inputSchema: z.object({ ref: z.string() }),
 *   outputSchema: z.object({ ok: z.boolean() }),
 *   start: async ({ ref }, { waitId }) => {
 *     await ci.trigger(ref, { idempotencyKey: waitId })
 *     return { correlationId: waitId }
 *   },
 *   timeoutMs: 3_600_000,
 * })
 * ```
 * @see docs/specs/11-interaction.md#42-external-waits
 */
export function externalTool<INPUT, OUTPUT = unknown>(
  def: ExternalToolDef<INPUT, OUTPUT>,
): Tool<INPUT, OUTPUT> {
  const base = tool({
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
    ...(def.metadata === undefined ? {} : { metadata: { ...def.metadata } }),
  } as never) as Tool<INPUT, OUTPUT>
  const meta: ExternalToolMeta = {}
  if (def.start !== undefined) meta.start = def.start as ExternalToolMeta['start'] as never
  if (def.timeoutMs !== undefined) meta.timeoutMs = def.timeoutMs
  if (def.onTimeout !== undefined) meta.onTimeout = def.onTimeout as WaitTimeoutResult
  return Object.assign(base, { [EXTERNAL_TOOL]: meta }) as Tool<INPUT, OUTPUT>
}

/** The harness-side definition of an external tool, or `undefined` for any other tool. */
export function externalOf(tool: unknown): ExternalToolMeta | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  return (tool as { [EXTERNAL_TOOL]?: ExternalToolMeta })[EXTERNAL_TOOL]
}
