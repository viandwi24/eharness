/**
 * The manual step loop (ADR-0002): one `streamText` call per step, chunks copied with
 * `for await … writer.write`, wire accumulation from guarded `responseMessages`, step barrier,
 * hooks, stop rules and step-boundary input delivery (internal).
 *
 * @see docs/architecture.md#34-step-inside-the-loop
 * @see docs/specs/05-session-and-storage.md#31-continue-vs-stop-after-a-step-normative
 */
import {
  DownloadError,
  type FinishReason,
  type InferToolOutput,
  InvalidToolInputError,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  NoSuchToolError,
  type StepResult,
  streamText,
  type ToolChoice,
  type ToolSet,
  type toolSearch,
  toUIMessageStream,
  type UIMessageChunk,
} from 'ai'
import type { BudgetConfig, CacheConfig, ModelSettings, ProgressConfig } from '../agent/types.ts'
import type { TurnCompaction } from '../compaction/turn-context.ts'
import { HarnessToolError } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import { FILE_UNAVAILABLE, MAX_STEPS_WRAP_UP, PROGRESS_NUDGE } from '../messages/texts.ts'
import type { PendingState, StopReason } from '../messages/types.ts'
import { costOf } from '../models/cost.ts'
import type { ModelCatalog } from '../models/types.ts'
import type { StepEndEvent, StepPreparePatch, TurnInfo } from '../plugin/types.ts'
import { riskOf } from '../registry/risk.ts'
import type { TurnRegistry } from '../registry/turn.ts'
import { hookFailed } from '../registry/wrap.ts'
import type { PendingInput, TurnInputQueue } from '../session/interaction/inbox.ts'
import { inputWireMessage } from '../session/interaction/inbox.ts'
import type { SessionRuntime } from '../session/runtime.ts'
import { describeError } from '../stream/describe-error.ts'
import { createProgressTracker, DEFAULT_PROGRESS, type StuckReason } from './progress.ts'
import { applyCache, deepMerge, layoutMessages, systemBlocks } from './prompt.ts'
import { decideStop, findPending } from './stop.ts'

/** Token usage of a turn, including `addUsage()` contributions. */
export interface UsageTotals {
  input: number
  output: number
  total: number
  reasoning: number
  cacheRead: number | undefined
  cacheWrite: number | undefined
  nestedInput: number
  nestedOutput: number
  nestedTotal: number
  /** Estimated USD of the priced contributions; `undefined` until one was priced. */
  costUsd: number | undefined
  /** Some contribution had no known price. */
  unpriced: boolean
}

/** Empty usage totals. */
export function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    total: 0,
    reasoning: 0,
    cacheRead: undefined,
    cacheWrite: undefined,
    nestedInput: 0,
    nestedOutput: 0,
    nestedTotal: 0,
    costUsd: undefined,
    unpriced: false,
  }
}

/** Add AI SDK usage to totals (`nested` for `addUsage()`); `costUsd` undefined = unpriced. */
export function addUsage(
  totals: UsageTotals,
  usage: LanguageModelUsage,
  nested = false,
  costUsd?: number,
): void {
  if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) {
    totals.costUsd = (totals.costUsd ?? 0) + costUsd
  } else {
    totals.unpriced = true
  }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const total = usage.totalTokens ?? input + output
  if (nested) {
    totals.nestedInput += input
    totals.nestedOutput += output
    totals.nestedTotal += total
    return
  }
  totals.input += input
  totals.output += output
  totals.total += total
  totals.reasoning += usage.outputTokenDetails?.reasoningTokens ?? 0
  const read = usage.inputTokenDetails?.cacheReadTokens
  const write = usage.inputTokenDetails?.cacheWriteTokens
  if (read !== undefined) totals.cacheRead = (totals.cacheRead ?? 0) + read
  if (write !== undefined) totals.cacheWrite = (totals.cacheWrite ?? 0) + write
}

/** Input of {@link runSteps}. */
export interface StepLoopInput {
  rt: SessionRuntime
  registry: TurnRegistry
  info: TurnInfo
  /** The model wire of the turn; responses are appended. */
  wire: ModelMessage[]
  /** Wire index of the current turn's first message (turn reminder position). */
  turnStart: number
  /** Assistant message id of the turn. */
  messageId: string
  activeTools: string[] | undefined
  maxSteps: number
  /** Absolute cap on `turn.beforeEnd` continuations (`Infinity` = none). */
  maxContinues: number
  /** Continuations in a row without progress before further ones are refused. */
  maxIdleContinues: number
  maxOutputTokens: number
  /** Run a tool-less summary step when the step budget runs out. */
  wrapUp: boolean
  /** Stuck detection; `false` disables it (progress is still measured for continuations). */
  progress: ProgressConfig | false | undefined
  /** Model limits and prices (spec 12). */
  models?: ModelCatalog | undefined
  /** USD budgets (spec 12 §4). */
  budget?: BudgetConfig | undefined
  /** USD spent by the session's earlier turns (`state.core.usage.costUsd`). */
  sessionCostBefore?: number
  toolsContext: Record<string, unknown> | undefined
  cache: CacheConfig | false | undefined
  signal: AbortSignal
  /** True when the turn was aborted by `loop.turnTimeoutMs`. */
  timedOut(): boolean
  write(chunk: UIMessageChunk): void
  /** Resolves when `onStepEnd` has run for every `finish-step` written so far. */
  barrier(): Promise<void>
  usage: UsageTotals
  discovered: Set<string>
  /** Heartbeat and cross-process abort poll (spec 05 §9, §9.1); an abort ends the turn below. */
  heartbeat(): Promise<void>
  /** Compaction triggers, guard, calibration and overflow recovery of the turn (spec 06). */
  compaction: TurnCompaction
  /**
   * The turn continues a pending message (`respond()`): step 0 must end with the approval `tool`
   * message — no step reminder, no input delivery, no rewrite that moves it (spec 11 §4 step 5).
   */
  continuation?: boolean
  /** Steers and `next-step` injections waiting for the next step boundary (spec 11 §6). */
  inbox?: TurnInputQueue
  /** Called after an inbox item was written as `data-eh.input` (and appended to the wire). */
  delivered?(item: PendingInput): void
}

/** Outcome of the step loop. */
export interface LoopResult {
  stop: StopReason
  error?: { code?: string; message: string }
  pending?: PendingState
  steps: number
  /** Model of the last step. */
  model: LanguageModel
  /** Reason of the terminal `abort` chunk (aborted / timeout). */
  abortReason?: string
}

type StepCallSettings = Record<string, unknown>

function callSettings(settings: ModelSettings): StepCallSettings {
  const { timeout, providerOptions: _p, ...rest } = settings
  const out: StepCallSettings = {}
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) out[key] = value
  if (timeout !== undefined)
    out.timeout = typeof timeout === 'number' ? { stepMs: timeout } : timeout
  return out
}

function mergeSettings(
  base: ModelSettings,
  patch: Partial<ModelSettings> | undefined,
): ModelSettings {
  if (patch === undefined) return base
  const providerOptions = deepMerge(base.providerOptions, patch.providerOptions)
  const merged: ModelSettings = { ...base, ...patch }
  if (providerOptions === undefined) delete merged.providerOptions
  else merged.providerOptions = providerOptions
  return merged
}

export { mergeSettings }

/** Output of AI SDK's `toolSearch()` tool: `{ tools: [{ name, description? }] }`. */
type ToolSearchOutput = InferToolOutput<ReturnType<typeof toolSearch>>

function isToolSearchOutput(value: unknown): value is ToolSearchOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { tools?: unknown }).tools)
  )
}

/**
 * Names of tools found by `tool_search` in a tool output: the raw {@link ToolSearchOutput}, or a
 * model tool result output (`{ type: 'json', value }`) wrapping it. Stored data is untrusted, so
 * the shape is checked at runtime.
 */
export function toolSearchNames(output: unknown): string[] {
  const value =
    typeof output === 'object' && output !== null && 'type' in output && 'value' in output
      ? output.value
      : output
  if (!isToolSearchOutput(value)) return []
  return value.tools
    .map((t: unknown) => (t as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string')
}

function collectDiscovered(response: readonly ModelMessage[], into: Set<string>): void {
  for (const message of response) {
    if (message.role !== 'tool' && message.role !== 'assistant') continue
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === 'tool_search') {
        for (const name of toolSearchNames(part.output)) into.add(name)
      }
    }
  }
}

/**
 * The `step.end` event (exported for tests). Derived from the step's `StepResult`; when AI SDK
 * did not provide one (`step` undefined while `responseMessages` resolved), from the wire.
 */
export function stepEndEvent(
  stepIndex: number,
  finishReason: FinishReason,
  usage: LanguageModelUsage,
  totalUsage: LanguageModelUsage,
  response: readonly ModelMessage[],
  step: StepResult<ToolSet> | undefined,
): StepEndEvent {
  const toolCalls: StepEndEvent['toolCalls'] =
    step === undefined
      ? responseToolCalls(response)
      : step.toolCalls.map((call) => ({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
        }))
  // results of this step's calls, in call order (step.content lists them in completion order)
  const statuses = new Map<string, StepEndEvent['toolResults'][number]>()
  for (const part of step?.content ?? []) {
    if (part.type === 'tool-result' || part.type === 'tool-error') {
      statuses.set(part.toolCallId, {
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        status: part.type === 'tool-error' ? 'error' : 'output',
      })
    } else if (part.type === 'tool-approval-response' && !part.approved) {
      statuses.set(part.toolCall.toolCallId, {
        toolName: part.toolCall.toolName,
        toolCallId: part.toolCall.toolCallId,
        status: 'denied',
      })
    }
  }
  const toolResults: StepEndEvent['toolResults'] = [
    ...continuationResults(response, statuses),
    ...toolCalls.flatMap((call) => statuses.get(call.toolCallId) ?? []),
  ]
  const listed = new Set(toolResults.map((r) => r.toolCallId))
  for (const [id, result] of statuses) if (!listed.has(id)) toolResults.push(result)
  return {
    stepIndex,
    finishReason,
    usage,
    totalUsage,
    toolCalls,
    toolResults,
    responseMessages: [...response],
    ...(step === undefined ? {} : { step }),
  }
}

/** Tool calls on the wire of a step (fallback without a `StepResult`). */
function responseToolCalls(response: readonly ModelMessage[]): StepEndEvent['toolCalls'] {
  const out: StepEndEvent['toolCalls'] = []
  for (const message of response) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        out.push({ toolName: part.toolName, toolCallId: part.toolCallId, input: part.input })
      }
    }
  }
  return out
}

/** Assistant text on the wire of a step (fallback without a `StepResult`). */
function responseText(response: readonly ModelMessage[]): string {
  const texts: string[] = []
  for (const message of response) {
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') texts.push(message.content)
    else for (const part of message.content) if (part.type === 'text') texts.push(part.text)
  }
  return texts.join('')
}

/**
 * Results that are on the wire of this step but not in its `StepResult`: approved or denied tool
 * calls of a `respond()` continuation, executed by AI SDK before the model call (spec 11) — or
 * every result when there is no `StepResult`.
 */
function continuationResults(
  response: readonly ModelMessage[],
  own: ReadonlyMap<string, unknown>,
): StepEndEvent['toolResults'] {
  const out: StepEndEvent['toolResults'] = []
  for (const message of response) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || own.has(part.toolCallId)) continue
      const type = part.output.type
      out.push({
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        status:
          type === 'execution-denied'
            ? 'denied'
            : type === 'error-text' || type === 'error-json'
              ? 'error'
              : 'output',
      })
    }
  }
  return out
}

function totalUsageOf(totals: UsageTotals): LanguageModelUsage {
  return {
    inputTokens: totals.input + totals.nestedInput,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: totals.cacheRead,
      cacheWriteTokens: totals.cacheWrite,
    },
    outputTokens: totals.output + totals.nestedOutput,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: totals.reasoning },
    totalTokens: totals.total + totals.nestedTotal,
  }
}

/**
 * Errors AI SDK answers a tool call with (`error-text` = `String(error)` on the wire): a tool's
 * `execute` threw (`HarnessToolError`), the input failed the tool's schema
 * (`InvalidToolInputError`) or the tool does not exist (`NoSuchToolError`).
 */
function isToolCallError(error: unknown): boolean {
  return (
    error instanceof HarnessToolError ||
    InvalidToolInputError.isInstance(error) ||
    NoSuchToolError.isInstance(error)
  )
}

async function guarded<T>(value: PromiseLike<T>): Promise<T | undefined> {
  try {
    return await value
  } catch {
    return undefined
  }
}

/** Run steps until a stop rule matches. Never throws for model or tool failures. */
export async function runSteps(input: StepLoopInput): Promise<LoopResult> {
  const { rt, registry, info, wire, compaction } = input
  const open = rt.open
  if (open === undefined) throw new Error('eharness: session is not open')
  const hooks = open.hooks
  const contextOf = rt.contextOf

  let budget = input.maxSteps
  let continues = 0
  /** Continuations in a row after which no new successful tool result appeared. */
  let idleContinues = 0
  /** `progress.novel` when the last continuation was granted. */
  let novelAtContinue: number | undefined
  const progress = createProgressTracker(input.progress === false ? {} : input.progress)
  const maxNudges =
    input.progress === false ? 0 : (input.progress?.nudges ?? DEFAULT_PROGRESS.nudges)
  let nudges = 0
  /** Reminder of the next step after a nudge. */
  let nudge: string | undefined
  /** The next step is the wrap-up step (tools off) after the step budget ran out. */
  let wrapping = false
  let wrapped = false
  const budgetWarned = new Set<string>()
  /** The budget that is used up, checking the warn threshold on the way (spec 12 §4). */
  const overBudget = (): 'turn' | 'session' | undefined => {
    const budget = input.budget
    if (budget === undefined) return undefined
    const turn = input.usage.costUsd ?? 0
    const checks: Array<['turn' | 'session', number | undefined, number]> = [
      ['turn', budget.maxTurnUsd, turn],
      ['session', budget.maxSessionUsd, (input.sessionCostBefore ?? 0) + turn],
    ]
    let over: 'turn' | 'session' | undefined
    for (const [scope, limit, spent] of checks) {
      if (limit === undefined || !(limit >= 0)) continue
      const exceeded = spent >= limit
      const warnAt = budget.warnAt ?? 0.8
      const key = `${scope}:${exceeded ? 'exceeded' : 'warn'}`
      if ((exceeded || spent >= limit * warnAt) && !budgetWarned.has(key)) {
        budgetWarned.add(key)
        rt.warn(
          {
            code: 'W_BUDGET',
            message: exceeded
              ? `The ${scope} budget of $${limit} is used up ($${spent.toFixed(4)}); the turn stops.`
              : `The ${scope} budget of $${limit} is ${Math.round((spent / limit) * 100)}% used.`,
            details: { scope, limitUsd: limit, spentUsd: spent, exceeded },
          },
          `${info.id}:${key}`,
        )
      }
      if (exceeded && over === undefined) over = scope
    }
    return over
  }
  let stepIndex = 0
  let model: LanguageModel = info.model
  /** Input waiting for the next step boundary (`step.end` context, `turn.beforeEnd` continue). */
  let waiting: Array<{ source: `plugin:${string}`; text: string }> = []
  let lastPrefix: string | undefined
  let cacheBustWarned = false
  /** Wire index of the current turn's first message (moves when a compaction rebuilds the wire). */
  let turnStart = input.turnStart
  /** Wire length after the last step barrier: later messages are not in the cached view yet. */
  let sinceBarrier = wire.length

  /** Steers / injections taken from the inbox and not delivered yet. */
  let external: PendingInput[] = []
  const inbox = input.inbox
  /** No step reminder, input delivery or moving rewrite before the first call of a continuation. */
  const firstOfContinuation = () => input.continuation === true && stepIndex === 0

  const aborted = (): LoopResult => {
    if (external.length > 0) input.inbox?.unshift(external)
    external = []
    return {
      stop: input.timedOut() ? 'timeout' : 'aborted',
      steps: stepIndex,
      model,
      abortReason: input.timedOut() ? 'timeout' : abortReasonText(input.signal),
    }
  }

  while (true) {
    if (input.signal.aborted) return aborted()
    // a session budget used up by earlier turns stops the turn before any model call
    if (stepIndex === 0 && overBudget() !== undefined) return { stop: 'cost-cap', steps: 0, model }

    // step boundary: deliver waiting input as data-eh.input (ADR-0011): steers and next-step
    // injections first (arrival order), then hook context. The wrap-up step takes no input:
    // what waits follows the "any other stop" rule (a queued turn, spec 05 §3.1 / 11 §6.1)
    if (!firstOfContinuation() && !wrapping) {
      if (inbox !== undefined) external.push(...(await inbox.take()))
      for (const item of external) {
        input.write({ type: 'data-eh.input', data: structuredClone(item.data) })
        wire.push(...(await inputWireMessage(item.data)))
        input.delivered?.(item)
      }
      external = []
    }
    for (const item of waiting) {
      input.write({ type: 'data-eh.input', data: { source: item.source, text: item.text } })
      wire.push({ role: 'user', content: [{ type: 'text', text: item.text }] })
    }
    waiting = []

    // mid-turn compaction (spec 06 §4): rebuild the wire from the compacted view
    if (stepIndex >= 1) {
      const delivered = wire.slice(sinceBarrier)
      const costBefore = input.usage.costUsd
      const rebuilt = await compaction.midTurn({ wire, stepIndex, delivered })
      if (rebuilt !== undefined) {
        wire.splice(0, wire.length, ...rebuilt.wire)
        turnStart = rebuilt.turnStart
        sinceBarrier = wire.length - delivered.length
      }
      if (input.signal.aborted) return aborted()
      // the summarizer's usage may have used up a budget: no further model call (spec 12 §4)
      if (input.usage.costUsd !== costBefore && overBudget() !== undefined) {
        return { stop: 'cost-cap', steps: stepIndex, model }
      }
    }

    // guard step 1: sanitize (spec 06 §6)
    const sanitized = compaction.sanitize(wire, turnStart)
    const requestWire = sanitized.flat

    // step.prepare (chainable)
    let stepModel: LanguageModel = info.model
    let settings: ModelSettings = info.settings
    let activeTools = input.activeTools
    let toolChoice: ToolChoice<ToolSet> | undefined
    const reminders: string[] = []
    if (nudge !== undefined) reminders.push(nudge)
    nudge = undefined
    if (wrapping) {
      reminders.push(MAX_STEPS_WRAP_UP)
      toolChoice = 'none'
    }
    let providerOptions = settings.providerOptions
    let rewrite: ModelMessage[] | undefined
    const approvalMessage = firstOfContinuation() ? JSON.stringify(requestWire.at(-1)) : undefined
    for (const hook of hooks.list('step.prepare')) {
      let patch: StepPreparePatch | undefined
      try {
        patch =
          (await hook.fn(contextOf(hook.owner), {
            stepIndex,
            messages: rewrite ?? requestWire,
            toolNames: Object.keys(registry.tools),
            model: stepModel,
          })) ?? undefined
      } catch (error) {
        hookFailed(rt, 'step.prepare', hook.owner, error)
        continue
      }
      if (patch === undefined) continue
      if (patch.model !== undefined) stepModel = patch.model
      if (patch.settings !== undefined) settings = mergeSettings(settings, patch.settings)
      if (patch.activeTools !== undefined) {
        const allowed = new Set(patch.activeTools)
        activeTools =
          activeTools === undefined
            ? [...patch.activeTools]
            : activeTools.filter((n) => allowed.has(n))
      }
      if (patch.toolChoice !== undefined) toolChoice = patch.toolChoice as ToolChoice<ToolSet>
      if (typeof patch.reminder === 'string' && patch.reminder.length > 0) {
        reminders.push(patch.reminder)
      }
      if (patch.providerOptions !== undefined) {
        providerOptions = deepMerge(providerOptions, patch.providerOptions)
      }
      if (patch.messages !== undefined) {
        if (
          approvalMessage !== undefined &&
          JSON.stringify(patch.messages.at(-1)) !== approvalMessage
        ) {
          hookFailed(
            rt,
            'step.prepare',
            hook.owner,
            new Error(
              'a `messages` rewrite of the first step of a respond() continuation must end with the approval tool message; rewrite ignored',
            ),
          )
        } else {
          rewrite = patch.messages
        }
      }
    }
    providerOptions = deepMerge(settings.providerOptions, providerOptions)
    if (wrapping) toolChoice = 'none' // a step.prepare toolChoice cannot re-enable tools
    model = stepModel
    if (input.signal.aborted) return aborted()

    const tools = registry.toolsForStep(input.discovered)
    const toolNames = Object.keys(tools).filter(
      (n) => activeTools === undefined || activeTools.includes(n),
    )
    const stepReminder =
      reminders.length > 0 && !firstOfContinuation() ? reminders.join('\n\n') : undefined

    // guard step 2: hard cap (drop old turns, truncate tool outputs, or stop) for the step model
    // a step.prepare `messages` rewrite replaces the wire; reminders are inserted afterwards
    const capped = await compaction.hardCap({
      wire: sanitized,
      rewrite: rewrite === undefined ? undefined : sanitizeModelMessages(rewrite),
      model: stepModel,
      maxOutputTokens: settings.maxOutputTokens,
      tools: Object.fromEntries(toolNames.map((n) => [n, tools[n] as ToolSet[string]])),
      reminder: stepReminder,
    })
    if ('overflow' in capped) {
      input.write({ type: 'error', errorText: capped.overflow })
      return {
        stop: 'error',
        error: { code: 'EH_CONTEXT_OVERFLOW', message: capped.overflow },
        steps: stepIndex,
        model,
      }
    }

    // prompt layout: system blocks + reminders (spec 02 §5)
    const layout = layoutMessages(
      capped.messages,
      capped.turnStart,
      registry.turnReminder,
      stepReminder,
    )
    const system = systemBlocks(registry.block1, registry.block2)
    const prefix = `${JSON.stringify(system)}\u0000${toolNames.join(',')}`
    if (lastPrefix !== undefined && prefix !== lastPrefix && !cacheBustWarned) {
      cacheBustWarned = true
      rt.warn(
        {
          code: 'W_CACHE_BUST',
          message:
            'The cached prompt prefix changed within the session (instructions or active tools changed).',
          details: { stepIndex },
        },
        `${info.id}`,
      )
    }
    lastPrefix = prefix

    const cached = applyCache({
      config: input.cache,
      model: stepModel,
      prompt: { system, messages: layout.messages, tools, providerOptions },
      lastStable: layout.lastStable,
      lastStaticTool:
        registry.staticCount > 0 ? registry.entries[registry.staticCount - 1]?.name : undefined,
    })

    // the step
    const turnState = rt.turn
    if (turnState !== undefined) turnState.step = { index: stepIndex, model: stepModel }
    input.write({
      type: 'data-eh.status',
      data: { state: 'thinking', step: stepIndex },
      transient: true,
    })
    let sawError = false
    let errorText: string | undefined
    let stepAborted = false
    let stepStarted = false
    /** An error chunk before the step's first start-step, held back for overflow recovery. */
    let held: UIMessageChunk | undefined
    let rawError: unknown
    const toolErrorTexts = new Set<string>()
    const result = streamText({
      model: stepModel,
      ...(cached.system.length > 0 ? { instructions: cached.system } : {}),
      messages: cached.messages,
      tools: cached.tools,
      toolOrder: registry.toolOrder,
      ...(activeTools === undefined ? {} : { activeTools }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
      stopWhen: isStepCount(1),
      abortSignal: input.signal,
      ...(cached.providerOptions === undefined ? {} : { providerOptions: cached.providerOptions }),
      ...(registry.approval === undefined ? {} : { toolApproval: registry.approval }),
      ...(rt.agent.config.approval?.secret === undefined
        ? {}
        : { experimental_toolApprovalSecret: rt.agent.config.approval.secret }),
      ...(registry.refine === undefined ? {} : { experimental_refineToolInput: registry.refine }),
      ...(rt.agent.config.repairToolCall === undefined
        ? {}
        : { repairToolCall: rt.agent.config.repairToolCall }),
      ...(rt.agent.config.telemetry === undefined ? {} : { telemetry: rt.agent.config.telemetry }),
      ...(input.toolsContext === undefined ? {} : { toolsContext: input.toolsContext as never }),
      onError: ({ error }: { error: unknown }) => {
        rawError ??= error
        rt.log.debug('eharness: step error', { error })
      },
      ...callSettings(settings),
    } as Parameters<typeof streamText>[0])

    const ui = toUIMessageStream({
      stream: result.stream,
      tools: cached.tools,
      sendStart: false,
      sendFinish: false,
      onError: (error: unknown) => {
        // tool call errors: the text the wire got (spec 04 §8). For invalid/unknown tool calls AI
        // SDK reports the error object (tool-input-error), then its text (tool-output-error).
        if (isToolCallError(error)) {
          const text = String(error)
          toolErrorTexts.add(text)
          return text
        }
        if (typeof error === 'string' && toolErrorTexts.has(error)) return error
        rawError ??= error
        return describeError(error, (m, d) => rt.log.error(m, d))
      },
    })
    for await (const chunk of ui) {
      if (chunk.type === 'abort') {
        stepAborted = true
        continue // the core writes the single terminal abort
      }
      if (chunk.type === 'start-step') stepStarted = true
      if (chunk.type === 'error') {
        if (!stepStarted && held === undefined) {
          held = chunk as UIMessageChunk // decided after the stream (spec 06 §7)
          continue
        }
        sawError = true
        errorText ??= chunk.errorText
      }
      input.write(chunk as UIMessageChunk)
    }
    const response = await guarded(result.responseMessages)
    if (held !== undefined) {
      const heldText = (held as { errorText?: string }).errorText ?? 'The model call failed.'
      // a file of an earlier turn could not be downloaded (an expired link): degrade it to a
      // FILE_UNAVAILABLE text on the wire and retry the step; each retry removes one URL, so this
      // ends. A file of the current turn stays an error (spec 05 §3).
      if (
        !stepStarted &&
        !stepAborted &&
        !input.signal.aborted &&
        DownloadError.isInstance(rawError) &&
        degradeFile(wire, turnStart, rawError.url)
      ) {
        if (turnState !== undefined) turnState.step = undefined
        continue
      }
      if (
        !stepStarted &&
        !stepAborted &&
        !input.signal.aborted &&
        compaction.isOverflow(rawError)
      ) {
        const costBefore = input.usage.costUsd
        const decision = await compaction.onOverflow({
          error: rawError,
          raw: capped.raw,
          delivered: wire.slice(sinceBarrier),
        })
        if (input.signal.aborted) return aborted()
        if (input.usage.costUsd !== costBefore && overBudget() !== undefined) {
          if (turnState !== undefined) turnState.step = undefined
          return { stop: 'cost-cap', steps: stepIndex, model }
        }
        if (decision.retry) {
          if (decision.rebuilt !== undefined) {
            const delivered = wire.slice(sinceBarrier)
            wire.splice(0, wire.length, ...decision.rebuilt.wire)
            turnStart = decision.rebuilt.turnStart
            sinceBarrier = wire.length - delivered.length
          }
          if (turnState !== undefined) turnState.step = undefined
          continue // the held-back error chunk is discarded; retry the same step
        }
        input.write(held)
        if (turnState !== undefined) turnState.step = undefined
        return {
          stop: 'error',
          error: { code: 'EH_CONTEXT_OVERFLOW', message: heldText },
          steps: stepIndex,
          model,
        }
      }
      input.write(held)
      sawError = true
      errorText ??= heldText
    }
    if (response !== undefined) {
      wire.push(...response)
      collectDiscovered(response, input.discovered)
    }
    await input.barrier()
    sinceBarrier = wire.length
    if (turnState !== undefined) turnState.step = undefined
    stepIndex++

    const finishReason = response === undefined ? undefined : await guarded(result.finishReason)
    const stepUsage = response === undefined ? undefined : await guarded(result.usage)
    // rejects like responseMessages on abort / early provider failure
    const step = response === undefined ? undefined : await guarded(result.finalStep)
    if (stepUsage !== undefined) {
      const cost = costOf(input.models, stepModel, stepUsage)
      if (cost === undefined && input.budget !== undefined) {
        rt.warn(
          {
            code: 'W_MODEL_UNPRICED',
            message: `No pricing for model '${describeModel(stepModel)}' in \`models\`; its usage does not count toward the budget.`,
            details: { model: describeModel(stepModel) },
          },
          `unpriced:${describeModel(stepModel)}`,
        )
      }
      addUsage(input.usage, stepUsage, false, cost)
      compaction.observe(capped.raw, stepUsage.inputTokens)
    }
    const total = totalUsageOf(input.usage)
    input.write({
      type: 'data-eh.usage',
      data: {
        inputTokens: total.inputTokens ?? 0,
        outputTokens: total.outputTokens ?? 0,
        totalTokens: total.totalTokens ?? 0,
        steps: stepIndex,
        ...(input.usage.costUsd === undefined ? {} : { costUsd: input.usage.costUsd }),
      },
      transient: true,
    })
    input.write({
      type: 'data-eh.context',
      data: await compaction.contextStats(stepModel, wire, settings.maxOutputTokens),
      transient: true,
    })
    await input.heartbeat()

    if (stepAborted || input.signal.aborted) {
      if (input.signal.aborted) return aborted()
      // an abort chunk while the turn signal is not aborted: AI SDK step timeout
      return { stop: 'timeout', steps: stepIndex, model, abortReason: 'timeout' }
    }

    // step.end hooks
    let hookStop: string | undefined
    if (finishReason !== undefined && response !== undefined) {
      const event = stepEndEvent(
        stepIndex - 1,
        finishReason,
        stepUsage ?? totalUsage(),
        total,
        response,
        step,
      )
      if (input.usage.costUsd !== undefined) event.costUsd = input.usage.costUsd
      for (const hook of hooks.list('step.end')) {
        try {
          const out = await hook.fn(contextOf(hook.owner), event)
          if (out === undefined || out === null) continue
          if (typeof out.context === 'string' && out.context.length > 0) {
            waiting.push({ source: `plugin:${hook.owner}`, text: out.context })
          }
          if (typeof out.stop === 'string' && hookStop === undefined) {
            hookStop = `plugin:${hook.owner}:${out.stop}`
          }
        } catch (error) {
          hookFailed(rt, 'step.end', hook.owner, error)
        }
      }
    }
    if (input.signal.aborted) return aborted()

    const pending =
      response === undefined || finishReason !== 'tool-calls'
        ? undefined
        : findPending(input.messageId, response, registry.clientTools, (name) =>
            riskOf((registry.tools[name] as { metadata?: unknown } | undefined)?.metadata),
          )
    let stuck: StuckReason | undefined
    if (response !== undefined) {
      const found = progress.observe(response)
      if (found !== undefined && input.progress !== false) stuck = found
    }
    let stop: StopReason | undefined = decideStop({
      finishReason,
      sawError,
      pending,
      hookStop,
      stepCount: stepIndex,
      budget,
      outputTokens: total.outputTokens ?? 0,
      maxOutputTokens: input.maxOutputTokens,
    })
    if (stop === undefined && overBudget() !== undefined) stop = 'cost-cap'
    if (wrapping) {
      // the wrap-up step ends the turn whatever it answered (errors stay errors)
      wrapping = false
      if (stop !== 'error') stop = 'max-steps'
    } else if (stop === undefined && stuck !== undefined) {
      if (nudges < maxNudges) {
        nudges++
        progress.reset()
        nudge = PROGRESS_NUDGE.replace('{what}', describeStuck(stuck))
        rt.warn(
          {
            code: 'W_LOOP_STUCK',
            message: `The turn looks stuck (${describeStuck(stuck)}); the model was reminded.`,
            details: { ...stuck, stepIndex: stepIndex - 1 },
          },
          info.id,
        )
      } else {
        if (external.length > 0) inbox?.unshift(external)
        external = []
        return { stop: 'stuck', steps: stepIndex, model }
      }
    }
    if (stop === undefined) continue

    // pending input wins over 'complete' — but never past the step budget or the cost cap
    if (stop === 'complete' && inbox !== undefined) external.push(...(await inbox.take()))
    if (stop === 'complete' && (waiting.length > 0 || external.length > 0)) {
      if (stepIndex >= budget) stop = 'max-steps'
      else if ((total.outputTokens ?? 0) > input.maxOutputTokens) stop = 'cost-cap'
      else if (overBudget() !== undefined) stop = 'cost-cap'
      else continue
    }
    waiting = []

    const spent = overBudget() !== undefined
    if (!wrapped && !spent && (stop === 'complete' || stop === 'max-steps' || stop === 'length')) {
      const decision = await beforeEnd(stop)
      if (decision === 'continue') continue
    }
    if (stop === 'max-steps' && input.wrapUp && !wrapped && !spent) {
      // one more step without tools: the model summarizes what is done and what is left
      wrapped = true
      wrapping = true
      budget = stepIndex + 1
      continue
    }
    // not delivered: back to the inbox, the turn decides (queued turn or input-dropped)
    if (external.length > 0) inbox?.unshift(external)
    external = []
    if (stop === 'error') {
      return {
        stop,
        error: { message: errorText ?? 'The model call failed.' },
        steps: stepIndex,
        model,
      }
    }
    if (stop === 'tool-pending' && pending !== undefined)
      return { stop, pending, steps: stepIndex, model }
    return { stop, steps: stepIndex, model }

    async function beforeEnd(current: StopReason): Promise<'continue' | 'stop'> {
      const list = hooks.list('turn.beforeEnd')
      if (list.length === 0) return 'stop'
      const lastText = step?.text ?? responseText(response ?? [])
      for (const hook of list) {
        let out: Awaited<ReturnType<typeof hook.fn>>
        try {
          out = await hook.fn(contextOf(hook.owner), {
            stop: current,
            stepIndex: stepIndex - 1,
            continues,
            idleContinues: idleNow(),
            lastText,
          })
        } catch (error) {
          hookFailed(rt, 'turn.beforeEnd', hook.owner, error)
          continue
        }
        if (out === undefined || out === null) continue
        const isContinue = 'continue' in out && typeof out.continue?.reason === 'string'
        const isExtend =
          'extendSteps' in out &&
          typeof out.extendSteps === 'number' &&
          current === 'max-steps' &&
          out.extendSteps > 0
        if (!isContinue && !isExtend) continue // not actionable for this stop: ignored silently
        if (continues >= input.maxContinues) {
          rt.warn(
            {
              code: 'W_CONTINUE_LIMIT',
              message: `turn.beforeEnd asked to continue more than loop.maxContinues (${input.maxContinues}) times; ignored.`,
              details: { owner: hook.owner, continues, reason: 'max' },
            },
            info.id,
          )
          return 'stop'
        }
        const idle = idleNow()
        if (idle >= input.maxIdleContinues) {
          rt.warn(
            {
              code: 'W_CONTINUE_LIMIT',
              message: `turn.beforeEnd asked to continue, but the last ${idle} continuations made no progress (loop.maxIdleContinues); ignored.`,
              details: { owner: hook.owner, continues, idleContinues: idle, reason: 'no-progress' },
            },
            info.id,
          )
          return 'stop'
        }
        idleContinues = idle
        novelAtContinue = progress.novel
        if ('continue' in out && typeof out.continue?.reason === 'string') {
          continues++
          waiting.push({ source: `plugin:${hook.owner}`, text: out.continue.reason })
          if (stepIndex >= budget) budget = stepIndex + 1
          return 'continue'
        }
        if ('extendSteps' in out && typeof out.extendSteps === 'number') {
          continues++
          budget += Math.floor(out.extendSteps)
          return 'continue'
        }
      }
      return 'stop'
    }

    /** Idle continuations in a row, counting the last one when nothing new happened since. */
    function idleNow(): number {
      return novelAtContinue !== undefined && progress.novel === novelAtContinue
        ? idleContinues + 1
        : 0
    }
  }

  function totalUsage(): LanguageModelUsage {
    return totalUsageOf(emptyUsage())
  }
}

/**
 * Replace the file parts of earlier turns (wire before `turnStart`) whose URL is `url` with the
 * `FILE_UNAVAILABLE` text. True when one was replaced.
 */
function degradeFile(wire: ModelMessage[], turnStart: number, url: string): boolean {
  const target = normalizeUrl(url)
  const matches = (part: { type: string; data?: unknown }): boolean =>
    part.type === 'file' && fileUrlOf(part.data) === target
  let replaced = false
  for (let i = 0; i < Math.min(turnStart, wire.length); i++) {
    const message = wire[i] as ModelMessage
    if (message.role !== 'user' || typeof message.content === 'string') continue
    if (!message.content.some(matches)) continue
    replaced = true
    wire[i] = {
      ...message,
      content: message.content.map((part) =>
        part.type === 'file' && matches(part)
          ? {
              type: 'text' as const,
              text: FILE_UNAVAILABLE.replace('{mediaType}', part.mediaType)
                .replace('{filename}', part.filename ?? '')
                .replace(' ]', ']'),
            }
          : part,
      ),
    }
  }
  return replaced
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** The URL of a model file part's `data` (bare string / `URL`, or `{ type: 'url', url }`). */
function fileUrlOf(data: unknown): string | undefined {
  if (data instanceof URL) return data.href
  if (typeof data === 'string')
    return /^[a-z][a-z0-9+.-]*:/i.test(data) ? normalizeUrl(data) : undefined
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'url') {
    return normalizeUrl(String((data as { url?: unknown }).url))
  }
  return undefined
}

function describeStuck(stuck: StuckReason): string {
  return stuck.kind === 'repeat'
    ? `'${stuck.toolName}' was called ${stuck.count} times with the same input and the same result`
    : `the last ${stuck.count} steps' tool calls all failed`
}

function abortReasonText(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === 'string') return reason
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return 'aborted'
}
