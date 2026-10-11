/**
 * Stop or continue after a step (internal): the stop rules, `turn.beforeEnd` continuations, the
 * wrap-up step and structured-output retries (spec 05 §3.1).
 */
import type { LanguageModelUsage } from 'ai'
import { hookFailed } from '../internal/hook-run.ts'
import { PROGRESS_NUDGE } from '../messages/texts.ts'
import type { StopReason } from '../messages/types.ts'
import { checkNative, missingToolError, type OutputCheck, outputRetryText } from '../output/turn.ts'
import { armExternals } from '../registry/external.ts'
import { toolTraits } from '../registry/risk.ts'
import { describeErrorWithCode } from '../stream/describe-error.ts'
import { describeStuck, type StuckReason } from './progress.ts'
import type { LoopResult, StepRun, StepsCtx } from './step-ctx.ts'
import { responseText } from './step-events.ts'
import {
  aborted,
  failAnswer,
  outputExhausted,
  outputInvalid,
  overBudget,
  runBounded,
} from './step-guards.ts'
import type { StepRecord } from './step-settle.ts'
import { decideStop, findPending, waitIdOf } from './stop.ts'

/**
 * Decide what follows a settled step: a `LoopResult` ends the turn, `'continue'` runs the next step.
 */
export async function decideNext(
  st: StepsCtx,
  run: StepRun,
  rec: StepRecord,
): Promise<LoopResult | 'continue'> {
  const { result, response, endStep, sawError, errorText, rawError } = run
  const { finishReason, total, step, hookStop } = rec
  if (st.input.signal.aborted) return aborted(st)
  // `endTurn`: the answers are recorded and the approved tools ran; no model step happened
  if (endStep && !sawError && response !== undefined) {
    if (st.external.length > 0) st.inbox?.unshift(st.external)
    st.external = []
    return { stop: 'complete', steps: 0, model: st.model }
  }

  const pending =
    response === undefined || finishReason !== 'tool-calls'
      ? undefined
      : findPending(
          st.input.messageId,
          response,
          st.registry.clientTools,
          (name) =>
            toolTraits((st.registry.tools[name] as { metadata?: unknown } | undefined)?.metadata),
          st.registry.externals.size === 0 ? undefined : new Set(st.registry.externals.keys()),
        )
  // request-scoped client tools with a timeout: the call expires when the client never answers
  // (spec 11 §7.1 rule 5); it takes part in the wait machinery like an external wait
  if (pending !== undefined && st.registry.requestTools.size > 0) {
    for (const call of pending.clientTools) {
      const meta = st.registry.requestTools.get(call.toolName)
      if (meta?.timeoutMs === undefined) continue
      call.waitId = waitIdOf(call.toolCallId)
      call.timeoutAt = Date.now() + meta.timeoutMs
      call.onTimeout = structuredClone(meta.onTimeout)
    }
  }
  let stuck: StuckReason | undefined
  if (response !== undefined) {
    const found = st.progress.observe(response)
    if (found !== undefined && st.input.progress !== false) stuck = found
  }
  const decide = (): StopReason | undefined =>
    decideStop({
      finishReason,
      sawError,
      pending,
      hookStop,
      stepCount: st.stepIndex,
      budget: st.budget,
      outputTokens: total.outputTokens ?? 0,
      maxOutputTokens: st.input.maxOutputTokens,
    })
  let stop: StopReason | undefined = decide()
  // external waits: defaults only; `start` runs after the pending state is committed (spec 11
  // §4.2 rule 1), so a fast callback can already be recorded
  if (stop === 'tool-pending' && pending?.externals !== undefined) {
    armExternals(pending, { externals: st.registry.externals })
  }
  // tool mode: a successful output tool call ends the turn 'complete' (before rule 4); a failed
  // one is an attempt (spec 05 §3.3 rules 2 and 5)
  const answered: OutputCheck | undefined =
    st.output?.mode === 'tool' && response !== undefined && !st.wrapping
      ? st.output.inspect(response)
      : undefined
  if (answered?.ok === true && st.output !== undefined) {
    st.output.state.value = { value: answered.value }
    if (finishReason === 'tool-calls' && !sawError) stop = 'complete'
  } else if (answered?.ok === false) {
    failAnswer(st, answered.error)
    if (stop === undefined && outputExhausted(st)) stop = outputInvalid(st)
  }
  if (stop === undefined && overBudget(st) !== undefined) stop = 'cost-cap'
  if (st.wrapping) {
    // the wrap-up step ends the turn whatever it answered (errors stay errors)
    st.wrapping = false
    if (stop !== 'error') stop = 'max-steps'
  } else if (stop === undefined && stuck !== undefined) {
    if (st.nudges < st.maxNudges) {
      st.nudges++
      st.progress.reset()
      st.nudge = PROGRESS_NUDGE.replace('{what}', describeStuck(stuck))
      st.rt.warn(
        {
          code: 'W_LOOP_STUCK',
          message: `The turn looks stuck (${describeStuck(stuck)}); the model was reminded.`,
          details: { ...stuck, stepIndex: st.stepIndex - 1 },
        },
        st.info.id,
      )
    } else {
      if (st.external.length > 0) st.inbox?.unshift(st.external)
      st.external = []
      return { stop: 'stuck', steps: st.stepIndex, model: st.model }
    }
  }
  if (stop === undefined) return 'continue'

  // pending input wins over 'complete' — but never past the step budget or the cost cap
  if (stop === 'complete' && st.inbox !== undefined) st.external.push(...(await st.inbox.take()))
  if (stop === 'complete' && (st.waiting.length > 0 || st.external.length > 0)) {
    if (st.stepIndex >= st.budget) stop = 'max-steps'
    else if ((total.outputTokens ?? 0) > st.input.maxOutputTokens) stop = 'cost-cap'
    else if (overBudget(st) !== undefined) stop = 'cost-cap'
    else return 'continue'
  }
  st.waiting = []

  const spent = overBudget(st) !== undefined
  if (!st.wrapped && !spent && (stop === 'complete' || stop === 'max-steps' || stop === 'length')) {
    const decision = await beforeEnd(st, stop, step?.text ?? responseText(response ?? []))
    if (decision === 'continue') return 'continue'
  }
  // structured output: the final 'complete' needs a valid answer, else retry (spec 05 §3.3)
  if (stop === 'complete' && st.output !== undefined) {
    const check: OutputCheck =
      st.output.mode === 'native'
        ? await checkNative(result.output)
        : st.output.state.value === undefined
          ? { ok: false, error: missingToolError(st.output.toolName) }
          : { ok: true, value: st.output.state.value.value }
    if (check.ok) {
      st.output.state.value = { value: check.value }
    } else {
      failAnswer(st, check.error)
      const next = retryOutput(st, check.error, total)
      if (next === 'continue') return 'continue'
      stop = next
      st.wrapped = true // the model already answered: no wrap-up step after a refused retry
    }
  }
  if (stop === 'max-steps' && st.input.wrapUp && !st.wrapped && !spent) {
    // one more step without tools: the model summarizes what is done and what is left
    st.wrapped = true
    st.wrapping = true
    st.budget = st.stepIndex + 1
    return 'continue'
  }
  // not delivered: back to the inbox, the turn decides (queued turn or input-dropped)
  if (st.external.length > 0) st.inbox?.unshift(st.external)
  st.external = []
  if (stop === 'error') {
    return {
      stop,
      error: {
        code: rawError === undefined ? 'EH_RUN_FAILED' : describeErrorWithCode(rawError).code,
        message: errorText ?? 'The model call failed.',
      },
      steps: st.stepIndex,
      model: st.model,
    }
  }
  if (stop === 'tool-pending' && pending !== undefined)
    return { stop, pending, steps: st.stepIndex, model: st.model }
  return { stop, steps: st.stepIndex, model: st.model }
}

async function beforeEnd(
  st: StepsCtx,
  current: StopReason,
  lastText: string,
): Promise<'continue' | 'stop'> {
  const list = st.hooks.list('turn.beforeEnd')
  if (list.length === 0) return 'stop'
  for (const hook of list) {
    let out: Awaited<ReturnType<typeof hook.fn>>
    try {
      out = await runBounded(st, 'turn.beforeEnd', hook.owner, () =>
        hook.fn(st.contextOf(hook.owner), {
          stop: current,
          stepIndex: st.stepIndex - 1,
          continues: st.continues,
          idleContinues: idleNow(st),
          lastText,
        }),
      )
    } catch (error) {
      hookFailed(st.rt, 'turn.beforeEnd', hook.owner, error)
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
    if (st.continues >= st.input.maxContinues) {
      st.rt.warn(
        {
          code: 'W_CONTINUE_LIMIT',
          message: `turn.beforeEnd asked to continue more than loop.maxContinues (${st.input.maxContinues}) times; ignored.`,
          details: { owner: hook.owner, continues: st.continues, reason: 'max' },
        },
        st.info.id,
      )
      return 'stop'
    }
    const idle = idleNow(st)
    if (idle >= st.input.maxIdleContinues) {
      st.rt.warn(
        {
          code: 'W_CONTINUE_LIMIT',
          message: `turn.beforeEnd asked to continue, but the last ${idle} continuations made no progress (loop.maxIdleContinues); ignored.`,
          details: {
            owner: hook.owner,
            continues: st.continues,
            idleContinues: idle,
            reason: 'no-progress',
          },
        },
        st.info.id,
      )
      return 'stop'
    }
    st.idleContinues = idle
    st.novelAtContinue = st.progress.novel
    if ('continue' in out && typeof out.continue?.reason === 'string') {
      st.continues++
      st.waiting.push({ source: `plugin:${hook.owner}`, text: out.continue.reason })
      if (st.stepIndex >= st.budget) st.budget = st.stepIndex + 1
      return 'continue'
    }
    if ('extendSteps' in out && typeof out.extendSteps === 'number') {
      st.continues++
      st.budget += Math.floor(out.extendSteps)
      return 'continue'
    }
  }
  return 'stop'
}

/**
 * Retry a missing / invalid final answer as a core continuation (`plugin:eh.output`), bounded
 * like `turn.beforeEnd` continuations, the step budget and the budgets.
 */
function retryOutput(
  st: StepsCtx,
  error: string,
  total: LanguageModelUsage,
): 'continue' | StopReason {
  if (outputExhausted(st)) return outputInvalid(st)
  if (st.continues >= st.input.maxContinues) {
    st.rt.warn(
      {
        code: 'W_CONTINUE_LIMIT',
        message: `The output retry would continue more than loop.maxContinues (${st.input.maxContinues}) times; refused.`,
        details: { owner: 'eh.output', continues: st.continues, reason: 'max' },
      },
      st.info.id,
    )
    return outputInvalid(st)
  }
  const idle = idleNow(st)
  if (idle >= st.input.maxIdleContinues) {
    st.rt.warn(
      {
        code: 'W_CONTINUE_LIMIT',
        message: `The output retry would continue, but the last ${idle} continuations made no progress (loop.maxIdleContinues); refused.`,
        details: {
          owner: 'eh.output',
          continues: st.continues,
          idleContinues: idle,
          reason: 'no-progress',
        },
      },
      st.info.id,
    )
    return outputInvalid(st)
  }
  if (st.stepIndex >= st.budget) return 'max-steps'
  if ((total.outputTokens ?? 0) > st.input.maxOutputTokens) return 'cost-cap'
  if (overBudget(st) !== undefined) return 'cost-cap'
  st.idleContinues = idle
  st.novelAtContinue = st.progress.novel
  st.continues++
  st.waiting.push({ source: 'plugin:eh.output', text: outputRetryText(error) })
  if (st.output?.mode === 'tool') st.forceOutputTool = true
  return 'continue'
}

/** Idle continuations in a row, counting the last one when nothing new happened since. */
function idleNow(st: StepsCtx): number {
  return st.novelAtContinue !== undefined && st.progress.novel === st.novelAtContinue
    ? st.idleContinues + 1
    : 0
}
