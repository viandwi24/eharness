/**
 * The turn lifecycle (internal): preparation (nothing persisted), commit point, step loop and
 * the end sequence in `onEnd`.
 *
 * @see docs/specs/05-session-and-storage.md#3-turn-lifecycle-normative-order
 * @see docs/specs/04-streaming.md#2-turn-stream-structure
 */
import type { UIMessage } from 'ai'
import { hookTimeoutOf } from '../internal/hook-run.ts'
import { unref } from '../internal/util.ts'
import { createTurnLedger, DEFAULT_RESERVATION_TTL_MS } from '../loop/ledger.ts'
import { mergeSettings } from '../loop/step-settings.ts'
import { addUsage, emptyUsage, normalizeUsage } from '../loop/usage.ts'
import type { TurnResult } from '../messages/types.ts'
import { costOf } from '../models/cost.ts'
import type { TurnSource } from '../plugin/types.ts'
import { type TurnError, toTurnError } from '../stream/describe-error.ts'
import { createStreamLogWriter, resolveStreamLogOptions } from '../stream/log-writer.ts'
import { createRun, createTurnBuffer } from '../stream/run.ts'
import { createTurnInputQueue, type PendingInput } from './interaction/inbox.ts'
import { DEFAULT_ABORT_POLL_MS } from './remote-abort.ts'
import { body } from './turn/body.ts'
import {
  DEFAULT_STALE_MS,
  type RunningTurn,
  type TurnCtx,
  type TurnHost,
  type TurnOperation,
} from './turn/ctx.ts'
import { withoutUndefined } from './turn/helpers.ts'
import { closeBuffer, write, writeEnd, writeStart } from './turn/output.ts'
import { inputSubmit } from './turn/prepare.ts'
import { openStream } from './turn/stream.ts'

/**
 * Start a turn. The caller has checked and set the running flag. Returns immediately; the turn
 * runs inside the stream's `execute`, the end sequence in `onEnd`.
 */
export function startTurn(host: TurnHost, op: TurnOperation): RunningTurn {
  const t = { host, op } as TurnCtx
  t.openStream = () => openStream(t)
  t.rt = host.rt
  t.config = t.rt.agent.config
  t.hookTimeoutMs = hookTimeoutOf(t.config)
  t.log = (m: string, d?: Record<string, unknown>) => t.rt.log.error(m, d)
  t.turnId = t.op.turnId ?? t.rt.agent.generateId()
  t.startedAt = Date.now()
  t.recovery = t.config.recovery !== false
  t.staleMs =
    (t.config.recovery === false ? undefined : t.config.recovery?.staleMs) ?? DEFAULT_STALE_MS
  // cross-process abort (spec 05 §9.1): only an adapter with setIf can carry a request
  t.abortPollMs =
    t.config.recovery === false || !t.rt.state.canCas
      ? 0
      : (t.config.recovery?.abortPollMs ?? DEFAULT_ABORT_POLL_MS)
  t.controller = new AbortController()
  t.timedOut = false
  t.external = t.op.options.abortSignal
  t.onExternalAbort = () => t.controller.abort(t.external?.reason ?? 'aborted')
  if (t.external?.aborted) t.onExternalAbort()
  else t.external?.addEventListener('abort', t.onExternalAbort, { once: true })
  t.timeoutMs = t.config.loop?.turnTimeoutMs
  if (t.timeoutMs !== undefined && t.timeoutMs > 0) {
    t.turnTimer = setTimeout(() => {
      t.timedOut = true
      t.controller.abort('timeout')
    }, t.timeoutMs)
    unref(t.turnTimer)
  }
  t.buffer = createTurnBuffer()
  t.streamLog =
    t.rt.streams === undefined
      ? undefined
      : createStreamLogWriter({
          adapter: t.rt.streams,
          key: { sessionId: t.rt.id, turnId: t.turnId },
          buffer: t.buffer,
          options: resolveStreamLogOptions(t.config.streams),
          warn: (warning, key) => t.rt.warn(warning, key),
        })
  t.startWritten = false
  t.committed = false
  t.outcome = { stop: 'error', steps: 0, model: t.config.model }
  t.created = []
  t.createdBeforeAssistant = 0
  t.usage = emptyUsage()
  t.ledgerConfig = t.config.budget?.ledger
  t.ledger =
    t.ledgerConfig === undefined
      ? undefined
      : createTurnLedger({
          config: t.ledgerConfig,
          models: t.config.models,
          sessionId: t.rt.id,
          turnId: t.turnId,
          ttlMs:
            t.ledgerConfig.reservationTtlMs ??
            (t.timeoutMs !== undefined && t.timeoutMs > 0
              ? t.timeoutMs
              : DEFAULT_RESERVATION_TTL_MS),
          ctx: () => t.rt.contextOf('app'),
          warn: (warning, key) => t.rt.warn(warning, key),
        })
  // ─── interaction state (spec 11) ──────────────────────────────────────────────────────────
  t.inbox = createTurnInputQueue()
  t.parkedCalls = new Set<string>()
  t.deferredCalls = new Set<string>()
  t.clientOutputs = []
  t.deliveredEvents = []
  t.deliveredSteers = []
  t.steerIds = new Set<string>()
  t.wakeFromInbox = t.op.kind === 'wake' && t.op.inbox?.durable === true
  t.inboxSettled = false
  t.inboxed = new Set<string>()
  t.grantsRecorded = false
  t.preStart = []
  t.finishStepsWritten = 0
  t.stepEndsDone = 0
  t.drained = false
  t.messageId = new Promise<string>((resolve) => {
    t.resolveMessageId = resolve
  })
  t.result = new Promise<TurnResult<UIMessage>>((resolve) => {
    t.resolveResult = resolve
  })
  t.accepted = new Promise<TurnError | undefined>((resolve) => {
    t.resolveAccepted = resolve
  })
  t.info = {
    id: t.turnId,
    kind: t.op.kind,
    queued: t.op.queued,
    input: undefined,
    ...(t.op.inbox === undefined ? {} : inboxSource(t.op.inbox)),
    options: t.op.options.options,
    model: t.op.options.model ?? t.config.model,
    settings: mergeSettings(t.config.settings ?? {}, t.op.options.settings),
    abortSignal: t.controller.signal,
    addUsage: (input, source) => {
      const options = typeof source === 'object' && source !== null ? source : {}
      const value = normalizeUsage(input)
      const plainCost = (input as { costUsd?: unknown }).costUsd
      const cost =
        typeof options.costUsd === 'number'
          ? options.costUsd
          : typeof plainCost === 'number'
            ? plainCost
            : options.model === undefined
              ? undefined
              : costOf(t.config.models, options.model, value)
      addUsage(t.usage, value, true, cost)
      // priced nested usage reaches the ledger at the next step boundary (spec 12 §4.1 rule 3)
      if (cost !== undefined && t.turnState.active) t.ledger?.nested(cost)
    },
  }
  t.turnState = {
    info: t.info,
    step: undefined,
    runtime: { ...(t.rt.options.runtime ?? {}), ...(t.op.options.runtime ?? {}) },
    active: true,
    write: (chunk) => write(t, chunk),
  }
  t.rt.turn = t.turnState
  t.openCalls = new Set<string>()
  t.interrupted = new Set<string>()
  // ─── plugin state set by this turn before its commit point ───────────────────────────────
  t.touched = new Map<string, { plugin: string; key: string }>()
  t.preparing = new Map<string, number>()
  t.stopObserving = t.rt.state.observe((plugin, key) => {
    if (!t.committed && t.preparing.has(plugin))
      t.touched.set(`${plugin}\u0000${key}`, { plugin, key })
  })
  t.heartbeatInFlight = false
  // ─── end sequence (spec 05 §3 step 17) ────────────────────────────────────────────────────
  t.ended = false
  t.rt.events.emit({ type: 'status', running: true })
  void (async () => {
    try {
      await body(t)
    } catch (error) {
      // defensive: body() handles its own errors
      t.rt.log.error('eharness: unexpected turn failure', { error })
      if (!t.startWritten) writeStart(t, t.rt.agent.generateId(), undefined)
      t.outcome = {
        stop: 'error',
        steps: t.outcome.steps,
        model: t.info.model,
        error: toTurnError(error, t.log),
      }
      write(t, { type: 'error', errorText: t.outcome.error?.message ?? '' })
      writeEnd(t)
    } finally {
      t.turnState.active = false
      t.finishExecute?.()
      // no stream was opened (cannot happen: every path writes `start`): never leave readers hanging
      if (t.writer === undefined) closeBuffer(t)
    }
  })()
  t.abort = (reason?: string) => {
    if (!t.controller.signal.aborted) t.controller.abort(reason ?? 'aborted')
  }
  t.run = createRun<UIMessage>({
    turnId: t.turnId,
    kind: t.op.kind,
    messageId: t.messageId,
    stream: t.buffer.reader(),
    result: t.result,
    abort: t.abort,
    accepted: t.accepted,
  })
  return {
    run: t.run,
    buffer: t.buffer,
    abort: t.abort,
    steer(input, inboxId, settle) {
      if (!t.inbox.open || t.ended) return false
      // idempotent per inbox id: a redelivered steer this turn already holds is not delivered again
      if (inboxId !== undefined) {
        if (t.steerIds.has(inboxId)) return true
        t.steerIds.add(inboxId)
      }
      const text = input.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n')
      const pushed = t.inbox.push(
        (async (): Promise<PendingInput | undefined> => {
          const submitted = await inputSubmit(t, input, 'steer')
          if ('block' in submitted) {
            // a block drops only this input; the running turn continues (spec 11 §6.1)
            t.rt.events.emit(
              withoutUndefined({
                type: 'input-dropped' as const,
                reason: 'blocked' as const,
                text,
                clientId: input.clientId,
              }),
            )
            if (inboxId !== undefined) t.host.inboxNotApplied([inboxId], { how: 'drop' })
            settle?.('dropped')
            return undefined
          }
          const texts = submitted.input.parts.filter((p) => p.type === 'text').map((p) => p.text)
          const files = submitted.input.parts.filter((p) => p.type === 'file')
          return {
            data: withoutUndefined({
              source: 'user' as const,
              text: [...texts, ...submitted.contexts].join('\n\n'),
              files: files.length === 0 ? undefined : structuredClone(files),
              clientId: input.clientId,
              inboxId,
              app:
                submitted.input.app === undefined
                  ? undefined
                  : structuredClone(submitted.input.app),
            }),
            steer: { input: submitted.input, contexts: submitted.contexts, text },
            ...(inboxId === undefined ? {} : { inboxId }),
            ...(settle === undefined ? {} : { settle }),
          }
        })(),
      )
      if (!pushed && inboxId !== undefined) t.steerIds.delete(inboxId)
      return pushed
    },
    deliverEvent(message, text, wake) {
      if (!t.inbox.open || t.ended) return false
      t.inboxed.add(message.id)
      return t.inbox.push(
        Promise.resolve({
          data: { source: 'event', text },
          event: message,
          ...(wake === true ? { wake: true } : {}),
        }),
      )
    },
  }
}

/** `TurnInfo.source` of a turn made from inbox items (empty for a turn without any). */
function inboxSource(inbox: NonNullable<TurnOperation['inbox']>): { source?: TurnSource } {
  const first = inbox.ids[0]
  if (first === undefined) return {}
  const keys: string[] =
    'inboxId' in inbox.meta
      ? inbox.meta.key === undefined
        ? []
        : [inbox.meta.key]
      : inbox.meta.collected.flatMap((c) => (c.inboxKey === undefined ? [] : [c.inboxKey]))
  const key = keys[0]
  return {
    source: {
      kind: 'inbox',
      id: first,
      ids: [...inbox.ids],
      keys,
      ...(key === undefined ? {} : { key }),
    },
  }
}
