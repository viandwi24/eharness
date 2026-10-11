import type { ModelMessage } from 'ai'
import { createTurnCompaction } from '../../compaction/turn-context.ts'
import { currentTurnStartId } from '../../compaction/turns.ts'
import { hookFailed, runHook } from '../../internal/hook-run.ts'
import { describeModel } from '../../internal/model.ts'
import { unref } from '../../internal/util.ts'
import type { LoopResult } from '../../loop/step-ctx.ts'
import { runSteps } from '../../loop/steps.ts'
import { costOf } from '../../models/cost.ts'
import type { TurnRegistry } from '../../registry/turn.ts'
import { toTurnError } from '../../stream/describe-error.ts'
import { commit, continuationOptions } from './commit.ts'
import {
  DEFAULT_MAX_IDLE_CONTINUES,
  DEFAULT_MAX_STEPS,
  type Outcome,
  type Prepared,
  type TurnCtx,
} from './ctx.ts'
import { heartbeat } from './heartbeat.ts'
import { budgetOverrun, seedDiscovered, withoutUndefined } from './helpers.ts'
import { settleOpInbox } from './inbox.ts'
import { barrier, earlyEnd, validOutput, write, writeEnd, writeStart } from './output.ts'
import { prepare } from './prepare.ts'

// ─── execute ──────────────────────────────────────────────────────────────────────────────
export async function body(t: TurnCtx): Promise<void> {
  let prep: Prepared
  try {
    prep = await prepare(t)
  } catch (error) {
    earlyEnd(t, 'error', error)
    return
  }
  if (prep.kind === 'aborted') return earlyEnd(t, 'aborted')
  if (prep.kind === 'blocked') return earlyEnd(t, 'blocked')
  if (prep.kind === 'partial') {
    writeStart(t, t.rt.agent.generateId(), undefined) // throwaway id, never stored
    t.outcome = {
      stop: 'tool-pending',
      steps: 0,
      model: t.info.model,
      pending: prep.pending,
      partial: true,
    }
    t.resolveAccepted(undefined)
    return writeEnd(t)
  }

  try {
    await commit(t, prep)
    t.resolveAccepted(undefined)
  } catch (error) {
    if (!t.committed) return earlyEnd(t, 'error', error)
    // committed but not applied: the items are tried again (dedupe skips a saved user message)
    if (t.op.inbox !== undefined && !t.inboxSettled) settleOpInbox(t, { how: 'retry', error })
    if (!t.startWritten)
      writeStart(t, t.assistantId ?? t.rt.agent.generateId(), undefined, t.plan === undefined)
    t.outcome = { stop: 'error', steps: 0, model: t.info.model, error: toTurnError(error, t.log) }
    write(t, { type: 'error', errorText: t.outcome.error?.message ?? '' })
    return writeEnd(t)
  }
  if (t.plan !== undefined) {
    // continuation: stream into A' (spec 04 §2); client outputs first, approved calls are open
    writeStart(t, t.plan.pending.messageId, undefined, false)
    // every answered approval first: a reader that rebuilds the message from the stream
    // (readUIMessageStream, attach(), a non-useChat UI) sees `approval-responded` before the
    // approved calls run, instead of `approval-requested` until their output arrives (spec 04 §2)
    // Only approvals consumed by this continuation: deferred calls (granted, waiting for client
    // outputs or external waits of their batch) keep `approval-requested` in storage, and parked
    // calls lost their approval in the patch. The id is the one on the stored part.
    for (const answer of t.plan.approvals) {
      if (t.parkedCalls.has(answer.toolCallId) || t.deferredCalls.has(answer.toolCallId)) continue
      const part = t.baseMessage?.parts.find(
        (p) => (p as { toolCallId?: string }).toolCallId === answer.toolCallId,
      ) as { approval?: { id?: string } } | undefined
      const approvalId = part?.approval?.id
      if (approvalId === undefined) continue
      write(t, {
        type: 'tool-approval-response',
        approvalId,
        approved: answer.approved,
        ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
      })
    }
    for (const answer of t.clientOutputs) {
      write(
        t,
        'errorText' in answer
          ? {
              type: 'tool-output-error',
              toolCallId: answer.toolCallId,
              errorText: answer.errorText,
            }
          : {
              type: 'tool-output-available',
              toolCallId: answer.toolCallId,
              output: answer.output,
            },
      )
    }
    for (const answer of t.plan.approvals) {
      if (t.parkedCalls.has(answer.toolCallId) || t.deferredCalls.has(answer.toolCallId)) continue
      t.openCalls.add(answer.toolCallId)
    }
    // approved client-tool calls are open for the client again (not answered by the server)
    for (const toolCallId of t.parkedCalls) {
      const part = t.baseMessage?.parts.find(
        (p) => (p as { toolCallId?: string }).toolCallId === toolCallId,
      ) as { type: string; toolName?: string; input?: unknown } | undefined
      if (part === undefined) continue
      write(t, {
        type: 'tool-input-available',
        toolCallId,
        toolName: part.toolName ?? part.type.replace(/^tool-/, ''),
        input: part.input ?? {},
        ...(part.type === 'dynamic-tool' ? { dynamic: true } : {}),
      })
    }
  }
  if (prep.blockNotice !== undefined) {
    t.outcome = { stop: 'blocked', steps: 0, model: t.info.model }
    return writeEnd(t)
  }
  t.rt.events.emit({
    type: 'turn-start',
    turnId: t.turnId,
    messageId: t.assistantId ?? '',
    kind: t.op.kind,
    queued: t.op.queued,
  })
  if (t.recovery) {
    const tick = t.abortPollMs > 0 ? Math.min(t.staleMs / 4, t.abortPollMs) : t.staleMs / 4
    t.heartbeatTimer = setInterval(() => void heartbeat(t), Math.max(1, tick))
    unref(t.heartbeatTimer)
  }

  const open = prep.open
  for (const hook of open.hooks.list('turn.start')) {
    try {
      await runHook(
        () => hook.fn(t.rt.contextOf(hook.owner), { kind: t.op.kind, input: t.info.input }),
        {
          hook: 'turn.start',
          owner: hook.owner,
          timeoutMs: t.hookTimeoutMs,
          signal: t.controller.signal,
        },
      )
    } catch (error) {
      hookFailed(t.rt, 'turn.start', hook.owner, error)
    }
  }
  const registry = prep.registry as TurnRegistry
  if (t.parkedPending !== undefined) {
    // the approved calls are the client's to run: no model step until it answers (spec 11 §5)
    t.outcome = {
      stop: 'tool-pending',
      steps: 0,
      model: t.info.model,
      pending: structuredClone(t.parkedPending),
    }
    return writeEnd(t)
  }
  try {
    const view = t.rt.view ?? []
    const messageId = t.assistantId as string
    const compaction = createTurnCompaction({
      engine: t.host.compaction,
      rt: t.rt,
      turnId: t.turnId,
      assistantId: messageId,
      currentStartId: currentTurnStartId(
        view,
        t.op.kind === 'respond'
          ? { kind: 'respond', messageId }
          : t.op.kind === 'regenerate'
            ? { kind: 'regenerate', assistantId: messageId }
            : prep.user === undefined
              ? { kind: 'no-input', assistantId: messageId }
              : { kind: 'input', userMessageId: prep.user.id },
        t.rt.agent.messages,
      ),
      info: t.info,
      registry,
      write: (chunk) => write(t, chunk),
      signal: t.controller.signal,
      pending: null,
      // A' is cached: its approval-responded parts project to the trailing approval message
      ...(t.op.kind === 'respond' ? { continuing: messageId } : {}),
      inboxed: t.inboxed,
      // summarizer usage is turn usage: counted in TurnResult.usage, cost and budgets
      toolsContext: prep.toolsContext,
      onUsage: (value, model, source) => {
        if (t.config.budget !== undefined && costOf(t.config.models, model, value) === undefined) {
          t.rt.warn(
            {
              code: 'W_MODEL_UNPRICED',
              message: `No pricing for model '${describeModel(model)}' in \`models\`; its usage does not count toward the budget.`,
              details: { model: describeModel(model) },
            },
            `unpriced:${describeModel(model)}`,
          )
        }
        t.info.addUsage(value, { model, source })
      },
      overBudget: () =>
        budgetOverrun(t.config.budget, t.usage.costUsd ?? 0, t.rt.state.core().usage?.costUsd ?? 0),
    })
    // pre-turn compaction check (spec 05 §3 step 14, spec 06 §4)
    const built = await compaction.preTurn(await compaction.build())
    const wire: ModelMessage[] = built.wire
    const result: LoopResult = await runSteps({
      rt: t.rt,
      registry,
      info: t.info,
      wire,
      turnStart: built.turnStart,
      messageId,
      activeTools: prep.activeTools,
      maxSteps: t.op.options.maxSteps ?? t.config.loop?.maxSteps ?? DEFAULT_MAX_STEPS,
      maxContinues: t.config.loop?.maxContinues ?? Number.POSITIVE_INFINITY,
      maxIdleContinues: t.config.loop?.maxIdleContinues ?? DEFAULT_MAX_IDLE_CONTINUES,
      maxOutputTokens: t.config.loop?.maxTurnOutputTokens ?? Number.POSITIVE_INFINITY,
      wrapUp: t.config.loop?.wrapUp ?? true,
      progress: t.config.loop?.progress,
      models: t.config.models,
      budget: t.config.budget,
      sessionCostBefore: t.rt.state.core().usage?.costUsd ?? 0,
      ledger: t.ledger,
      toolsContext: prep.toolsContext,
      cache: t.config.cache,
      signal: t.controller.signal,
      timedOut: () => t.timedOut,
      write: (chunk) => write(t, chunk),
      barrier: () => barrier(t),
      usage: t.usage,
      discovered: seedDiscovered(view),
      heartbeat: () => heartbeat(t),
      compaction,
      continuation: t.op.kind === 'respond',
      ...continuationOptions(t),
      inbox: t.inbox,
      delivered: (item) => {
        item.settle?.('step')
        if (item.inboxId !== undefined) {
          // dedupe of a redelivery reads `inboxId` of the saved data-eh.input part (spec 05 §12
          // rule 5): nothing goes to the state before that snapshot is durable
          t.deliveredSteers.push({
            inboxId: item.inboxId,
            afterFinish: t.finishStepsWritten,
            done: false,
          })
        }
        if (item.event !== undefined) {
          t.deliveredEvents.push({
            message: item.event,
            afterFinish: t.finishStepsWritten,
            done: false,
          })
        }
      },
      ...(t.turnOutput === undefined ? {} : { output: t.turnOutput }),
    })
    t.outcome = withoutUndefined({ ...result }) as Outcome
    const answer = validOutput(t)
    if (answer !== undefined && t.turnOutput !== undefined) {
      // the audit record of the answer (persistent, never projected; spec 03 §4.3)
      write(t, {
        type: 'data-eh.output',
        id: 'output',
        data: {
          value: structuredClone(answer.value),
          mode: t.turnOutput.mode,
          attempts: t.turnOutput.state.failures + 1,
        },
      })
    }
  } catch (error) {
    t.outcome = {
      stop: 'error',
      steps: t.outcome.steps,
      model: t.info.model,
      error: toTurnError(error, t.log),
    }
    write(t, { type: 'error', errorText: t.outcome.error?.message ?? '' })
  }
  // release an open reservation, record the last nested usage (spec 12 §4.1); never throws
  await t.ledger?.end()
  writeEnd(t)
}
