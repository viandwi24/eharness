import type { UIMessage } from 'ai'
import type { CollectOptions, HarnessRun, SendOptions } from '../../agent/session-types.ts'
import { sessionClosedError } from '../../errors.ts'
import { hookFailed, hookTimeoutOf, runHook } from '../../internal/hook-run.ts'
import { unref } from '../../internal/util.ts'
import { describeOwner } from '../../registry/static.ts'
import { createRun } from '../../stream/run.ts'
import { collectDue, mergeInputs, resolveCollect } from '../inbox/collect.ts'
import type { InboxUnit } from '../inbox/driver.ts'
import type { NormalizedInput } from '../input.ts'
import { pendingSignature } from '../interaction/pending.ts'
import { createDeferredRun, type QueuedTurn } from '../interaction/queue.ts'
import type { RunningTurn } from '../turn/ctx.ts'
import { startTurn } from '../turn.ts'
import type { CollectEntry, SessionCtx } from './ctx.ts'

export function enqueue(
  s: SessionCtx,
  item: Pick<QueuedTurn, 'input' | 'submitted' | 'options' | 'wait' | 'respond' | 'inbox'> & {
    kind?: QueuedTurn['kind']
  },
): HarnessRun<UIMessage> {
  const turnId = s.internals.generateId()
  const kind = item.kind ?? 'send'
  // a queued wake turn projects every undelivered event when it runs: a second wake is the
  // same turn (one turn for N reports, never an extra no-input turn, ADR-0054)
  const queuedWake = kind === 'wake' ? s.queue.find((e) => e.kind === 'wake') : undefined
  if (queuedWake !== undefined) {
    const extra = createDeferredRun({
      turnId: queuedWake.turnId,
      kind,
      generateId: () => s.internals.generateId(),
      onAbort: () => {},
    })
    queuedWake.extraHandles = [...(queuedWake.extraHandles ?? []), extra]
    return extra.run
  }
  const remove = () => {
    const index = s.queue.indexOf(entry)
    if (index < 0) return false
    s.queue.splice(index, 1)
    entry.handle.drop()
    checkIdle(s)
    return true
  }
  const entry: QueuedTurn = {
    ...item,
    kind,
    turnId,
    handle: createDeferredRun({
      turnId,
      kind,
      generateId: () => s.internals.generateId(),
      onAbort: () => void remove(),
    }),
  }
  s.queue.push(entry)
  // a waiting operation is dropped by its own abortSignal while it waits (spec 05 §2)
  const signal = item.wait === undefined ? undefined : item.options.abortSignal
  if (signal?.aborted === true) remove()
  else if (signal !== undefined) {
    const onAbort = () => void remove()
    signal.addEventListener('abort', onAbort, { once: true })
    // the wait ends when the entry launches or settles: the listener must not outlive it
    entry.detachAbort = () => signal.removeEventListener('abort', onAbort)
    void entry.handle.run.result.then(entry.detachAbort, entry.detachAbort)
  }
  // the session may have gone idle meanwhile (e.g. a steer that arrived as its turn ended)
  queueMicrotask(() => startNext(s))
  return entry.handle.run
}

/** Hold a direct send behind the older items of the durable inbox (spec 05 §12 rule 7). */
export function gateSend(
  s: SessionCtx,
  normalized: NormalizedInput | undefined,
  options: SendOptions,
): HarnessRun<UIMessage> {
  const turnId = s.internals.generateId()
  const entry: QueuedTurn = {
    kind: 'send',
    turnId,
    input: normalized,
    options,
    handle: createDeferredRun({
      turnId,
      kind: 'send',
      generateId: () => s.internals.generateId(),
      onAbort: () => {
        const index = s.gated.indexOf(entry)
        if (index < 0) return
        s.gated.splice(index, 1)
        entry.handle.drop()
        checkIdle(s)
      },
    }),
  }
  s.gated.push(entry)
  touch(s)
  gateStep(s)
  return entry.handle.run
}

/**
 * Let the inbox apply what is older than the gated sends, then release them into the queue (FIFO).
 * Re-run when a turn ends: the drain may have started a unit meanwhile.
 */
export function gateStep(s: SessionCtx): void {
  if (s.gating || s.gated.length === 0 || s.drain === undefined) return
  if (s.rt.closed) return
  if (s.rt.running) return // the turn end calls this again
  s.gating = true
  void (async () => {
    try {
      await s.drain?.flush()
    } catch {}
    s.gating = false
    if (s.rt.closed || s.gated.length === 0) return
    if (s.rt.running) return // the turn end calls gateStep again
    if (s.queue.length > 0) {
      // queued turns are older: the direct sends line up behind them (FIFO). The queue may be
      // held by pending approvals; re-running this step would spin forever (fuzz seed 38).
      s.queue.push(...s.gated.splice(0))
      startNext(s)
      return
    }
    // a direct send starts like an idle `send()` does: the turn reloads the state, so a stale
    // in-memory `pending` (answered on another instance) does not hold it back
    const [first, ...rest] = s.gated.splice(0)
    s.queue.push(...rest)
    if (first !== undefined) launch(s, first)
  })()
}

/**
 * Start the next queued turn when the session is idle. The queue is held while approvals or
 * client tool calls wait for `respond()`: a queued turn never auto-denies them (spec 11 §6.2).
 * While held, a waiting `respond()` may start (from any position: it resolves what holds the
 * queue), and a waiting `send()` at the head whose call already saw that pending state (it then
 * behaves as a new `send()`). Nothing else overtakes: the queue is FIFO.
 */
export function startNext(s: SessionCtx, ignorePending = false): void {
  if (s.rt.closed || s.rt.running || s.queue.length === 0) return
  const pending = ignorePending ? undefined : s.rt.state.core().pending
  // FIFO: only the head may start, except a waiting respond() (it resolves what holds the queue)
  const head = s.queue[0] as QueuedTurn
  const index =
    pending === undefined ||
    (head.kind === 'send' &&
      head.wait !== undefined &&
      head.wait.pendingAtCall === pending.messageId)
      ? 0
      : s.queue.findIndex((e) => e.kind === 'respond')
  if (index < 0) return
  const [next] = s.queue.splice(index, 1)
  if (next === undefined) return
  launch(s, next)
}

export async function releaseHeldQueue(s: SessionCtx): Promise<void> {
  if (s.revalidating || s.rt.closed || s.rt.running || s.queue.length === 0) return
  const held = s.rt.state.core().pending
  if (held === undefined) return startNext(s)
  s.revalidating = true
  try {
    const stored = await s.rt.state.peek()
    if (s.rt.closed || s.rt.running) return
    const now = stored?.core?.pending
    if (now === undefined) return startNext(s, true)
    // still held, but by another wait (another instance continued the message or ran a later
    // turn): refresh the cache so the next operation sees it
    if (pendingSignature(now) !== pendingSignature(held) && !s.rt.state.dirty) {
      await s.rt.state.load()
      s.rt.view = undefined
    }
  } catch (error) {
    // storage trouble: try again after the next inbox pass
    s.warnLimited('revalidate', 'eharness: re-checking the pending state failed', { error })
  } finally {
    s.revalidating = false
  }
}

/** Start a queued turn now (the caller checked that the session is free). */
export function launch(s: SessionCtx, next: QueuedTurn): void {
  next.detachAbort?.()
  s.rt.running = true
  touch(s)
  s.current = startTurn(s.host, {
    kind: next.kind,
    input: undefined,
    ...(next.input === undefined ? {} : { normalized: next.input }),
    ...(next.submitted === undefined ? {} : { submitted: next.submitted }),
    ...(next.respond === undefined ? {} : { respond: next.respond }),
    ...(next.inbox === undefined ? {} : { inbox: next.inbox }),
    options: next.options,
    queued: true,
    turnId: next.turnId,
    via: 'queue',
  })
  announce(s, s.current)
  next.handle.bind(s.current.run)
  for (const extra of next.extraHandles ?? []) extra.bind(attachRun(s, s.current))
}

/** Hand every listener its own reader of a turn that just started (before anyone consumes it). */
export function announce(s: SessionCtx, running: RunningTurn): void {
  for (const listener of [...s.runListeners]) {
    try {
      listener(attachRun(s, running))
    } catch (error) {
      s.log.warn('eharness: an onRun listener threw', { error })
    }
  }
}

/** A new reader of a running turn (replay + follow), like `attach()`. */
export function attachRun(_s: SessionCtx, running: RunningTurn): HarnessRun<UIMessage> {
  return createRun({
    turnId: running.run.turnId,
    kind: running.run.kind,
    messageId: running.run.messageId,
    stream: running.buffer.reader(),
    result: running.run.result,
    abort: running.abort,
  })
}

/** Add an input to the burst; returns the run of `send()` callers. */
export function collectInput(
  s: SessionCtx,
  input: NormalizedInput,
  options: CollectOptions | undefined,
  inboxId: string | undefined,
  withRun: boolean,
  key?: string,
): HarnessRun<UIMessage> | undefined {
  if (s.collecting === undefined) {
    s.collecting = {
      turnId: s.internals.generateId(),
      options: resolveCollect(s.config.inbox?.collect, options),
      entries: [],
    }
  }
  const group = s.collecting
  const entry: CollectEntry = {
    input,
    at: Date.now(),
    ...(inboxId === undefined ? {} : { inboxId }),
    ...(key === undefined ? {} : { key }),
  }
  if (withRun) {
    entry.handle = createDeferredRun({
      turnId: group.turnId,
      kind: 'send',
      generateId: () => s.internals.generateId(),
      onAbort: () => {
        // before the flush the input leaves the burst; after it, only this reader is dropped
        const index = group.entries.indexOf(entry)
        if (s.collecting === group && index >= 0) group.entries.splice(index, 1)
        entry.handle?.drop()
        if (s.collecting === group && group.entries.length === 0) clearCollect(s)
        checkIdle(s)
      },
    })
  }
  group.entries.push(entry)
  checkCollect(s)
  return entry.handle?.run
}

/** Flush the burst when it is due (into the queue: it runs after the current turn), else wait. */
export function checkCollect(s: SessionCtx): void {
  const group = s.collecting
  if (group === undefined || s.rt.closed) return
  if (group.timer !== undefined) clearTimeout(group.timer)
  group.timer = undefined
  const first = group.entries[0]
  if (first === undefined) return
  const due = collectDue(
    {
      firstAt: first.at,
      lastAt: (group.entries.at(-1) as CollectEntry).at,
      count: group.entries.length,
    },
    group.options,
    Date.now(),
  )
  if (!due.due) {
    group.timer = setTimeout(() => checkCollect(s), Math.max(0, due.at - Date.now()) + 1)
    unref(group.timer)
    return
  }
  s.collecting = undefined
  const handles = group.entries.flatMap((e) => (e.handle === undefined ? [] : [e.handle]))
  const collected = group.entries.map((e) => {
    const out: { inboxId?: string; clientId?: string; inboxKey?: string } = {}
    if (e.inboxId !== undefined) out.inboxId = e.inboxId
    if (e.key !== undefined) out.inboxKey = e.key
    if (e.input.clientId !== undefined) out.clientId = e.input.clientId
    return out
  })
  const head =
    handles[0] ??
    createDeferredRun({
      turnId: group.turnId,
      kind: 'send',
      generateId: () => s.internals.generateId(),
      onAbort: () => {},
    })
  s.queue.push({
    kind: 'send',
    turnId: group.turnId,
    input: mergeInputs(group.entries.map((e) => e.input)),
    options: {},
    handle: head,
    extraHandles: handles.slice(1),
    inbox: {
      ids: group.entries.flatMap((e) => (e.inboxId === undefined ? [] : [e.inboxId])),
      meta: { collected },
      durable: false,
    },
  })
  startNext(s)
  checkIdle(s)
}

export function clearCollect(s: SessionCtx): void {
  const group = s.collecting
  s.collecting = undefined
  if (group?.timer !== undefined) clearTimeout(group.timer)
  for (const entry of group?.entries ?? []) entry.handle?.drop()
}

export function isIdle(s: SessionCtx): boolean {
  return (
    s.rt.closed ||
    (!s.rt.running &&
      s.queue.length === 0 &&
      s.gated.length === 0 &&
      s.collecting === undefined &&
      s.drain?.busy !== true)
  )
}

export function checkIdle(s: SessionCtx): void {
  if (!isIdle(s)) return
  for (const resolve of s.idleWaiters.splice(0)) resolve()
}

/**
 * Drop queued turns; `abort()` keeps `ifBusy: 'wait'` callers (only `close()` drops them).
 * Durable inbox items are never dropped: they go back to the inbox (spec 05 §12).
 */
export function dropQueue(s: SessionCtx, all: boolean): void {
  for (const entry of s.gated.splice(0)) entry.handle.drop()
  for (const entry of [...s.queue]) {
    if (!all && entry.wait !== undefined) continue
    s.queue.splice(s.queue.indexOf(entry), 1)
    entry.handle.drop()
    for (const extra of entry.extraHandles ?? []) extra.drop()
    if (entry.inbox?.durable === true) void s.drain?.release(entry.inbox.ids)
  }
  clearCollect(s)
  checkIdle(s)
}

/** A turn operation that starts now (the caller checked the running flag). */
export function begin(s: SessionCtx, op: Parameters<typeof startTurn>[1]): HarnessRun<UIMessage> {
  s.rt.running = true
  touch(s)
  s.current = startTurn(s.host, op)
  announce(s, s.current)
  return s.current.run
}

export function assertOpen(s: SessionCtx): void {
  if (s.rt.closed) throw sessionClosedError(s.id)
}

export function touch(s: SessionCtx): void {
  if (s.args.idleMs <= 0 || s.rt.closed) return
  if (s.idleTimer !== undefined) clearTimeout(s.idleTimer)
  s.idleTimer = setTimeout(() => {
    s.idleTimer = undefined
    // a queue held by pending approvals does not keep the session alive: idle close drops it
    const queued =
      (s.queue.length > 0 || s.collecting !== undefined || s.drain?.busy === true) &&
      s.rt.state.core().pending === undefined
    if (s.rt.running || queued || s.events.readers > 0) touch(s)
    else void close(s)
  }, s.args.idleMs)
  unref(s.idleTimer)
}

export function close(s: SessionCtx): Promise<void> {
  if (s.closing !== undefined) return s.closing
  s.rt.closed = true
  if (s.idleTimer !== undefined) clearTimeout(s.idleTimer)
  s.waits.dispose()
  s.runListeners.clear()
  s.drain?.close()
  dropQueue(s, true)
  s.closing = (async () => {
    const running = s.current
    if (running !== undefined) {
      running.abort('closed')
      await running.run.result
    }
    s.closeController.abort('closed')
    s.sessionController.abort('closed')
    const open = s.rt.open
    if (open === undefined && s.opening !== undefined) {
      try {
        await s.opening
      } catch {}
    }
    if (s.rt.open !== undefined) {
      for (const hook of s.rt.open.hooks.list('session.close')) {
        try {
          await runHook(() => hook.fn(s.rt.contextOf(hook.owner)), {
            hook: 'session.close',
            owner: hook.owner,
            timeoutMs: hookTimeoutOf(s.rt.agent.config),
          })
        } catch (error) {
          hookFailed(s.rt, 'session.close', hook.owner, error)
        }
      }
      for (const { owner, dispose } of [...s.rt.open.disposers].reverse()) {
        try {
          await dispose()
        } catch (error) {
          s.log.warn(`eharness: dispose of ${describeOwner(owner)} failed`, { error })
        }
      }
      try {
        await s.rt.state.writeIfDirty()
      } catch (error) {
        s.log.warn('eharness: state write on close failed', { error })
      }
    }
    s.events.close()
    checkIdle(s)
    s.args.onClosed()
  })()
  return s.closing
}

// ─── durable inbox (spec 05 §12) ──────────────────────────────────────────────────────────
export function enqueueLocal(
  s: SessionCtx,
  normalized: NormalizedInput,
  mode: 'queue' | 'steer' | 'collect',
  inboxId: string,
  collect: CollectOptions | undefined,
  key?: string,
): void {
  if (mode === 'collect') {
    collectInput(s, normalized, collect, inboxId, false, key)
    return
  }
  const inbox = {
    ids: [inboxId],
    meta: key === undefined ? { inboxId } : { inboxId, key },
    durable: false,
  }
  if (mode === 'steer' && s.current !== undefined && s.current.steer(normalized, inboxId)) return
  if (!s.rt.running && s.queue.length === 0) {
    begin(s, { kind: 'send', input: undefined, normalized, options: {}, queued: false, inbox })
    return
  }
  enqueue(s, { input: normalized, options: {}, inbox })
}

/** Start a unit of inbox items now (the drain checked that the session is free). */
export function startUnit(s: SessionCtx, unit: InboxUnit): boolean {
  if (s.rt.closed || s.rt.running || s.queue.length > 0) return false
  const turnId = s.internals.generateId()
  const entry: QueuedTurn = {
    kind: unit.kind,
    turnId,
    input: unit.input,
    options: {},
    handle: createDeferredRun({
      turnId,
      kind: unit.kind,
      generateId: () => s.internals.generateId(),
      onAbort: () => {},
    }),
    inbox: { ids: unit.ids, meta: unit.meta, durable: true },
  }
  s.queue.push(entry)
  startNext(s)
  const index = s.queue.indexOf(entry)
  if (index < 0) return true
  // held (pending approvals): back to the inbox
  s.queue.splice(index, 1)
  entry.handle.drop()
  return false
}
