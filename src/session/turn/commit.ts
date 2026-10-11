import type { UIMessage } from 'ai'
import { HarnessError } from '../../errors.ts'
import type { runSteps } from '../../loop/steps.ts'
import { waitIdOf } from '../../loop/stop.ts'
import { clientToolEntry } from '../../messages/pending-state.ts'
import { DENIED_NEW_INPUT, INTERRUPTED_CRASH, WAIT_TIMED_OUT } from '../../messages/texts.ts'
import { answerDanglingToolParts } from '../../messages/tool-parts.ts'
import type { HarnessUIMessage, PendingState } from '../../messages/types.ts'
import { armExternals } from '../../registry/external.ts'
import type { ToolOutputSink } from '../../registry/output-limits.ts'
import type { TurnRegistry } from '../../registry/turn.ts'
import { finishToolOutput, grantKeyOf, reportDecision } from '../../registry/wrap.ts'
import { approvalNoteData } from '../interaction/notes.ts'
import { patchForNewInput, patchForRespond, type RespondPlan } from '../interaction/pending.ts'
import { hiddenByRewind } from '../load-context.ts'
import { registerLocalTurn } from '../local-turns.ts'
import { recoverInterruptedTurn } from '../recover.ts'
import { createAbortPoll } from '../remote-abort.ts'
import type { OpenSession } from '../runtime.ts'
import type { Prepared, TurnCtx } from './ctx.ts'
import { withoutUndefined } from './helpers.ts'
import { settleOpInbox } from './inbox.ts'
import { abortFromRequest } from './output.ts'

/**
 * Approved calls of tools without `execute` park as client calls instead of running a step
 * (spec 11 §5): the new pending state holds them (with the request-scoped timeout fields) and
 * the approved server calls of the same batch, which keep waiting for it.
 */
export function planParking(t: TurnCtx, registry: TurnRegistry): void {
  if (t.plan === undefined) return
  const parked = t.plan.approvals.filter((a) => a.approved && registry.clientTools.has(a.toolName))
  if (parked.length === 0) return
  const next: PendingState = {
    v: 2,
    messageId: t.plan.pending.messageId,
    approvals: [],
    clientTools: [],
  }
  for (const answer of parked) {
    if (registry.externals.has(answer.toolName)) {
      // an approved external call parks its wait like an unapproved one (spec 11 §4.2); `start`
      // runs after this pending state is committed
      next.externals ??= []
      next.externals.push({
        waitId: waitIdOf(answer.toolCallId),
        toolCallId: answer.toolCallId,
        toolName: answer.toolName,
        onTimeout: { errorText: WAIT_TIMED_OUT },
      })
      t.parkedCalls.add(answer.toolCallId)
      continue
    }
    const call = clientToolEntry(
      answer.toolCallId,
      answer.toolName,
      t.plan.pending.approvals.find((a) => a.approvalId === answer.approvalId)?.input,
    )
    const meta = registry.requestTools.get(answer.toolName)
    if (meta?.timeoutMs !== undefined) {
      call.waitId = waitIdOf(answer.toolCallId)
      call.timeoutAt = Date.now() + meta.timeoutMs
      call.onTimeout = structuredClone(meta.onTimeout)
    }
    next.clientTools.push(call)
    t.parkedCalls.add(answer.toolCallId)
  }
  // approved calls that would run on the server wait until the client answered (one step runs
  // after every call is answered); the answers are given again with the client output
  for (const answer of t.plan.approvals) {
    if (!answer.approved || t.parkedCalls.has(answer.toolCallId)) continue
    const entry = t.plan.pending.approvals.find((a) => a.approvalId === answer.approvalId)
    if (entry === undefined) continue
    // `granted`: the human said yes already; the continuation needs no second answer
    next.approvals.push({ ...structuredClone(entry), granted: true })
    t.deferredCalls.add(answer.toolCallId)
  }
  if (next.externals !== undefined) armExternals(next, { externals: registry.externals })
  t.parkedPending = next
}

// ─── commit point (spec 05 §3 steps 11–12) ────────────────────────────────────────────────
export async function commit(t: TurnCtx, prep: Extract<Prepared, { kind: 'turn' }>): Promise<void> {
  const core = t.rt.state.core()
  // the core fields this commit changes, as they were: put back if its write fails, so a later
  // writeIfDirty (close, idle eviction) never publishes a turn that did not commit
  const before = {
    activeTurn: structuredClone(core.activeTurn),
    pending: structuredClone(core.pending),
    grants: structuredClone(core.grants),
    rewinds: structuredClone(core.rewinds),
    abortRequest: structuredClone(core.abortRequest),
    inboxDelivered: structuredClone(core.inboxDelivered),
  }
  const undo = () => {
    for (const key of [
      'activeTurn',
      'pending',
      'grants',
      'rewinds',
      'abortRequest',
      'inboxDelivered',
    ] as const) {
      if (before[key] === undefined) delete core[key]
      else (core as Record<string, unknown>)[key] = before[key]
    }
  }
  let needWrite = t.rt.state.dirty
  // an abort request never names the new turn: it is stale (spec 05 §9.1 rule 6)
  if (core.abortRequest !== undefined) {
    delete core.abortRequest
    needWrite = true
  }
  if (prep.stale !== undefined) {
    delete core.activeTurn
    needWrite = true
  }
  if (t.recovery && t.assistantId !== undefined) {
    const now = Date.now()
    registerLocalTurn(t.rt, t.turnId)
    core.activeTurn = withoutUndefined({
      turnId: t.turnId,
      kind: t.op.kind,
      messageId: t.assistantId,
      userMessageId: prep.user?.id,
      owner: t.rt.owner,
      startedAt: now,
      heartbeatAt: now,
    })
    needWrite = true
  }
  // consume (respond) or deny (new input) the pending state in the same write (spec 11 §4, §4.1)
  if (t.plan !== undefined) planParking(t, prep.registry as TurnRegistry)
  if ((t.plan !== undefined || t.denyPending !== undefined) && core.pending !== undefined) {
    // approved client-tool calls park in the same compare-and-set write that consumes the
    // approvals: exactly once, never executed server-side (spec 11 §5)
    if (t.parkedPending !== undefined) core.pending = structuredClone(t.parkedPending)
    else delete core.pending
    needWrite = true
  }
  if (t.plan !== undefined) {
    const remembered = t.plan.approvals.filter((a) => a.remember === 'session')
    if (remembered.length > 0) {
      t.grantsBefore = core.grants === undefined ? undefined : { ...core.grants }
      core.grants = { ...(core.grants ?? {}) }
      for (const a of remembered) {
        // a `tool.grantScope` hook may scope the grant to part of the input, or refuse it (§3.1)
        const key =
          t.rt.open === undefined
            ? a.toolName
            : await grantKeyOf(
                {
                  hooks: t.rt.open.hooks,
                  contextOf: t.rt.contextOf,
                  warn: t.rt.warn,
                  hookTimeoutMs: t.hookTimeoutMs,
                },
                a.toolName,
                t.plan.pending.approvals.find((p) => p.approvalId === a.approvalId)?.input,
              )
        if (key !== null) core.grants[key] = a.approved ? 'always' : 'never'
      }
      t.grantsRecorded = true
      needWrite = true
    }
  }
  // inbox items of a send turn: dedupe of redeliveries reads `inboxId` / `collected` of the
  // saved user message; a wake turn records its ids once its effect is saved (onEnd), so
  // nothing about them is written here (spec 05 §12 rule 5)
  if (t.rewind !== undefined) {
    const payload = t.rewind.parts[0] as { data: { afterId: string | null } }
    core.rewinds = [
      ...(core.rewinds ?? []),
      { afterId: payload.data.afterId, rewindId: t.rewind.id },
    ]
    needWrite = true
  }
  if (needWrite) {
    t.rt.state.markDirty()
    let ok: boolean
    try {
      ok = await t.rt.state.write({ cas: true })
    } catch (error) {
      undo()
      t.rt.view = undefined // force a reload of state and messages at the next operation
      throw error
    }
    if (!ok) {
      // another instance owns the stored state now: drop ours (never overwrite theirs later)
      undo()
      t.stateCheckpoint = undefined // the reloaded state is not ours to revert
      try {
        await t.rt.state.load()
      } catch (loadError) {
        t.rt.log.warn('eharness: reloading the session state failed; the cache was discarded', {
          error: loadError,
        })
        t.rt.state.discard()
      }
      t.rt.view = undefined
      throw new HarnessError(
        'EH_SESSION_BUSY',
        'The session state was changed by another instance.',
      )
    }
  }
  t.committed = true
  t.streamLog?.start()
  if (t.recovery) {
    // owner writes keep a foreign abort request (spec 05 §9.1 rule 4); a merged one aborts
    t.rt.state.guard(t.turnId, (request) => abortFromRequest(t, request.reason))
    if (t.abortPollMs > 0) {
      t.abortPoll = createAbortPoll({
        turnId: t.turnId,
        intervalMs: t.abortPollMs,
        peek: () => t.rt.state.peek(),
        abort: (request) => abortFromRequest(t, request.reason),
        done: () => t.ended || t.controller.signal.aborted,
        onError: (error) => t.rt.log.warn('eharness: abort poll state read failed', { error }),
      })
    }
  }
  await reportAnswers(t, prep.open)

  // crash recovery of a stale turn (spec 05 §9)
  const stale = prep.stale
  if (stale !== undefined) {
    t.created.push(
      ...(await recoverInterruptedTurn(t.rt, t.host.persist, stale, {
        ...(prep.recoveryNoticeId === undefined ? {} : { noticeId: prep.recoveryNoticeId }),
        startedAt: t.startedAt,
      })),
    )
  }
  await healOrphanPending(t)
  // the pending message: patched for the continuation (respond) or denied (new input)
  if (t.plan !== undefined) {
    await continuePending(t, prep.open, t.plan)
    // results answered here (not recorded before) resolve their waits now
    for (const e of t.plan.externals) {
      if (!e.recorded) t.rt.events.emit({ type: 'wait-resolved', waitId: e.waitId, by: 'result' })
    }
  }
  if (t.denyPending !== undefined) {
    const pending = t.denyPending
    const message = t.rt.view?.find((m) => m.id === pending.messageId)
    if (message !== undefined) await t.host.persist([patchForNewInput(message, pending)])
    t.rt.events.emit({ type: 'pending', pending: null })
    for (const e of pending.externals ?? []) {
      if (e.result === undefined) {
        t.rt.events.emit({ type: 'wait-resolved', waitId: e.waitId, by: 'cancel' })
      }
    }
  }
  if (t.rewind !== undefined) {
    try {
      t.created.push(...(await t.host.persist([t.rewind])))
    } catch (markerError) {
      // the marker is not stored: its entry in `core.rewinds` would hide history for nothing
      const ghost = t.rewind.id
      const entries = t.rt.state.core().rewinds
      if (entries !== undefined) {
        const kept = entries.filter((e) => e.rewindId !== ghost)
        if (kept.length === 0) delete t.rt.state.core().rewinds
        else t.rt.state.core().rewinds = kept
        t.rt.state.markDirty()
        try {
          await t.rt.state.writeIfDirty()
        } catch (undoError) {
          t.rt.log.warn('eharness: removing the rewind entry of an unsaved marker failed', {
            error: undoError,
          })
        }
      }
      t.rt.view = undefined
      throw markerError
    }
    const marker = t.rewind
    const hidden = [{ afterId: afterIdOf(t, marker), rewindId: marker.id }]
    if (t.rt.view !== undefined) {
      t.rt.view = t.rt.view.filter((m) => !hiddenByRewind(m, hidden, t.rt.agent.messages))
    }
  }
  if (prep.user !== undefined) t.created.push(...(await t.host.persist([prep.user])))
  if (prep.blockNotice !== undefined) t.created.push(...(await t.host.persist([prep.blockNotice])))
  t.createdBeforeAssistant = t.created.length
  // the user message is durable: the inbox items are applied (a durable wake: at the end)
  if (!t.wakeFromInbox) settleOpInbox(t, 'applied')
}

/**
 * A message still marked pending (`metadata.eharness.pending`) although `state.core.pending` no
 * longer names it: a process died between the state write that consumed / denied the pending
 * state and the save of the patched message. Its calls never ran: answer them with
 * `INTERRUPTED_CRASH` and mark the message resolved (spec 05 §9, spec 11 §8).
 */
export async function healOrphanPending(t: TurnCtx): Promise<void> {
  const handled = new Set<string | undefined>([
    t.plan?.pending.messageId,
    t.denyPending?.messageId,
    t.rt.state.core().pending?.messageId,
  ])
  const orphans = (t.rt.view ?? []).filter((m) => {
    const pending = m.metadata?.eharness?.pending
    return m.role === 'assistant' && pending !== undefined && pending !== null && !handled.has(m.id)
  })
  for (const message of orphans) {
    const patched = answerDanglingToolParts(structuredClone(message), INTERRUPTED_CRASH)
    const eharness = patched.metadata?.eharness
    if (eharness === undefined) continue
    const stop =
      eharness.stop === undefined || eharness.stop === 'tool-pending'
        ? 'interrupted'
        : eharness.stop
    await t.host.persist([
      {
        ...patched,
        metadata: { ...patched.metadata, eharness: { ...eharness, pending: null, stop } },
      },
    ])
  }
}

export function afterIdOf(_t: TurnCtx, marker: HarnessUIMessage): string | null {
  return (marker.parts[0] as { data: { afterId: string | null } }).data.afterId
}

/**
 * Build and save A' (spec 11 §4 step 3): client tool outputs pass through `tool.after` and the
 * output limits (spec 09 §6), then approval / client parts are patched and `pending` set to
 * null. A' becomes the stream's `originalMessages` (the continuation streams into it).
 */
/** `approval.decided` for respond() answers and new-input denials (spec 11 §3.3), after commit. */
export async function reportAnswers(t: TurnCtx, open: OpenSession): Promise<void> {
  const deps = {
    hooks: open.hooks,
    contextOf: t.rt.contextOf,
    warn: t.rt.warn,
    hookTimeoutMs: t.hookTimeoutMs,
  }
  if (open.hooks.list('approval.decided').length === 0) return
  const pendingOf = (pending: PendingState | undefined, id: string) =>
    pending?.approvals.find((a) => a.approvalId === id)
  for (const answer of t.plan?.approvals ?? []) {
    if (t.deferredCalls.has(answer.toolCallId)) continue // reported when it is answered for good
    const entry = pendingOf(t.plan?.pending, answer.approvalId)
    await reportDecision(
      deps,
      withoutUndefined({
        toolName: answer.toolName,
        toolCallId: answer.toolCallId,
        input: entry?.input,
        risk: entry?.risk,
        idempotent: entry?.idempotent,
        approved: answer.approved,
        by: 'user' as const,
        reason: answer.reason,
        actor: answer.actor,
        approvalId: answer.approvalId,
        remember: answer.remember,
      }),
    )
  }
  for (const entry of t.denyPending?.approvals ?? []) {
    await reportDecision(
      deps,
      withoutUndefined({
        toolName: entry.toolName,
        toolCallId: entry.toolCallId,
        input: entry.input,
        risk: entry.risk,
        idempotent: entry.idempotent,
        approved: false,
        by: 'new-input' as const,
        reason: DENIED_NEW_INPUT,
        approvalId: entry.approvalId,
      }),
    )
  }
}

export async function continuePending(
  t: TurnCtx,
  open: OpenSession,
  answers: RespondPlan,
): Promise<void> {
  const message = t.rt.view?.find((m) => m.id === answers.pending.messageId)
  if (message === undefined) {
    throw new HarnessError('EH_INVALID_INPUT', 'The pending message is no longer stored.', {
      details: { reason: 'stale', messageId: answers.pending.messageId },
    })
  }
  // if anything below fails, the turn still ends on A (its answered calls become interrupted)
  t.baseMessage = structuredClone(message)
  t.original = [t.baseMessage as UIMessage]
  t.rt.events.emit({ type: 'pending', pending: null })
  const deps = {
    hooks: open.hooks,
    hookTimeoutMs: t.hookTimeoutMs,
    contextOf: t.rt.contextOf,
    warn: t.rt.warn,
    status: () => {},
    limits: {
      config: t.config.toolOutput,
      toolOutputs: open.services.get('toolOutputs') as ToolOutputSink | undefined,
    },
  }
  t.clientOutputs = []
  for (const answer of answers.toolOutputs) {
    // errors and recorded external results (already through tool.after / limits) are final
    if ('errorText' in answer || answer.finished === true) {
      t.clientOutputs.push(answer)
      continue
    }
    const part = message.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === answer.toolCallId,
    ) as { input?: unknown } | undefined
    const output = await finishToolOutput(
      answer.toolName,
      answer.toolCallId,
      part?.input,
      answer.output,
      deps,
    )
    t.clientOutputs.push({ ...answer, output })
  }
  const patched = patchForRespond(
    message,
    answers.approvals.filter((a) => !t.deferredCalls.has(a.toolCallId)),
    t.clientOutputs,
    t.parkedCalls,
  )
  t.baseMessage = patched
  t.original = [patched as UIMessage]
  const [saved] = await t.host.persist([patched])
  if (saved !== undefined) {
    t.baseMessage = saved
    t.original = [saved as UIMessage]
  }
}

/**
 * What the step loop needs to know about the `respond()` that started this continuation:
 * the answered tool names (`step.prepare`, spec 01 §5), the notes of approved calls (spec 11
 * §3.4) and `endTurn` (spec 11 §4).
 */
export function continuationOptions(
  t: TurnCtx,
): Pick<Parameters<typeof runSteps>[0], 'continuing' | 'approvalNotes' | 'endAfterContinuation'> {
  if (t.plan === undefined) return {}
  const names = (approved: boolean) => [
    ...new Set(t.plan?.approvals.filter((a) => a.approved === approved).map((a) => a.toolName)),
  ]
  const notes = t.plan.approvals.flatMap((a) =>
    a.approved && a.note !== undefined ? [approvalNoteData(a)] : [],
  )
  const endTurn = t.op.options.endTurn
  const end =
    endTurn === 'after-answers' ||
    (endTurn === 'if-denied' && t.plan.approvals.some((a) => !a.approved))
  return {
    continuing: { approved: names(true), denied: names(false) },
    ...(notes.length === 0 ? {} : { approvalNotes: notes }),
    ...(end ? { endAfterContinuation: true } : {}),
  }
}
