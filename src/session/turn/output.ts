import type { UIMessageChunk } from 'ai'
import { describeModel } from '../../internal/model.ts'
import { abortReason } from '../../internal/util.ts'
import { messageToChunks } from '../../messages/replay.ts'
import { INTERRUPTED_TURN } from '../../messages/texts.ts'
import type { HarnessUsageMeta, StopReason } from '../../messages/types.ts'
import { toTurnError } from '../../stream/describe-error.ts'
import { pendingCallIds } from '../interaction/waits.ts'
import type { TurnCtx } from './ctx.ts'
import { metaError, withoutUndefined } from './helpers.ts'

export function currentGrants(
  t: TurnCtx,
): Readonly<Record<string, 'always' | 'never'>> | undefined {
  if (t.grantsRecorded && (t.turnState.step?.index ?? 0) === 0) return t.grantsBefore
  return t.rt.state.core().grants
}
export function barrier(t: TurnCtx): Promise<void> {
  if (t.drained || t.stepEndsDone >= t.finishStepsWritten) return Promise.resolve()
  return new Promise<void>((resolve) => {
    t.wakeBarrier = resolve
  })
}

export function checkBarrier(t: TurnCtx): void {
  if (t.drained || t.stepEndsDone >= t.finishStepsWritten) {
    const wake = t.wakeBarrier
    t.wakeBarrier = undefined
    wake?.()
  }
}

export function write(t: TurnCtx, chunk: UIMessageChunk): void {
  if (!t.turnState.active) return
  if (t.writer === undefined) {
    // the stream is created at `start`: a continuation needs the patched message A' first
    if (chunk.type !== 'start') {
      t.preStart.push(chunk)
      return
    }
    t.openStream()
    emit(t, chunk)
    for (const early of t.preStart.splice(0)) emit(t, early)
    return
  }
  emit(t, chunk)
}

export function emit(t: TurnCtx, chunk: UIMessageChunk): void {
  if (chunk.type === 'finish' || chunk.type === 'abort') {
    t.terminal ??= chunk
    t.writer?.write(chunk)
    return
  }
  t.buffer.push(chunk)
  if (chunk.type === 'finish-step') t.finishStepsWritten++
  trackToolCall(t, chunk)
  t.writer?.write(chunk)
}

export function trackToolCall(t: TurnCtx, chunk: UIMessageChunk): void {
  switch (chunk.type) {
    case 'tool-input-start':
    case 'tool-input-available':
      t.openCalls.add(chunk.toolCallId)
      break
    case 'tool-output-available':
      if (chunk.preliminary !== true) t.openCalls.delete(chunk.toolCallId)
      break
    case 'tool-output-error':
    case 'tool-output-denied':
    case 'tool-input-error':
      t.openCalls.delete(chunk.toolCallId)
      break
  }
}

/**
 * Answer every open tool call that is not pending with an `INTERRUPTED_TURN` error chunk, so
 * the live UI and the stored message agree (spec 05 §3 step 16, ADR-0014).
 */
export function answerOpenCalls(t: TurnCtx): void {
  if (!t.committed) return
  const pending = t.outcome.stop === 'tool-pending' ? t.outcome.pending : undefined
  for (const toolCallId of [...t.openCalls]) {
    if (pending !== undefined && pendingCallIds(pending).has(toolCallId)) continue
    t.interrupted.add(toolCallId)
    write(t, { type: 'tool-output-error', toolCallId, errorText: INTERRUPTED_TURN })
  }
}

/** `start`; a continuation writes it without metadata (A's createdAt/turnId are kept). */
export function writeStart(
  t: TurnCtx,
  id: string,
  parentId: string | null | undefined,
  metadata = true,
): void {
  t.startWritten = true
  // a continuation: resume readers get the continued message rebuilt first (spec 04 §6.3)
  if (!metadata && t.original?.[0] !== undefined) {
    const base = t.original[0]
    t.buffer.setReplayPrefix(() => messageToChunks(base))
  }
  write(
    t,
    metadata
      ? {
          type: 'start',
          messageId: id,
          messageMetadata: {
            eharness: withoutUndefined({
              v: 1,
              createdAt: t.startedAt,
              turnId: t.turnId,
              parentId,
            }),
          },
        }
      : { type: 'start', messageId: id },
  )
  t.resolveMessageId(id)
}

export function usageMeta(t: TurnCtx): HarnessUsageMeta {
  const meta: HarnessUsageMeta = {
    inputTokens: t.usage.input + t.usage.nestedInput,
    outputTokens: t.usage.output + t.usage.nestedOutput,
    totalTokens: t.usage.total + t.usage.nestedTotal,
  }
  if (t.usage.reasoning > 0) meta.reasoningTokens = t.usage.reasoning
  if (t.usage.cacheRead !== undefined) meta.cachedInputTokens = t.usage.cacheRead
  if (t.usage.cacheWrite !== undefined) meta.cacheWriteTokens = t.usage.cacheWrite
  if (t.usage.nestedTotal > 0) meta.nested = t.usage.nestedTotal
  if (t.usage.costUsd !== undefined) meta.costUsd = t.usage.costUsd
  return meta
}

/** Usage and steps are cumulative over all turns that wrote the message (spec 04 §2). */
export function cumulativeUsage(t: TurnCtx): HarnessUsageMeta {
  const current = usageMeta(t)
  const previous = t.baseMessage?.metadata?.eharness?.usage
  if (previous === undefined) return current
  const out: Record<string, number> = {}
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const a = (previous as Record<string, unknown>)[key]
    const b = (current as Record<string, unknown>)[key]
    out[key] = (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0)
  }
  return out as HarnessUsageMeta
}

/** The valid final answer of the turn (spec 05 §3.3): only with stop `'complete'`. */
export function validOutput(t: TurnCtx): { value: unknown } | undefined {
  return t.outcome.stop === 'complete' ? t.turnOutput?.state.value : undefined
}

/** `metadata.eharness.output` of a turn with `SendOptions.output`. */
export function outputMeta(t: TurnCtx): { ok: boolean; attempts: number } | undefined {
  if (t.turnOutput === undefined) return undefined
  const ok = validOutput(t) !== undefined
  return { ok, attempts: t.turnOutput.state.failures + (ok ? 1 : 0) }
}

/** Interrupted calls + message-metadata + setOutcome + finish | abort (spec 04 §2). */
export function writeEnd(t: TurnCtx): void {
  if (!t.startWritten)
    writeStart(t, t.assistantId ?? t.rt.agent.generateId(), undefined, t.plan === undefined)
  answerOpenCalls(t)
  const previousSteps = t.baseMessage?.metadata?.eharness?.steps ?? 0
  const eharness: Record<string, unknown> = t.committed
    ? withoutUndefined({
        model: describeModel(t.outcome.model),
        usage: cumulativeUsage(t),
        stop: t.outcome.stop,
        steps: previousSteps + t.outcome.steps,
        durationMs: Date.now() - t.startedAt,
        // a continuation resolved A's pending state: null, not absent (metadata is deep-merged)
        pending: t.plan === undefined ? t.outcome.pending : (t.outcome.pending ?? null),
        error: metaError(t.outcome.error),
        output: outputMeta(t),
      })
    : withoutUndefined({ stop: t.outcome.stop, error: metaError(t.outcome.error) })
  write(t, { type: 'message-metadata', messageMetadata: { eharness } })
  const aborted = t.outcome.stop === 'aborted' || t.outcome.stop === 'timeout'
  t.writer?.setOutcome(
    aborted
      ? { status: 'aborted' }
      : t.outcome.stop === 'error'
        ? { status: 'failed', error: t.outcome.error }
        : { status: 'completed' },
  )
  write(
    t,
    aborted
      ? {
          type: 'abort',
          reason: t.outcome.abortReason ?? (t.outcome.stop === 'timeout' ? 'timeout' : 'aborted'),
        }
      : { type: 'finish' },
  )
}

export function earlyEnd(t: TurnCtx, stop: StopReason, error?: unknown): void {
  if (!t.committed && t.stateCheckpoint !== undefined)
    t.rt.state.revert(t.stateCheckpoint, [...t.touched.values()])
  if (!t.startWritten) writeStart(t, t.rt.agent.generateId(), undefined) // throwaway id, never stored
  t.outcome = { stop, steps: 0, model: t.info.model }
  if (!t.committed && error !== undefined) t.resolveAccepted(toTurnError(error, t.log))
  if (stop === 'aborted' || stop === 'timeout') {
    t.outcome.stop = t.timedOut ? 'timeout' : 'aborted'
    t.outcome.abortReason = t.timedOut ? 'timeout' : abortReason(t.controller.signal)
  }
  if (error !== undefined) {
    t.outcome.error = toTurnError(error, t.log)
    write(t, { type: 'error', errorText: t.outcome.error.message })
  }
  writeEnd(t)
}

/** A matching cross-process abort request (spec 05 §9.1): the normal abort path. */
export function abortFromRequest(t: TurnCtx, reason: string | undefined): void {
  if (t.ended || t.controller.signal.aborted) return
  t.host.dropQueue()
  t.controller.abort(reason ?? 'aborted')
}

export function closeBuffer(t: TurnCtx, stop?: StopReason): void {
  if (t.terminal !== undefined) t.buffer.push(t.terminal)
  t.buffer.close()
  // a turn that never committed was never written to the log (spec 05 §3)
  if (t.streamLog !== undefined) {
    const status =
      stop === 'aborted' || stop === 'timeout' || t.terminal?.type === 'abort'
        ? 'aborted'
        : stop === 'error' || stop === undefined
          ? 'error'
          : 'done'
    void t.streamLog.finish(status)
  }
}
