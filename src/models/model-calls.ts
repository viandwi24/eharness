/**
 * Binding of model call observation to a session (internal): wraps a model so every provider call
 * fires the `model.call` hooks, and only when some plugin registered one.
 *
 * @see docs/specs/12-models-and-cost.md#7-model-call-observation
 */
import type { LanguageModel } from 'ai'
import { hookFailed, hookTimeoutOf, runHook } from '../internal/hook-run.ts'
import type { SessionRuntime } from '../session/runtime.ts'
import { costOf } from './cost.ts'
import {
  type ModelCallEvent,
  type ModelCallKind,
  type ModelCallRecord,
  observeModel,
} from './observe.ts'

/** Context of one observed call. */
export interface ModelCallScope {
  kind: ModelCallKind
  turnId?: string | undefined
  stepIndex?: number | undefined
  messageId?: string | undefined
}

/**
 * `model`, wrapped to fire `model.call` for each call; `model` itself (no wrapping, no assembly,
 * no cost) when no plugin listens.
 */
export function observeForSession(
  rt: SessionRuntime,
  model: LanguageModel,
  scope: ModelCallScope,
): LanguageModel {
  const hooks = rt.open?.hooks
  if (hooks === undefined || !hooks.has('model.call')) return model
  return observeModel(model, async (record: ModelCallRecord) => {
    const event: ModelCallEvent = { ...record, kind: scope.kind, sessionId: rt.id }
    const turnId = scope.turnId ?? rt.turn?.info.id
    if (turnId !== undefined) event.turnId = turnId
    if (scope.stepIndex !== undefined) event.stepIndex = scope.stepIndex
    if (scope.messageId !== undefined) event.messageId = scope.messageId
    const cost = costOf(rt.agent.config.models, model, record.usage)
    if (cost !== undefined) event.costUsd = cost
    for (const hook of hooks.list('model.call')) {
      try {
        await runHook(() => hook.fn(rt.contextOf(hook.owner), structuredClone(event)), {
          hook: 'model.call',
          owner: hook.owner,
          timeoutMs: hookTimeoutOf(rt.agent.config),
        })
      } catch (error) {
        hookFailed(rt, 'model.call', hook.owner, error)
      }
    }
  })
}
