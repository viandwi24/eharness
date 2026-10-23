/**
 * The bookkeeping after a step (internal): wire, usage, cost, ledger commit, `step.end` hooks.
 */
import type { FinishReason, LanguageModelUsage, StepResult, ToolSet } from 'ai'
import { hookFailed } from '../internal/hook-run.ts'
import { describeModel } from '../internal/model.ts'
import { settledCostOf } from '../models/cost.ts'
import { noSuchToolText } from '../registry/tool-search.ts'
import type { LoopResult, StepRequest, StepRun, StepsCtx } from './step-ctx.ts'
import { collectDiscovered, guarded, rewriteUnavailable, stepEndEvent } from './step-events.ts'
import { aborted, runBounded, totalUsage } from './step-guards.ts'
import { addUsage, totalUsageOf } from './usage.ts'

/** What the settled step produced. */
export interface StepRecord {
  finishReason: FinishReason | undefined
  total: LanguageModelUsage
  step: StepResult<ToolSet> | undefined
  hookStop: string | undefined
}

/**
 * Append the step's response to the wire and account for it. A `LoopResult` means the turn ends
 * here (aborted, step timeout, `endTurn`).
 */
export async function recordStep(
  st: StepsCtx,
  req: StepRequest,
  run: StepRun,
): Promise<StepRecord | LoopResult> {
  const { stepModel, settings, capped } = req
  const { result, response, turnState, stepAborted, endStep, noteWire } = run
  if (response !== undefined) {
    const raw = response
    const readable = rewriteUnavailable(raw, (name) => noSuchToolText(name, st.registry.tools))
    collectDiscovered(raw, st.input.discovered)
    // the notes sit between the tool result message and the model's answer (stored order)
    const split = noteWire.length === 0 ? 0 : response[0]?.role === 'tool' ? 1 : 0
    st.wire.push(...readable.slice(0, split), ...noteWire, ...readable.slice(split))
  }
  await st.input.barrier()
  st.sinceBarrier = st.wire.length
  if (turnState !== undefined) turnState.step = undefined
  st.stepIndex++

  const finishReason = response === undefined ? undefined : await guarded(result.finishReason)
  const stepUsage = response === undefined ? undefined : await guarded(result.usage)
  // rejects like responseMessages on abort / early provider failure
  const step = response === undefined ? undefined : await guarded(result.finalStep)
  let stepCost: number | undefined
  if (stepUsage !== undefined) {
    const cost = settledCostOf(
      st.input.models,
      stepModel,
      stepUsage,
      step?.providerMetadata,
    )?.costUsd
    stepCost = cost
    if (cost === undefined && st.input.budget !== undefined) {
      st.rt.warn(
        {
          code: 'W_MODEL_UNPRICED',
          message: `No pricing for model '${describeModel(stepModel)}' in \`models\`; its usage does not count toward the budget.`,
          details: { model: describeModel(stepModel) },
        },
        `unpriced:${describeModel(stepModel)}`,
      )
    }
    addUsage(st.input.usage, stepUsage, false, cost)
    if (!endStep) st.compaction.observe(capped.raw, stepUsage.inputTokens)
  }
  // commit what is known (an aborted or failed step without usage commits 0, spec 12 §4.1)
  if (st.input.ledger !== undefined) await st.input.ledger.afterCall(stepCost ?? 0)
  const total = totalUsageOf(st.input.usage)
  st.input.write({
    type: 'data-eh.usage',
    data: {
      inputTokens: total.inputTokens ?? 0,
      outputTokens: total.outputTokens ?? 0,
      totalTokens: total.totalTokens ?? 0,
      steps: st.stepIndex,
      ...(st.input.usage.costUsd === undefined ? {} : { costUsd: st.input.usage.costUsd }),
    },
    transient: true,
  })
  st.input.write({
    type: 'data-eh.context',
    data: await st.compaction.contextStats(stepModel, st.wire, settings.maxOutputTokens),
    transient: true,
  })
  await st.input.heartbeat()

  if (stepAborted || st.input.signal.aborted) {
    if (st.input.signal.aborted) return aborted(st)
    // an abort chunk while the turn signal is not aborted: AI SDK step timeout
    return { stop: 'timeout', steps: st.stepIndex, model: st.model, abortReason: 'timeout' }
  }

  // step.end hooks
  let hookStop: string | undefined
  if (finishReason !== undefined && response !== undefined) {
    const event = stepEndEvent(
      st.stepIndex - 1,
      finishReason,
      stepUsage ?? totalUsage(st),
      total,
      response,
      step,
    )
    if (st.input.usage.costUsd !== undefined) event.costUsd = st.input.usage.costUsd
    for (const hook of st.hooks.list('step.end')) {
      try {
        const out = await runBounded(st, 'step.end', hook.owner, () =>
          hook.fn(st.contextOf(hook.owner), event),
        )
        if (out === undefined || out === null) continue
        if (typeof out.context === 'string' && out.context.length > 0) {
          st.waiting.push({ source: `plugin:${hook.owner}`, text: out.context })
        }
        if (typeof out.stop === 'string' && hookStop === undefined) {
          hookStop = `plugin:${hook.owner}:${out.stop}`
        }
      } catch (error) {
        hookFailed(st.rt, 'step.end', hook.owner, error)
      }
    }
  }
  return { finishReason, total, step, hookStop }
}
