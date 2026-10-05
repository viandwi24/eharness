/**
 * The pre-compaction flush (internal, 0.4.0): the `compaction.before` hook chain and the flush
 * turn — one bounded, internal `generateText` call over the current wire with a whitelisted tool
 * set, recorded as a model-invisible `eh.flush` kind message.
 *
 * @see docs/specs/06-compaction.md#52a-flush-040
 * @see docs/decisions/0020-pre-compaction-flush.md
 */
import {
  type GenericToolApprovalFunction,
  generateText,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type Tool,
  type ToolSet,
  type UIMessageChunk,
} from 'ai'
import { describeModel } from '../internal/model.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { project } from '../messages/project.ts'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import type { FlushPayload, HarnessUIMessage } from '../messages/types.ts'
import { costOf } from '../models/cost.ts'
import type { CompactionBeforeEvent, CompactionBeforePatch } from '../plugin/types.ts'
import { riskOf } from '../registry/risk.ts'
import { resolveTurnRegistry, type TurnRegistry } from '../registry/turn.ts'
import { hookFailed, reportDecision } from '../registry/wrap.ts'
import type { OpenSession, SessionRuntime } from '../session/runtime.ts'

/** Default `flush.maxSteps`. */
export const DEFAULT_FLUSH_MAX_STEPS = 3

/** Reason of a tool call that would need approval during a flush (auto-denied, spec 06 §5.2a). */
export const FLUSH_APPROVAL_DENIED = 'Not available during memory flush.'

/** The merged flush request of all `compaction.before` hooks. */
export interface MergedFlush {
  prompt: string
  tools: string[]
  maxSteps: number
  model: LanguageModel | undefined
  /** Plugins whose hook returned a flush. */
  owners: string[]
}

/** What the flush call needs from the caller: the current wire and the turn's tools. */
export interface FlushEnv {
  /** Block 1 + block 2 (the stable prefix). */
  instructions: string | undefined
  /** The current wire (pre-compaction, sanitized). */
  wire: ModelMessage[]
  /** The turn registry (wrapped tools, order, approval, refinement). */
  registry: TurnRegistry
  toolsContext: Record<string, unknown> | undefined
  /** The turn's model (manual: the agent model). */
  model: LanguageModel
  maxOutputTokens: number | undefined
}

/** Inputs of one flush stage. */
export interface FlushStageInput {
  rt: SessionRuntime
  event: CompactionBeforeEvent
  turnId: string | undefined
  /** Default flush model: `compaction.model`. */
  defaultModel: LanguageModel | undefined
  /** Model whose window the compaction applies to (turn model). */
  turnModel: LanguageModel
  /** Calibrated tokens of a text. */
  tokensOf(text: string): number
  window(model: LanguageModel): number
  env: (() => Promise<FlushEnv>) | undefined
  write: ((chunk: UIMessageChunk) => void) | undefined
  signal: AbortSignal | undefined
  onUsage: ((usage: LanguageModelUsage, model: LanguageModel, source: string) => void) | undefined
  persist(messages: HarnessUIMessage[]): Promise<HarnessUIMessage[]>
}

/** Outcome of the flush stage: `aborted` = the turn was aborted during the flush. */
export type FlushOutcome = 'none' | 'skipped' | 'flushed' | 'failed' | 'aborted'

function validPatch(value: unknown): CompactionBeforePatch['flush'] | 'invalid' | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') return 'invalid'
  const flush = (value as CompactionBeforePatch).flush
  if (flush === undefined) return undefined
  if (typeof flush !== 'object' || flush === null) return 'invalid'
  if (typeof flush.prompt !== 'string' || flush.prompt.trim() === '') return 'invalid'
  if (
    flush.tools !== undefined &&
    (!Array.isArray(flush.tools) || flush.tools.some((t) => typeof t !== 'string'))
  ) {
    return 'invalid'
  }
  if (
    flush.maxSteps !== undefined &&
    (typeof flush.maxSteps !== 'number' || !Number.isInteger(flush.maxSteps) || flush.maxSteps < 1)
  ) {
    return 'invalid'
  }
  return flush
}

/**
 * Run the `compaction.before` hooks in plugin order and merge their flush requests: prompts
 * joined with a blank line, tools unioned (first appearance), `maxSteps` = max, `model` = last
 * defined. A throwing hook (or an invalid patch) is `W_HOOK_FAILED` and skipped.
 */
export async function runBeforeHooks(
  rt: SessionRuntime,
  event: CompactionBeforeEvent,
): Promise<MergedFlush | undefined> {
  const hooks = rt.open?.hooks.list('compaction.before') ?? []
  let merged: MergedFlush | undefined
  for (const hook of hooks) {
    let flush: CompactionBeforePatch['flush'] | 'invalid' | undefined
    try {
      const out = await hook.fn(rt.contextOf(hook.owner), {
        messages: structuredClone(event.messages),
        tokens: event.tokens,
        trigger: event.trigger,
      })
      flush = validPatch(out)
      if (flush === 'invalid') {
        throw new Error(
          'returned an invalid patch (flush.prompt must be a non-empty string, flush.tools an array of names, flush.maxSteps a positive integer)',
        )
      }
    } catch (error) {
      hookFailed(rt, 'compaction.before', hook.owner, error)
      continue
    }
    if (flush === undefined) continue
    if (merged === undefined) {
      merged = {
        prompt: flush.prompt,
        tools: [],
        maxSteps: flush.maxSteps ?? DEFAULT_FLUSH_MAX_STEPS,
        model: flush.model,
        owners: [hook.owner],
      }
    } else {
      merged.prompt = `${merged.prompt}\n\n${flush.prompt}`
      merged.maxSteps = Math.max(merged.maxSteps, flush.maxSteps ?? DEFAULT_FLUSH_MAX_STEPS)
      if (flush.model !== undefined) merged.model = flush.model
      merged.owners.push(hook.owner)
    }
    for (const name of flush.tools ?? []) if (!merged.tools.includes(name)) merged.tools.push(name)
  }
  return merged
}

/** The flush tool set: whitelisted, executable tools of the turn in stable order (deferred → loaded). */
function flushTools(registry: TurnRegistry, names: readonly string[]): ToolSet {
  const allowed = new Set(names)
  const out: ToolSet = {}
  for (const name of registry.toolOrder) {
    if (!allowed.has(name) || registry.clientTools.has(name)) continue
    const tool = registry.tools[name] as Tool | undefined
    if (tool === undefined || typeof tool.execute !== 'function') continue
    out[name] = tool.deferLoading === true ? ({ ...tool, deferLoading: false } as Tool) : tool
  }
  return out
}

/**
 * The flush approval: the turn's approval function, with every call that would ask the user
 * (`user-approval`) auto-denied and reported to `approval.decided` (`by: 'policy'`).
 */
function flushApproval(
  rt: SessionRuntime,
  base: TurnRegistry['approval'],
): GenericToolApprovalFunction<ToolSet, never, unknown> {
  return async (options) => {
    const status = base === undefined ? 'not-applicable' : await base(options)
    const type = typeof status === 'object' && status !== null ? status.type : status
    if (type !== 'user-approval') return status
    const { toolCall } = options
    const risk = riskOf((toolCall as { toolMetadata?: unknown }).toolMetadata)
    const hooks = rt.open?.hooks
    if (hooks !== undefined) {
      await reportDecision(
        { hooks, contextOf: rt.contextOf, warn: rt.warn },
        {
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          input: toolCall.input,
          ...(risk === undefined ? {} : { risk }),
          approved: false,
          by: 'policy',
          reason: FLUSH_APPROVAL_DENIED,
        },
      )
    }
    return { type: 'denied', reason: FLUSH_APPROVAL_DENIED }
  }
}

/** Tool call statuses of the flush steps, in call order. */
function toolCallsOf(steps: ReadonlyArray<StepResult<ToolSet>>): FlushPayload['toolCalls'] {
  const out: FlushPayload['toolCalls'] = []
  for (const step of steps) {
    const statuses = new Map<string, FlushPayload['toolCalls'][number]>()
    for (const part of step.content) {
      if (part.type === 'tool-result' || part.type === 'tool-error') {
        statuses.set(part.toolCallId, {
          toolName: part.toolName,
          status: part.type === 'tool-error' ? 'error' : 'output',
        })
      } else if (part.type === 'tool-approval-response' && !part.approved) {
        statuses.set(part.toolCall.toolCallId, {
          toolName: part.toolCall.toolName,
          status: 'denied',
        })
      }
    }
    for (const call of step.toolCalls) {
      const status = statuses.get(call.toolCallId)
      if (status !== undefined) out.push(status)
    }
  }
  return out
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The flush stage of one compaction (spec 06 §5.2a): hooks → checks → flush call → `eh.flush`
 * record. Never throws; a failing flush is `W_HOOK_FAILED` and compaction continues.
 */
export async function runFlushStage(input: FlushStageInput): Promise<FlushOutcome> {
  const { rt } = input
  const aborted = (): boolean => input.signal?.aborted === true
  const merged = await runBeforeHooks(rt, input.event)
  if (merged === undefined) return 'none'
  if (aborted()) return 'aborted'
  const model = merged.model ?? input.defaultModel ?? input.turnModel
  const skip = (message: string, details: Record<string, unknown>): FlushOutcome => {
    rt.warn(
      {
        code: 'W_COMPACTION_FLUSH_SKIPPED',
        message: `The pre-compaction flush was skipped: ${message}`,
        details: { trigger: input.event.trigger, ...details },
      },
      `${input.turnId ?? 'manual'}:flush:${String(details.reason)}`,
    )
    return 'skipped'
  }

  let env: FlushEnv
  try {
    if (input.env === undefined) throw new Error('no flush environment')
    env = await input.env()
  } catch (error) {
    if (aborted()) return 'aborted'
    return failed(input, merged, model, error, { steps: 0, toolCalls: [] })
  }

  // window (spec 06 §5.2a rule 5): the flush must fit; on overflow it needs a larger window
  const window = input.window(model)
  const reserve = env.maxOutputTokens ?? Math.floor(window * 0.08)
  const needed = input.event.tokens + input.tokensOf(merged.prompt) + reserve
  if (input.event.trigger === 'overflow' && window <= input.window(env.model)) {
    return skip(
      'the provider rejected the context as too long and the flush model has no larger window.',
      { reason: 'window', window, tokens: input.event.tokens },
    )
  }
  if (needed > window) {
    return skip(
      `the context (~${input.event.tokens} tokens) does not fit the flush model's window (${window}).`,
      { reason: 'window', window, tokens: input.event.tokens },
    )
  }

  const tools = flushTools(env.registry, merged.tools)
  const toolOrder = env.registry.toolOrder.filter((name) => Object.hasOwn(tools, name))
  const hasTools = toolOrder.length > 0
  const controller = new AbortController()
  const onAbort = () => controller.abort(input.signal?.reason)
  if (aborted()) return 'aborted'
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await generateText({
      model,
      ...(env.instructions === undefined ? {} : { instructions: env.instructions }),
      messages: [...env.wire, { role: 'user', content: merged.prompt }],
      ...(hasTools
        ? {
            tools,
            toolOrder,
            toolApproval: flushApproval(rt, env.registry.approval),
            ...(env.registry.refine === undefined
              ? {}
              : { experimental_refineToolInput: env.registry.refine }),
            ...(env.toolsContext === undefined ? {} : { toolsContext: env.toolsContext }),
          }
        : {}),
      stopWhen: isStepCount(merged.maxSteps),
      abortSignal: controller.signal,
      ...(env.maxOutputTokens === undefined ? {} : { maxOutputTokens: env.maxOutputTokens }),
    } as Parameters<typeof generateText>[0])
    const usage = result.totalUsage
    input.onUsage?.(usage, model, 'compaction-flush')
    if (aborted()) return 'aborted'
    const toolCalls = toolCallsOf(result.steps as ReadonlyArray<StepResult<ToolSet>>)
    await record(input, merged, model, {
      steps: result.steps.length,
      toolCalls,
      usage,
    })
    return 'flushed'
  } catch (error) {
    if (aborted()) return 'aborted'
    return failed(input, merged, model, error, { steps: 0, toolCalls: [] })
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}

async function failed(
  input: FlushStageInput,
  merged: MergedFlush,
  model: LanguageModel,
  error: unknown,
  partial: { steps: number; toolCalls: FlushPayload['toolCalls'] },
): Promise<FlushOutcome> {
  input.rt.warn(
    {
      code: 'W_HOOK_FAILED',
      message: `The pre-compaction flush of ${merged.owners.map((o) => (o === 'app' ? 'the app' : `plugin '${o}'`)).join(', ')} failed and was skipped: ${errorText(error)}`,
      details: { hook: 'compaction.before', owner: merged.owners.join(','), phase: 'flush' },
    },
    `${input.turnId ?? 'manual'}:compaction.before:flush`,
  )
  await record(input, merged, model, { ...partial, error: errorText(error) })
  return 'failed'
}

/** Save the `eh.flush` audit record (before the marker) and deliver it like the marker. */
async function record(
  input: FlushStageInput,
  merged: MergedFlush,
  model: LanguageModel,
  result: {
    steps: number
    toolCalls: FlushPayload['toolCalls']
    usage?: LanguageModelUsage
    error?: string
  },
): Promise<void> {
  const { rt } = input
  const usage = result.usage
  const cost = usage === undefined ? undefined : costOf(rt.agent.config.models, model, usage)
  const payload: FlushPayload = {
    trigger: input.event.trigger,
    prompt: merged.prompt,
    model: describeModel(model),
    steps: result.steps,
    toolCalls: result.toolCalls,
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    },
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
  const message = createKindMessage('eh.flush', payload, {
    id: rt.nextId(),
    createdAt: Date.now(),
    parentId: rt.view?.at(-1)?.id ?? null,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  })
  let saved: HarnessUIMessage
  try {
    saved = (await input.persist([message]))[0] ?? message
  } catch (error) {
    rt.log.warn('eharness: saving the eh.flush record failed', { error })
    return
  }
  const data = (saved.parts[0] as { data?: FlushPayload } | undefined)?.data ?? payload
  input.write?.({ type: 'data-eh.flush', data, transient: true } as UIMessageChunk)
  rt.events.emit({ type: 'message', message: structuredClone(saved) as never })
}

/**
 * The flush environment of a manual `compact()` (no running turn): the registry the next turn
 * would resolve, and the projected view as the wire.
 */
export async function manualFlushEnv(args: {
  rt: SessionRuntime
  open: OpenSession
}): Promise<FlushEnv> {
  const { rt, open } = args
  const config = rt.agent.config
  const registry = await resolveTurnRegistry({
    open,
    approval: config.approval,
    toolOutput: config.toolOutput,
    toolErrorText: config.toolErrorText,
    contextOf: rt.contextOf,
    warn: rt.warn,
    status: () => {},
    grants: { current: () => rt.state.core().grants },
  })
  const wire = await project(rt.view ?? [], {
    registry: rt.agent.messages,
    sessionId: rt.id,
    tools: registry.tools,
    model: config.model,
    pending: rt.state.core().pending ?? null,
  })
  const instructions = [registry.block1, registry.block2]
    .filter((t): t is string => t !== undefined)
    .join('\n\n')
  return {
    instructions: instructions.length === 0 ? undefined : instructions,
    wire: sanitizeModelMessages(wire),
    registry,
    toolsContext: rt.options.toolsContext,
    model: config.model,
    maxOutputTokens: config.settings?.maxOutputTokens,
  }
}
