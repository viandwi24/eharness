/**
 * The live session (internal implementation of `HarnessSession`): open, hot cache, turn
 * operations, reads, events, close.
 *
 * @see docs/specs/05-session-and-storage.md#2-session-api
 */

import type { UIMessage } from 'ai'
import type {
  ForkOptions,
  HarnessRun,
  PendingResponse,
  SendInput,
  SendOptions,
} from '../agent/session-types.ts'
import { createSessionCompaction } from '../compaction/compact.ts'
import type { HarnessWarning } from '../errors.ts'
import { observeCount } from '../internal/observe.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import type { HarnessContext } from '../plugin/types.ts'
import { createContext, defaultLogger, safeLogger } from './context.ts'
import { createEventHub } from './events.ts'
import {
  apiBusy,
  apiChildren,
  apiEvents,
  apiExpireWaits,
  apiIdle,
  apiMessages,
  apiParentInfo,
  apiPendingWaits,
  apiResolveWait,
  apiStats,
  apiTools,
} from './handle/api-read.ts'
import { apiClearGrants, apiCompact, apiFork, apiRecover } from './handle/api-session.ts'
import {
  apiAbort,
  apiAttach,
  apiAttachRemote,
  apiEdit,
  apiEnqueue,
  apiInject,
  apiOnRun,
  apiReady,
  apiRegenerate,
  apiRespond,
  apiSend,
} from './handle/api-turns.ts'
import type { SessionCtx, SessionHandle, SessionHandleArgs } from './handle/ctx.ts'
import { holdWakeDurably, inboxWarning, notify } from './handle/inbox.ts'
import { ensureContext, ensureOpen, persist, reportInvariants } from './handle/open.ts'
import {
  checkCollect,
  checkIdle,
  close,
  dropQueue,
  enqueue,
  gateStep,
  releaseHeldQueue,
  startNext,
  startUnit,
  touch,
} from './handle/queue.ts'
import { createInboxDrain, DEFAULT_INBOX_POLL_MS } from './inbox/driver.ts'
import { createWaitOps } from './interaction/resolve.ts'
import { createRateLimitedWarn } from './rate-limit.ts'
import { DEFAULT_STALE_MS } from './remote-abort.ts'
import { createStateStore } from './state.ts'

/** Create a live session. */
export function createSessionHandle(args: SessionHandleArgs): SessionHandle {
  const s = { args } as SessionCtx
  s.internals = args.internals
  s.id = args.id
  s.config = s.internals.config
  s.log = safeLogger(s.config.logger ?? defaultLogger)
  s.closeController = new AbortController()
  s.sessionController = new AbortController()
  s.warnLimited = createRateLimitedWarn((message, data) =>
    s.log.warn(message, { sessionId: s.id, ...data }),
  )
  s.events = createEventHub({
    onOverflow: (info) => {
      observeCount(s.internals.observe, 'events.overflow', {
        sessionId: s.id,
        code: 'EH_EVENTS_OVERFLOW',
      })
      s.log.warn('eharness: a session events reader fell too far behind and was dropped', {
        sessionId: s.id,
        ...info,
      })
    },
  })
  s.contexts = new Map<string, HarnessContext>()
  s.customIdWarned = false
  s.rt = {
    id: s.id,
    agent: s.internals,
    options: s.args.options,
    messages: s.args.messages,
    state: createStateStore(s.args.state, s.id, s.internals.observe),
    ...(s.args.streams === undefined ? {} : { streams: s.args.streams }),
    owner: s.args.owner,
    claimOwner: s.args.claimOwner,
    log: s.log,
    get signal() {
      return s.sessionController.signal
    },
    events: s.events,
    open: undefined,
    view: undefined,
    newestId: undefined,
    storedLastId: undefined,
    turn: undefined,
    running: false,
    closed: false,
    warn(warning: HarnessWarning, key?: string) {
      const observe = s.internals.observe
      if (observe !== undefined) {
        const scope = { sessionId: s.id, code: warning.code }
        observeCount(observe, 'warning', scope)
        if (warning.code === 'W_HOOK_FAILED' || warning.code === 'W_HOOK_TIMEOUT') {
          observeCount(observe, warning.code === 'W_HOOK_FAILED' ? 'hook.failed' : 'hook.timeout', {
            sessionId: s.id,
            ...(typeof warning.details?.hook === 'string' ? { hook: warning.details.hook } : {}),
            ...(typeof warning.details?.owner === 'string' ? { owner: warning.details.owner } : {}),
          })
        }
      }
      s.internals.emitWarning(warning, key)
      const chunk = {
        type: 'data-eh.warning' as const,
        data: { code: warning.code, message: warning.message },
        transient: true,
      }
      if (s.rt.turn?.active === true) s.rt.turn.write(chunk)
      else s.events.emit({ type: 'data', chunk: chunk as never })
    },
    nextId() {
      const floor = s.rt.newestId
      const next = s.internals.generateId(floor)
      if (
        floor !== undefined &&
        !(next > floor) &&
        s.config.generateId !== undefined &&
        !s.customIdWarned
      ) {
        s.customIdWarned = true
        s.log.warn(
          `eharness: config.generateId returned '${next}', which does not sort after the session's newest id '${floor}' (spec 03 §8).`,
        )
      }
      if (floor === undefined || next > floor) s.rt.newestId = next
      return next
    },
    contextOf(plugin: string) {
      let ctx = s.contexts.get(plugin)
      if (ctx === undefined) {
        ctx = createContext(s.rt, plugin)
        s.contexts.set(plugin, ctx)
      }
      return ctx
    },
    cacheMessage(message: HarnessUIMessage) {
      if (s.rt.newestId === undefined || message.id > s.rt.newestId) s.rt.newestId = message.id
      const view = s.rt.view
      if (view === undefined) {
        s.cachedWhileLoading?.push(structuredClone(message))
        return
      }
      const copy = structuredClone(message)
      let index = view.length
      while (index > 0 && (view[index - 1] as HarnessUIMessage).id > message.id) index--
      if (index > 0 && (view[index - 1] as HarnessUIMessage).id === message.id)
        view[index - 1] = copy
      else view.splice(index, 0, copy)
    },
  }
  s.stateFresh = false
  s.pluginOrder = s.internals.plugins.map((p) => p.name)
  s.debugInvariants = s.config.debug?.invariants ?? false
  s.compaction = createSessionCompaction({ rt: s.rt, persist: (messages) => persist(s, messages) })
  s.localEnqueueIds = new Map<string, string>()
  s.queue = []
  s.gated = []
  s.gating = false
  s.waits = createWaitOps({
    rt: s.rt,
    ensureOpen: () => ensureOpen(s),
    ensureContext: () => ensureContext(s, true),
    continueRun: (options) => s.session.respond({}, options),
    inbox: s.args.inbox,
    toolOutput: s.config.toolOutput,
    staleMs:
      s.config.recovery === false
        ? DEFAULT_STALE_MS
        : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS),
    warnInbox: (operation, error) => inboxWarning(s, operation, error),
    notify: () => notify(s),
  })
  s.host = {
    rt: s.rt,
    ensureOpen: () => ensureOpen(s),
    ensureContext: () => ensureContext(s, true),
    persist: (messages) => persist(s, messages),
    compaction: s.compaction,
    onTurnEnd() {
      s.current = undefined
      if (s.debugInvariants) void reportInvariants(s)
      s.waits.arm()
      startNext(s)
      checkCollect(s)
      s.drain?.drain()
      gateStep(s)
      touch(s)
      checkIdle(s)
    },
    enqueueSteer(submitted, inboxId) {
      // a durable steer goes back to the inbox: drained again in id order (spec 05 §12 rule 7)
      if (inboxId !== undefined && s.drain !== undefined) return s.drain.release([inboxId])
      enqueue(s, {
        input: submitted.input,
        submitted,
        options: {},
        ...(inboxId === undefined
          ? {}
          : { inbox: { ids: [inboxId], meta: { inboxId }, durable: false } }),
      })
      return undefined
    },
    get inboxDurable() {
      return s.drain !== undefined
    },
    inboxApplied(ids, turnId) {
      if (s.drain !== undefined) void s.drain.ack(ids, turnId)
      else s.events.emit({ type: 'inbox-drained', inboxIds: [...ids], turnId })
    },
    inboxNotApplied(ids, outcome) {
      if (s.drain === undefined) return
      void s.drain.settle(ids, outcome)
    },
    dropQueue: () => dropQueue(s, false),
    waitsParked: (pending) => s.waits.parked(pending),
    async enqueueWake(messageIds, pending) {
      // approvals / client tool calls wait for an answer: the wake is durable when it can be
      // (it survives a restart and runs in whichever instance sees the answer, ADR-0054)
      if (pending && messageIds.length > 0) {
        let stored = 0
        for (const messageId of messageIds) if (await holdWakeDurably(s, messageId)) stored++
        if (stored === messageIds.length) return
      }
      enqueue(s, { kind: 'wake', input: undefined, options: {} })
    },
  }
  s.revalidating = false
  s.runListeners = new Set<(run: HarnessRun<UIMessage>) => void>()
  // ─── collect (in-process debounce, spec 05 §12 rule 6) ─────────────────────────────────────
  // ─── idle ─────────────────────────────────────────────────────────────────────────────────
  s.idleWaiters = []
  s.injectFlights = new Map<string, Promise<{ message: unknown; run?: unknown }>>()
  s.session = {
    id: s.id,
    get running() {
      return s.rt.running
    },
    ready() {
      return apiReady(s)
    },
    send(input?: SendInput, options?: SendOptions) {
      return apiSend(s, input, options)
    },
    respond(response: PendingResponse, options?: SendOptions) {
      return apiRespond(s, response, options)
    },
    regenerate(options?: { messageId?: string } & SendOptions) {
      return apiRegenerate(s, options)
    },
    edit(arg0: { messageId: string; input: SendInput } & SendOptions) {
      return apiEdit(s, arg0)
    },
    onRun(listener) {
      return apiOnRun(s, listener)
    },
    attach() {
      return apiAttach(s)
    },
    attachRemote(options) {
      return apiAttachRemote(s, options)
    },
    abort(reason) {
      return apiAbort(s, reason)
    },
    inject(kind, data, options) {
      return apiInject(s, kind, data, options)
    },
    compact(options) {
      return apiCompact(s, options)
    },
    recover() {
      return apiRecover(s)
    },
    enqueue(input, options) {
      return apiEnqueue(s, input, options)
    },
    resolveWait(waitId, result, options) {
      return apiResolveWait(s, waitId, result, options)
    },
    expireWaits(now) {
      return apiExpireWaits(s, now)
    },
    pendingWaits() {
      return apiPendingWaits(s)
    },
    fork(options?: ForkOptions) {
      return apiFork(s, options)
    },
    children() {
      return apiChildren(s)
    },
    parentInfo() {
      return apiParentInfo(s)
    },
    clearGrants() {
      return apiClearGrants(s)
    },
    messages(q) {
      return apiMessages(s, q)
    },
    stats() {
      return apiStats(s)
    },
    busy() {
      return apiBusy(s)
    },
    tools() {
      return apiTools(s)
    },
    events() {
      return apiEvents(s)
    },
    idle() {
      return apiIdle(s)
    },
    close: () => close(s),
  }
  s.staleForDrain =
    s.config.recovery === false ? false : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS)
  s.drain =
    s.args.inbox === undefined
      ? undefined
      : createInboxDrain({
          rt: s.rt,
          adapter: s.args.inbox,
          staleMs: s.staleForDrain,
          claimTtlMs:
            s.config.inbox?.claimTtlMs ??
            (s.staleForDrain === false ? DEFAULT_STALE_MS : s.staleForDrain),
          pollMs: s.config.inbox?.pollMs ?? DEFAULT_INBOX_POLL_MS,
          collect: s.config.inbox?.collect,
          retry: s.config.inbox?.retry,
          onDeadLetter: s.config.inbox?.onDeadLetter,
          current: () => {
            const running = s.current
            if (running === undefined) return undefined
            return {
              turnId: running.run.turnId,
              steer: (input, inboxId) => running.steer(input, inboxId),
            }
          },
          free: () => !s.rt.closed && !s.rt.running && s.queue.length === 0,
          prepare: async () => {
            await ensureOpen(s)
            await ensureContext(s, true)
          },
          invalidate: () => {
            if (s.current === undefined && s.loading === undefined) s.rt.view = undefined
          },
          start: (unit) => startUnit(s, unit),
          expireWait: (waitId) => s.waits.expireOne(waitId),
          abort: (reason) => {
            dropQueue(s, false)
            s.current?.abort(reason ?? 'aborted')
          },
          settled: () => {
            checkIdle(s)
            void releaseHeldQueue(s)
          },
        })
  s.rt.inject = (kind, data, options) => s.session.inject(kind as never, data as never, options)
  touch(s)
  return { session: s.session, rt: s.rt, close: () => close(s) }
}
