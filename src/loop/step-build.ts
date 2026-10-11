/**
 * The request of one step (internal): `step.prepare` hooks, hard cap, prompt layout, cache markers
 * and the budget ledger reservation.
 */
import type { LanguageModel, ModelMessage, ToolChoice, ToolSet } from 'ai'
import type { ModelSettings } from '../agent/types.ts'
import { hookFailed } from '../internal/hook-run.ts'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import { MAX_STEPS_WRAP_UP } from '../messages/texts.ts'
import type { StepPreparePatch } from '../plugin/types.ts'
import { applyCache, deepMerge, layoutMessages, systemBlocks } from './prompt.ts'
import type { LoopResult, StepRequest, StepsCtx } from './step-ctx.ts'
import { aborted, firstOfContinuation, runBounded } from './step-guards.ts'
import { mergeSettings } from './step-settings.ts'

/**
 * Prepare the model call of the next step. A `LoopResult` means the turn ends here (abort, context
 * overflow, cost cap, ledger refusal).
 */
export async function buildStep(st: StepsCtx): Promise<StepRequest | LoopResult> {
  // guard step 1: sanitize (spec 06 §6)
  const sanitized = st.compaction.sanitize(st.wire, st.turnStart)
  const requestWire = sanitized.flat

  // step.prepare (chainable)
  let stepModel: LanguageModel = st.info.model
  let settings: ModelSettings = st.info.settings
  let activeTools = st.input.activeTools
  let toolChoice: ToolChoice<ToolSet> | undefined
  const reminders: string[] = []
  if (st.nudge !== undefined) reminders.push(st.nudge)
  st.nudge = undefined
  if (st.wrapping) {
    reminders.push(MAX_STEPS_WRAP_UP)
    toolChoice = 'none'
  }
  let providerOptions = settings.providerOptions
  let rewrite: ModelMessage[] | undefined
  const approvalMessage = firstOfContinuation(st) ? JSON.stringify(requestWire.at(-1)) : undefined
  for (const hook of st.hooks.list('step.prepare')) {
    let patch: StepPreparePatch | undefined
    try {
      patch =
        (await runBounded(st, 'step.prepare', hook.owner, () =>
          hook.fn(st.contextOf(hook.owner), {
            stepIndex: st.stepIndex,
            messages: rewrite ?? requestWire,
            toolNames: Object.keys(st.registry.tools),
            model: stepModel,
            ...(firstOfContinuation(st) && st.input.continuing !== undefined
              ? { continuing: structuredClone(st.input.continuing) }
              : {}),
          }),
        )) ?? undefined
    } catch (error) {
      hookFailed(st.rt, 'step.prepare', hook.owner, error)
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
          st.rt,
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
  // the output tool is always active (tool mode); a retry step must call it (spec 05 §3.3)
  if (st.output?.tool !== undefined && !st.wrapping) {
    if (activeTools !== undefined && !activeTools.includes(st.output.toolName)) {
      activeTools = [...activeTools, st.output.toolName]
    }
    if (st.forceOutputTool) toolChoice = { type: 'tool', toolName: st.output.toolName }
  }
  st.forceOutputTool = false
  if (st.wrapping) toolChoice = 'none' // a step.prepare toolChoice cannot re-enable tools
  st.model = stepModel
  if (st.input.signal.aborted) return aborted(st)

  const tools = st.registry.toolsForStep(st.input.discovered)
  const toolNames = Object.keys(tools).filter(
    (n) => activeTools === undefined || activeTools.includes(n),
  )
  const stepReminder =
    reminders.length > 0 && !firstOfContinuation(st) ? reminders.join('\n\n') : undefined

  // guard step 2: hard cap (drop old turns, truncate tool outputs, or stop) for the step model
  // a step.prepare `messages` rewrite replaces the wire; reminders are inserted afterwards
  const capped = await st.compaction.hardCap({
    wire: sanitized,
    rewrite: rewrite === undefined ? undefined : sanitizeModelMessages(rewrite),
    model: stepModel,
    maxOutputTokens: settings.maxOutputTokens,
    tools: Object.fromEntries(toolNames.map((n) => [n, tools[n] as ToolSet[string]])),
    reminder: stepReminder,
  })
  if ('overflow' in capped) {
    st.input.write({ type: 'error', errorText: capped.overflow })
    return {
      stop: 'error',
      error: { code: 'EH_CONTEXT_OVERFLOW', message: capped.overflow },
      steps: st.stepIndex,
      model: st.model,
    }
  }

  // prompt layout: system blocks + reminders (spec 02 §5)
  const layout = layoutMessages(
    capped.messages,
    capped.turnStart,
    st.registry.turnReminder,
    stepReminder,
  )
  const system = systemBlocks(st.registry.block1, st.registry.block2)
  const prefix = `${JSON.stringify(system)}\u0000${toolNames.join(',')}`
  if (st.lastPrefix !== undefined && prefix !== st.lastPrefix && !st.cacheBustWarned) {
    st.cacheBustWarned = true
    st.rt.warn(
      {
        code: 'W_CACHE_BUST',
        message:
          'The cached prompt prefix changed within the session (instructions or active tools changed).',
        details: { stepIndex: st.stepIndex },
      },
      `${st.info.id}`,
    )
  }
  st.lastPrefix = prefix

  const cached = applyCache({
    config: st.input.cache,
    model: stepModel,
    prompt: { system, messages: layout.messages, tools, providerOptions },
    lastStable: layout.lastStable,
    lastStaticTool:
      st.registry.staticCount > 0
        ? st.registry.entries[st.registry.staticCount - 1]?.name
        : undefined,
  })

  // budget ledger (spec 12 §4.1): reserve the step's estimate before the call
  if (st.input.ledger !== undefined) {
    const decision = await st.input.ledger.beforeCall({
      stepIndex: st.stepIndex,
      model: stepModel,
      contextTokens: capped.tokens,
      maxOutputTokens: settings.maxOutputTokens,
    })
    if (!decision.ok) {
      if (st.external.length > 0) st.input.inbox?.unshift(st.external)
      st.external = []
      if (decision.stop === 'cost-cap')
        return { stop: 'cost-cap', steps: st.stepIndex, model: st.model }
      st.input.write({ type: 'error', errorText: decision.error.message })
      return { stop: 'error', error: decision.error, steps: st.stepIndex, model: st.model }
    }
    if (st.input.signal.aborted) return aborted(st)
  }
  return { stepModel, settings, activeTools, toolChoice, capped, cached }
}
