import { inputWireMessage } from '../messages/input-wire.ts'
import type { LoopResult, StepsCtx } from './step-ctx.ts'
import { fileResolution } from './step-files.ts'
import { aborted, firstOfContinuation, overBudget } from './step-guards.ts'

/**
 * The start of a step: stop early (abort, used-up budget, compaction thrash) or deliver the waiting
 * input and compact the wire. `undefined` = go on with the step.
 */
export async function beginStep(st: StepsCtx): Promise<LoopResult | undefined> {
  if (st.input.signal.aborted) return aborted(st)
  // a session budget used up by earlier turns stops the turn before any model call
  if (st.stepIndex === 0 && overBudget(st) !== undefined)
    return { stop: 'cost-cap', steps: 0, model: st.model }

  // step boundary: deliver waiting input as data-eh.input (ADR-0011): steers and next-step
  // injections first (arrival order), then hook context. The wrap-up step takes no input:
  // what waits follows the "any other stop" rule (a queued turn, spec 05 §3.1 / 11 §6.1)
  if (!firstOfContinuation(st) && !st.wrapping) {
    if (st.inbox !== undefined) st.external.push(...(await st.inbox.take()))
    for (const item of st.external) {
      st.input.write({ type: 'data-eh.input', data: structuredClone(item.data) })
      st.wire.push(...(await inputWireMessage(item.data, fileResolution(st.input.rt, st.model))))
      st.input.delivered?.(item)
    }
    st.external = []
  }
  for (const item of st.waiting) {
    st.input.write({ type: 'data-eh.input', data: { source: item.source, text: item.text } })
    st.wire.push({ role: 'user', content: [{ type: 'text', text: item.text }] })
  }
  st.waiting = []

  // mid-turn compaction (spec 06 §4): rebuild the wire from the compacted view
  if (st.stepIndex >= 1) {
    const delivered = st.wire.slice(st.sinceBarrier)
    const costBefore = st.input.usage.costUsd
    const rebuilt = await st.compaction.midTurn({
      wire: st.wire,
      stepIndex: st.stepIndex,
      delivered,
    })
    // compaction thrash (spec 06 §4): no further model call, no turn.beforeEnd
    if (rebuilt === 'thrash')
      return { stop: 'context-thrash', steps: st.stepIndex, model: st.model }
    if (rebuilt !== undefined) {
      st.wire.splice(0, st.wire.length, ...rebuilt.wire)
      st.turnStart = rebuilt.turnStart
      st.sinceBarrier = st.wire.length - delivered.length
    }
    if (st.input.signal.aborted) return aborted(st)
    // the summarizer's usage may have used up a budget: no further model call (spec 12 §4)
    if (st.input.usage.costUsd !== costBefore && overBudget(st) !== undefined) {
      return { stop: 'cost-cap', steps: st.stepIndex, model: st.model }
    }
  }
  return undefined
}
