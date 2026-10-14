import type { UIMessage } from 'ai'
import { hookFailed, runHook } from '../../internal/hook-run.ts'
import { createKindMessage } from '../../messages/kinds.ts'
import { INTERRUPTED_TURN } from '../../messages/texts.ts'
import { answerDanglingToolParts } from '../../messages/tool-parts.ts'
import type { HarnessUIMessage, StopReason, TurnResult } from '../../messages/types.ts'
import { toTurnError } from '../../stream/describe-error.ts'
import { forgetDelivered, recordDelivered } from '../inbox/dedupe.ts'
import { pendingCallIds, timedWaits } from '../interaction/waits.ts'
import { unregisterLocalTurn } from '../local-turns.ts'
import type { TurnCtx } from './ctx.ts'
import { withoutUndefined } from './helpers.ts'
import { markDelivered, settleInbox, settleOpInbox } from './inbox.ts'
import { checkBarrier, closeBuffer, validOutput } from './output.ts'

export async function onStepEnd(t: TurnCtx, message: HarnessUIMessage): Promise<void> {
  try {
    if (t.committed && t.assistantId !== undefined && message.id === t.assistantId) {
      t.lastStepMessage = message
      t.rt.cacheMessage(message)
      if (t.config.loop?.persistEachStep !== false) {
        let saved = false
        try {
          await t.host.persist([structuredClone(message)])
          saved = true
        } catch (error) {
          // retried by the next step's (or the final) save
          t.rt.log.warn('eharness: assistant snapshot save failed; retrying at the next step', {
            error,
          })
        }
        // events delivered before this finish-step are in the saved snapshot now
        if (saved) await markDelivered(t, t.stepEndsDone + 1)
      }
    }
  } finally {
    t.stepEndsDone++
    checkBarrier(t)
  }
}

export async function onEnd(t: TurnCtx, message: HarnessUIMessage | undefined): Promise<void> {
  if (t.ended) return
  t.ended = true
  if (t.turnTimer !== undefined) clearTimeout(t.turnTimer)
  if (t.heartbeatTimer !== undefined) clearInterval(t.heartbeatTimer)
  t.external?.removeEventListener('abort', t.onExternalAbort)
  let finished: { turnResult: TurnResult<UIMessage>; stop: StopReason } | undefined
  try {
    finished = await endPhases(t, message)
  } catch (endError) {
    // whatever throws above, the turn must still end: lock released, result resolved, stream closed
    t.rt.log.error('eharness: the end of the turn failed', { error: endError })
  }
  const stop: StopReason = finished?.stop ?? 'error'
  const turnResult: TurnResult<UIMessage> =
    finished?.turnResult ??
    withoutUndefined({
      turnId: t.turnId,
      kind: t.op.kind,
      messageId: t.committed ? t.assistantId : undefined,
      stop: 'error' as const,
      messages: [] as UIMessage[],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: t.outcome.steps,
      durationMs: Date.now() - t.startedAt,
      error: toTurnError(new Error('the end of the turn failed'), (m, d) => t.rt.log.warn(m, d)),
    })
  // the finalisation: every step guarded, none can keep the session busy. After the lock is
  // released everything runs synchronously (no await between `running = false` and the end)
  const guard = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (finalError) {
      t.rt.log.warn(`eharness: ${what} failed`, { error: finalError })
    }
  }
  if (t.releaseLock !== undefined) {
    try {
      await t.releaseLock()
    } catch (lockError) {
      t.rt.log.warn('eharness: releasing the session lock failed', { error: lockError })
    }
  }
  unregisterLocalTurn(t.rt, t.turnId)
  if (t.rt.turn === t.turnState) t.rt.turn = undefined
  t.rt.running = false
  guard('status event', () => t.rt.events.emit({ type: 'status', running: false }))
  t.resolveAccepted(undefined) // no-op after a pre-commit failure or commit
  t.resolveResult(turnResult)
  guard('turn-end bookkeeping', () => t.host.onTurnEnd())
  guard('stopObserving', () => t.stopObserving())
  // the stream ends last: a reader that saw `finish` can start the next turn right away
  guard('closing the stream', () => closeBuffer(t, stop))
}

export async function endPhases(
  t: TurnCtx,
  message: HarnessUIMessage | undefined,
): Promise<{ turnResult: TurnResult<UIMessage>; stop: StopReason }> {
  let stop = t.outcome.stop
  let error = t.outcome.error
  let assistant: HarnessUIMessage | undefined
  const after: HarnessUIMessage[] = []
  if (t.committed) {
    if (t.assistantId !== undefined) {
      let final = structuredClone(
        message ??
          t.lastStepMessage ??
          t.baseMessage ?? {
            id: t.assistantId,
            role: 'assistant' as const,
            metadata: { eharness: { v: 1 as const, createdAt: t.startedAt, turnId: t.turnId } },
            parts: [],
          },
      )
      final.id = t.assistantId
      const pending = t.outcome.pending
      final = answerDanglingToolParts(final, INTERRUPTED_TURN, (part) =>
        pending === undefined ? false : pendingCallIds(pending).has(part.toolCallId),
      )
      // chunk-answered parts: same shape as answerDanglingToolParts (input {} fallback, no approval)
      final = {
        ...final,
        parts: final.parts.map((part) => {
          const tool = part as {
            toolCallId?: string
            input?: unknown
            approval?: { approved?: boolean }
            state?: string
          }
          if (tool.toolCallId === undefined) return part
          // an automatically `approved` call of a tool without `execute` parks as its normal
          // kind: the part is an open call again, without the (answered) approval (spec 11 §3)
          if (
            pending !== undefined &&
            tool.state === 'approval-responded' &&
            tool.approval?.approved === true &&
            pendingCallIds(pending).has(tool.toolCallId)
          ) {
            const { approval: _approval, ...rest } = tool
            return { ...rest, state: 'input-available' } as typeof part
          }
          if (!t.interrupted.has(tool.toolCallId)) return part
          const { approval: _approval, ...rest } = tool
          return { ...rest, input: tool.input ?? {} } as typeof part
        }),
      }

      assistant = final
      try {
        assistant = (await t.host.persist([final]))[0] ?? final
        await markDelivered(t, Number.POSITIVE_INFINITY)
      } catch (saveError) {
        stop = 'error'
        error = toTurnError(saveError, t.log)
        t.rt.cacheMessage(final)
      }
      if (
        t.outcome.stop === 'error' ||
        t.outcome.stop === 'timeout' ||
        t.outcome.stop === 'context-thrash'
      ) {
        const notice = createKindMessage(
          'eh.notice',
          t.outcome.stop === 'timeout'
            ? {
                level: 'warning',
                code: 'EH_TURN_TIMEOUT',
                message: 'The turn exceeded its time limit.',
              }
            : t.outcome.stop === 'context-thrash'
              ? {
                  level: 'warning',
                  code: 'EH_CONTEXT_THRASH',
                  message:
                    'The turn stopped: its context filled up again right after a compaction.',
                }
              : withoutUndefined({
                  level: 'error' as const,
                  code: t.outcome.error?.code,
                  message: t.outcome.error?.message ?? 'The turn failed.',
                }),
          { id: t.rt.nextId(), turnId: t.turnId, createdAt: Date.now(), parentId: t.assistantId },
        )
        try {
          after.push(...(await t.host.persist([notice])))
        } catch (noticeError) {
          t.rt.log.warn('eharness: saving the error notice failed', { error: noticeError })
        }
      }
    }
    const core = t.rt.state.core()
    const parked = stop === 'tool-pending' ? t.outcome.pending : undefined
    if (parked !== undefined) {
      core.pending = parked
      t.rt.state.markDirty()
      t.rt.events.emit({ type: 'pending', pending: parked })
    }
    if (core.activeTurn?.turnId === t.turnId) {
      delete core.activeTurn
      t.rt.state.markDirty()
    }
    if (core.abortRequest !== undefined) {
      delete core.abortRequest // served (or stale): cleared by the end-of-turn write
      t.rt.state.markDirty()
    }
    const previous = core.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
    core.usage = {
      inputTokens: previous.inputTokens + t.usage.input + t.usage.nestedInput,
      outputTokens: previous.outputTokens + t.usage.output + t.usage.nestedOutput,
      turns: previous.turns + (t.outcome.steps > 0 ? 1 : 0),
    }
    const cost = (previous.costUsd ?? 0) + (t.usage.costUsd ?? 0)
    if (previous.costUsd !== undefined || t.usage.costUsd !== undefined) core.usage.costUsd = cost
    t.rt.state.markDirty()
    // a durable wake turn: its ids are written with this state write (dedupe), acked after it
    const wakeIds = t.wakeFromInbox && !t.inboxSettled ? (t.op.inbox?.ids ?? []) : []
    if (wakeIds.length > 0) recordDelivered(core, wakeIds)
    let stateSaved = false
    try {
      stateSaved = await t.rt.state.writeIfDirty()
      if (!stateSaved) await lostState(t)
    } catch (stateError) {
      t.rt.log.warn('eharness: end-of-turn state write failed', { error: stateError })
    }
    // external waits with a timeout: a durable timer item and the live timer (spec 11 §4.2 rule 6)
    if (stateSaved && parked !== undefined && timedWaits(parked).length > 0) {
      await t.host.waitsParked(parked)
      // what `start` returned is stored with the pending state: the result carries it too
      const settled = t.rt.state.core().pending
      if (settled?.messageId === parked.messageId) t.outcome.pending = structuredClone(settled)
    }
    if (wakeIds.length > 0) {
      if (stateSaved) settleOpInbox(t, 'applied')
      else {
        forgetDelivered(t.rt.state.core(), wakeIds)
        settleOpInbox(t, { how: 'retry', error: new Error('end-of-turn state write failed') })
      }
    }
  }
  t.rt.state.guard(undefined)
  if (t.op.inbox !== undefined && !t.inboxSettled) {
    // not applied: retried elsewhere when another instance had the session (or ours closes)
    // (with `inbox.retry`: deferral / counted attempt / dead, spec 05 §12 rules 11–13)
    const code = t.outcome.error?.code
    const failure = t.outcome.error ?? new Error(`turn ended: ${stop}`)
    if (t.rt.closed) {
      // dropped by `close()`: not tried unless it got past its commit point
      settleOpInbox(t, t.committed ? { how: 'retry', error: failure } : { how: 'defer' })
    } else if (stop === 'error' && (code === 'EH_SESSION_BUSY' || code === 'EH_STORAGE')) {
      settleOpInbox(t, { how: 'retry', error: failure })
    } else if (stop === 'error') {
      settleOpInbox(t, { how: 'error', error: failure })
    } else settleOpInbox(t, { how: 'drop' })
  }

  const messages = [
    ...t.created.slice(0, t.createdBeforeAssistant),
    ...(assistant === undefined ? [] : [assistant]),
    ...t.created.slice(t.createdBeforeAssistant),
    ...after,
  ]
  const turnResult: TurnResult<UIMessage> = withoutUndefined({
    turnId: t.turnId,
    kind: t.op.kind,
    messageId: t.committed ? t.assistantId : undefined,
    stop,
    pending: stop === 'tool-pending' ? t.outcome.pending : undefined,
    partial: stop === 'tool-pending' ? t.outcome.partial : undefined,
    messages: structuredClone(messages) as UIMessage[],
    usage: withoutUndefined({
      inputTokens: t.usage.input + t.usage.nestedInput,
      outputTokens: t.usage.output + t.usage.nestedOutput,
      totalTokens: t.usage.total + t.usage.nestedTotal,
      cachedInputTokens: t.usage.cacheRead,
      cacheWriteTokens: t.usage.cacheWrite,
      costUsd: t.usage.costUsd,
    }),
    steps: t.outcome.steps,
    durationMs: Date.now() - t.startedAt,
    error: stop === 'error' ? error : undefined,
    output: stop === 'complete' ? validOutput(t)?.value : undefined,
  })
  if (t.committed) {
    const endId = t.assistantId ?? t.created.at(-1)?.id
    if (endId !== undefined)
      t.rt.events.emit({ type: 'turn-end', turnId: t.turnId, messageId: endId, stop })
    for (const hook of t.rt.open?.hooks.list('turn.end') ?? []) {
      try {
        // no turn signal: an aborted turn still reports its end (audit logs); the timeout bounds it
        await runHook(() => hook.fn(t.rt.contextOf(hook.owner), turnResult as TurnResult), {
          hook: 'turn.end',
          owner: hook.owner,
          timeoutMs: t.hookTimeoutMs,
        })
      } catch (hookError) {
        hookFailed(t.rt, 'turn.end', hook.owner, hookError)
      }
    }
    // `ctx.state` changes made by `turn.end` hooks are written now (the end-of-turn write above
    // ran before the hooks): a plugin such as `longRun` must not lose its job state on a crash
    try {
      await t.rt.state.writeIfDirty()
    } catch (stateError) {
      t.rt.log.warn('eharness: writing the state changed by turn.end hooks failed', {
        error: stateError,
      })
    }
  }
  try {
    await settleInbox(t, stop)
  } catch (inboxError) {
    t.rt.log.warn('eharness: settling the inbox at the end of the turn failed', {
      error: inboxError,
    })
  }
  return { turnResult, stop }
}

/**
 * The guarded end-of-turn write found the stored state owned by another instance (it recovered
 * this turn as stale): its state wins, ours is reloaded (spec 05 §9.1).
 */
export async function lostState(t: TurnCtx): Promise<void> {
  t.rt.log.warn(
    'eharness: end-of-turn state write skipped: another instance owns the session state',
  )
  try {
    await t.rt.state.load()
  } catch (loadError) {
    t.rt.log.warn('eharness: reloading the session state failed; the cache was discarded', {
      error: loadError,
    })
    t.rt.state.discard()
  }
  t.rt.view = undefined
}
