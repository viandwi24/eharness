/**
 * The manual step loop (ADR-0002): one `streamText` call per step, chunks copied with
 * `for await … writer.write`, wire accumulation from guarded `responseMessages`, step barrier,
 * hooks, stop rules and step-boundary input delivery (internal).
 *
 * @see docs/architecture.md#34-step-inside-the-loop
 * @see docs/specs/05-session-and-storage.md#31-continue-vs-stop-after-a-step-normative
 */
import {
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
import type { CacheConfig, ModelSettings } from '../agent/types.ts'
import type { TurnCompaction } from '../compaction/turn-context.ts'
import { HarnessToolError } from '../errors.ts'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import type { PendingState, StopReason } from '../messages/types.ts'
import type { StepEndEvent, StepPreparePatch, TurnInfo } from '../plugin/types.ts'
import type { TurnRegistry } from '../registry/turn.ts'
import { hookFailed } from '../registry/wrap.ts'
import type { InboxItem, TurnInbox } from '../session/interaction/inbox.ts'
import { inputWireMessage } from '../session/interaction/inbox.ts'
import type { SessionRuntime } from '../session/runtime.ts'
import { describeError } from '../stream/describe-error.ts'
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
  }
}

/** Add AI SDK usage to totals (`nested` for `addUsage()`). */
export function addUsage(totals: UsageTotals, usage: LanguageModelUsage, nested = false): void {
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
  maxContinues: number
  maxOutputTokens: number
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
  heartbeat(): Promise<void>
  /** Compaction triggers, guard, calibration and overflow recovery of the turn (spec 06). */
  compaction: TurnCompaction
  /**
   * The turn continues a pending message (`respond()`): step 0 must end with the approval `tool`
   * message — no step reminder, no input delivery, no rewrite that moves it (spec 11 §4 step 5).
   */
  continuation?: boolean
  /** Steers and `next-step` injections waiting for the next step boundary (spec 11 §6). */
  inbox?: TurnInbox
  /** Called after an inbox item was written as `data-eh.input` (and appended to the wire). */
  delivered?(item: InboxItem): void
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

function stepEndEvent(
  stepIndex: number,
  finishReason: FinishReason,
  usage: LanguageModelUsage,
  totalUsage: LanguageModelUsage,
  response: readonly ModelMessage[],
  step: StepResult<ToolSet>,
): StepEndEvent {
  const toolCalls: StepEndEvent['toolCalls'] = step.toolCalls.map((call) => ({
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
  }))
  // results of this step's calls, in call order (step.content lists them in completion order)
  const statuses = new Map<string, StepEndEvent['toolResults'][number]>()
  for (const part of step.content) {
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
    step,
  }
}

/**
 * Results that are on the wire of this step but not in its `StepResult`: approved or denied tool
 * calls of a `respond()` continuation, executed by AI SDK before the model call (spec 11).
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
  let external: InboxItem[] = []
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

    // step boundary: deliver waiting input as data-eh.input (ADR-0011): steers and next-step
    // injections first (arrival order), then hook context
    if (!firstOfContinuation()) {
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
      const rebuilt = await compaction.midTurn({ wire, stepIndex, delivered })
      if (rebuilt !== undefined) {
        wire.splice(0, wire.length, ...rebuilt.wire)
        turnStart = rebuilt.turnStart
        sinceBarrier = wire.length - delivered.length
      }
      if (input.signal.aborted) return aborted()
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
      if (
        !stepStarted &&
        !stepAborted &&
        !input.signal.aborted &&
        compaction.isOverflow(rawError)
      ) {
        const decision = await compaction.onOverflow({
          error: rawError,
          raw: capped.raw,
          delivered: wire.slice(sinceBarrier),
        })
        if (input.signal.aborted) return aborted()
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
      addUsage(input.usage, stepUsage)
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
    if (finishReason !== undefined && response !== undefined && step !== undefined) {
      const event = stepEndEvent(
        stepIndex - 1,
        finishReason,
        stepUsage ?? totalUsage(),
        total,
        response,
        step,
      )
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
        : findPending(input.messageId, response, registry.clientTools)
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
    if (stop === undefined) continue

    // pending input wins over 'complete' — but never past the step budget or the cost cap
    if (stop === 'complete' && inbox !== undefined) external.push(...(await inbox.take()))
    if (stop === 'complete' && (waiting.length > 0 || external.length > 0)) {
      if (stepIndex >= budget) stop = 'max-steps'
      else if ((total.outputTokens ?? 0) > input.maxOutputTokens) stop = 'cost-cap'
      else continue
    }
    waiting = []

    if (stop === 'complete' || stop === 'max-steps' || stop === 'length') {
      const decision = await beforeEnd(stop)
      if (decision === 'continue') continue
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
      const lastText = step?.text ?? ''
      for (const hook of list) {
        let out: Awaited<ReturnType<typeof hook.fn>>
        try {
          out = await hook.fn(contextOf(hook.owner), {
            stop: current,
            stepIndex: stepIndex - 1,
            continues,
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
              details: { owner: hook.owner, continues },
            },
            info.id,
          )
          return 'stop'
        }
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
  }

  function totalUsage(): LanguageModelUsage {
    return totalUsageOf(emptyUsage())
  }
}

function abortReasonText(signal: AbortSignal): string {
  const reason = signal.reason
  if (typeof reason === 'string') return reason
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return 'aborted'
}
