import type {
  CompactOptions,
  ForkOptions,
  SessionStateSnapshot,
} from '../../agent/session-types.ts'
import { manualFlushEnv } from '../../compaction/flush.ts'
import { currentTurnStartId } from '../../compaction/turns.ts'
import {
  HarnessError,
  isHarnessError,
  lockFailure,
  sessionBusyError,
  storageError,
} from '../../errors.ts'
import { hookFailed, hookTimeoutOf, runHook } from '../../internal/hook-run.ts'
import { recordOutsideTurn } from '../../loop/ledger.ts'
import { costOf } from '../../models/cost.ts'
import { copyMessages } from '../family.ts'
import { liveForeignTurn } from '../inbox/driver.ts'
import { isOwnLeftover } from '../local-turns.ts'
import { recoverInterruptedTurn } from '../recover.ts'
import { DEFAULT_STALE_MS } from '../remote-abort.ts'
import { budgetOverrun } from '../turn/helpers.ts'
import type { SessionCtx } from './ctx.ts'
import { ensureContext, ensureOpen, persist, staticTokens } from './open.ts'
import { assertOpen, checkCollect, checkIdle, startNext, touch } from './queue.ts'

export async function apiCompact(
  s: SessionCtx,
  options: CompactOptions | undefined,
): Promise<null> {
  assertOpen(s)
  const keepLast = options?.keepLast
  if (keepLast !== undefined && !(Number.isInteger(keepLast) && keepLast >= 0)) {
    throw new HarnessError(
      'EH_INVALID_INPUT',
      'compact({ keepLast }) must be a non-negative integer.',
      { details: { keepLast } },
    )
  }
  const instructions = options?.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new HarnessError('EH_INVALID_INPUT', 'compact({ instructions }) must be a string.')
  }
  if (s.rt.running) throw sessionBusyError(s.id)
  // exclusive like a turn (spec 05 §8): send() throws EH_SESSION_BUSY meanwhile
  s.rt.running = true
  touch(s)
  let release: (() => Promise<void>) | undefined
  try {
    const open = await ensureOpen(s)
    const lock = s.rt.options.lock
    if (lock !== undefined) {
      try {
        release = await lock.acquire(s.id, { signal: s.closeController.signal })
      } catch (error) {
        if (!isHarnessError(error, 'EH_SESSION_BUSY')) {
          s.log.warn('eharness: acquiring the session lock failed', { error })
        }
        throw lockFailure(s.id, error)
      }
    }
    await ensureContext(s, true)
    const core = s.rt.state.core()
    const active = core.activeTurn
    const staleMs =
      (s.config.recovery === false ? undefined : s.config.recovery?.staleMs) ?? 120_000
    if (
      s.config.recovery !== false &&
      active !== undefined &&
      release === undefined &&
      active.owner !== s.rt.owner &&
      Date.now() - active.heartbeatAt <= staleMs
    ) {
      throw new HarnessError(
        'EH_SESSION_BUSY',
        'A turn of this session is running in another instance.',
        { details: { turnId: active.turnId, owner: active.owner } },
      )
    }
    const view = s.rt.view ?? []
    const pending = core.pending
    const fixed = await staticTokens(s, open)
    const fixedTokens = fixed.instructions + fixed.tools
    /** Priced summarizer / flush calls, recorded on `budget.ledger` afterwards (spec 12 §4.1). */
    const ledgerCosts: number[] = []
    const outcome = await s.compaction.compact({
      mode: 'manual',
      trigger: 'manual',
      keepLast,
      instructions,
      // the pending message's turn is kept like a current turn (spec 06 §5.1)
      currentStartId:
        pending === undefined
          ? undefined
          : currentTurnStartId(
              view,
              { kind: 'respond', messageId: pending.messageId },
              s.internals.messages,
            ),
      model: s.config.model,
      fixedTokens,
      beforeTokens: s.compaction.calibration.apply(
        fixedTokens + (await s.compaction.viewTokens(view)),
      ),
      // manual compaction belongs to no turn: its usage goes to the session (spec 06 §5.3)
      onUsage: (usage, model) => {
        const current = s.rt.state.core()
        const previous = current.usage ?? { inputTokens: 0, outputTokens: 0, turns: 0 }
        const cost = costOf(s.config.models, model, usage)
        current.usage = {
          ...previous,
          inputTokens: previous.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: previous.outputTokens + (usage.outputTokens ?? 0),
        }
        if (cost !== undefined) current.usage.costUsd = (previous.costUsd ?? 0) + cost
        if (cost !== undefined) ledgerCosts.push(cost)
        s.rt.state.markDirty()
      },
      flushEnv: () => manualFlushEnv({ rt: s.rt, open }),
      overBudget: () =>
        budgetOverrun(
          s.config.budget === undefined ? undefined : { ...s.config.budget, maxTurnUsd: undefined },
          0,
          s.rt.state.core().usage?.costUsd ?? 0,
        ),
    })
    try {
      await s.rt.state.writeIfDirty()
    } catch (error) {
      s.log.warn('eharness: state write after compaction failed', { error })
    }
    const ledger = s.config.budget?.ledger
    if (ledger !== undefined && ledgerCosts.length > 0) {
      const compactId = s.internals.generateId()
      for (const [i, amountUsd] of ledgerCosts.entries()) {
        await recordOutsideTurn({
          config: ledger,
          ctx: s.rt.contextOf('app'),
          key: `${s.rt.id}:compact:${compactId}:${i}`,
          amountUsd,
          warn: (warning, key) => s.rt.warn(warning, key),
        })
      }
    }
    if (outcome.status === 'failed') throw outcome.error
    return outcome.status === 'compacted' ? (structuredClone(outcome.marker) as never) : null
  } finally {
    if (release !== undefined) {
      try {
        await release()
      } catch (error) {
        s.log.warn('eharness: releasing the session lock failed', { error })
      }
    }
    s.rt.running = false
    startNext(s)
    checkCollect(s)
    s.drain?.drain()
    touch(s)
    checkIdle(s)
  }
}

export async function apiRecover(
  s: SessionCtx,
): Promise<
  | { recovered: false; reason: 'disabled'; turnId?: undefined; messageId?: undefined }
  | { recovered: false; reason: 'locked'; turnId?: undefined; messageId?: undefined }
  | { recovered: false; reason: 'lock-unavailable'; turnId?: undefined; messageId?: undefined }
  | { recovered: false; reason: 'idle'; turnId?: undefined; messageId?: undefined }
  | { recovered: false; reason: 'live'; turnId?: undefined; messageId?: undefined }
  | { recovered: true; turnId: string; messageId: string; reason?: undefined }
> {
  assertOpen(s)
  if (s.config.recovery === false) return { recovered: false, reason: 'disabled' }
  if (s.rt.running) throw sessionBusyError(s.id)
  // exclusive like a turn (spec 05 §8)
  s.rt.running = true
  touch(s)
  let release: (() => Promise<void>) | undefined
  try {
    await ensureOpen(s)
    const lock = s.rt.options.lock
    if (lock !== undefined) {
      try {
        release = await lock.acquire(s.id, { signal: s.closeController.signal })
      } catch (error) {
        // contention is `locked`; a failing lock service must not read as a rival instance
        if (isHarnessError(error, 'EH_SESSION_BUSY')) {
          return { recovered: false, reason: 'locked' }
        }
        s.log.warn('eharness: acquiring the session lock failed', { error })
        return { recovered: false, reason: 'lock-unavailable' }
      }
    }
    await ensureContext(s, true)
    await s.rt.state.load()
    const active = s.rt.state.core().activeTurn
    if (active === undefined) return { recovered: false, reason: 'idle' }
    const staleMs = s.config.recovery?.staleMs ?? DEFAULT_STALE_MS
    const stale =
      isOwnLeftover(s.rt, active) ||
      release !== undefined ||
      Date.now() - active.heartbeatAt > staleMs
    if (!stale) return { recovered: false, reason: 'live' }
    await recoverInterruptedTurn(s.rt, (messages) => persist(s, messages), active, {
      startedAt: Date.now(),
    })
    const core = s.rt.state.core()
    delete core.activeTurn
    delete core.abortRequest
    s.rt.state.markDirty()
    const ok = await s.rt.state.write({ cas: true })
    if (!ok) {
      s.rt.view = undefined
      throw new HarnessError(
        'EH_SESSION_BUSY',
        'The session state was changed by another instance.',
      )
    }
    return { recovered: true, turnId: active.turnId, messageId: active.messageId }
  } finally {
    if (release !== undefined) {
      try {
        await release()
      } catch (error) {
        s.log.warn('eharness: releasing the session lock failed', { error })
      }
    }
    s.rt.running = false
    startNext(s)
    checkCollect(s)
    s.drain?.drain()
    touch(s)
    checkIdle(s)
  }
}

export async function apiFork(s: SessionCtx, options: ForkOptions = {}): Promise<never> {
  assertOpen(s)
  touch(s)
  const { beforeMessageId, copyState = 'all' } = options
  const invalid = (message: string, reason: string): HarnessError =>
    new HarnessError('EH_INVALID_INPUT', message, { details: { reason, sessionId: s.id } })
  if (options.id !== undefined && (typeof options.id !== 'string' || options.id === '')) {
    throw invalid('fork({ id }) must be a non-empty string.', 'id')
  }
  if (beforeMessageId !== undefined && beforeMessageId === '') {
    throw invalid('fork({ beforeMessageId }) must be a non-empty string.', 'before-message-id')
  }
  if (copyState !== 'all' && copyState !== 'none') {
    throw invalid("fork({ copyState }) must be 'all' or 'none'.", 'copy-state')
  }
  const newId = options.id ?? s.internals.generateId()
  if (newId === s.id) throw invalid('A session cannot fork into itself.', 'same-id')
  if (s.rt.running) throw sessionBusyError(s.id)
  // a turn of this session may not be mid-flight: flush our state, then read the stored one
  if (s.rt.state.loaded) await s.rt.state.writeIfDirty()
  const stored = await s.rt.state.peek()
  if (s.rt.running) throw sessionBusyError(s.id)
  if (liveForeignTurn(stored, s.rt.owner, s.staleForDrain, s.rt) !== undefined)
    throw sessionBusyError(s.id)
  const included = (messageId: string): boolean =>
    beforeMessageId === undefined || messageId < beforeMessageId
  const unfinished = stored?.core.activeTurn
  if (unfinished !== undefined && included(unfinished.messageId)) {
    throw invalid(
      'The history to copy ends with a turn that did not finish; recover the session (send a message) first.',
      'active-turn',
    )
  }
  const pending = stored?.core.pending
  if (pending !== undefined && pending !== null && included(pending.messageId)) {
    throw invalid(
      'The history to copy includes a message that waits for answers (pending approvals); respond first or fork before it.',
      'pending',
    )
  }
  if (s.args.isLive(newId)) throw invalid(`Session '${newId}' is already open.`, 'exists')
  try {
    const taken =
      (await s.args.state.get(newId)) !== null ||
      (await s.args.messages.load({ sessionId: newId, limit: 1 })).length > 0
    if (taken) throw invalid(`Session '${newId}' already exists.`, 'exists')
  } catch (error) {
    throw storageError('Message', 'fork', error)
  }
  const copied = await copyMessages({
    adapter: s.args.messages,
    from: s.id,
    to: newId,
    ...(beforeMessageId === undefined ? {} : { beforeId: beforeMessageId }),
    registry: s.internals.messages,
  })
  const all = copyState === 'all'
  const core = stored?.core
  const snapshot: SessionStateSnapshot = {
    v: 1,
    rev: 1,
    core: {
      ...(all && copied.compaction !== undefined ? { compaction: copied.compaction } : {}),
      ...(all && core?.usage !== undefined ? { usage: { ...core.usage } } : {}),
      ...(all && core?.grants !== undefined ? { grants: { ...core.grants } } : {}),
      ...(all && copied.rewinds.length > 0 ? { rewinds: copied.rewinds } : {}),
      forkedFrom: {
        sessionId: s.id,
        ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
        at: Date.now(),
      },
    },
    plugins: all ? structuredClone(stored?.plugins ?? {}) : {},
  }
  try {
    if (s.args.state.setIf !== undefined) {
      if (!(await s.args.state.setIf(newId, snapshot, null))) {
        throw invalid(`Session '${newId}' already exists.`, 'exists')
      }
    } else {
      await s.args.state.set(newId, snapshot)
    }
  } catch (error) {
    throw storageError('Message', 'fork', error)
  }
  const { parent: _parent, runtime, ...inherited } = s.rt.options
  const forked = s.args.openSession(newId, {
    ...inherited,
    storage: {
      messages: s.args.messages,
      state: s.args.state,
      ...(s.args.inbox === undefined ? {} : { inbox: s.args.inbox }),
      ...(s.args.streams === undefined ? {} : { streams: s.args.streams }),
    },
    ...((options.runtime ?? runtime) === undefined
      ? {}
      : { runtime: (options.runtime ?? runtime) as Record<string, unknown> }),
  })
  await forked.ready()
  // plugins copy what lives outside the session storage (spec 01 §5 `session.fork`)
  try {
    const open = await ensureOpen(s)
    const event = {
      sourceSessionId: s.id,
      targetSessionId: newId,
      ...(beforeMessageId === undefined ? {} : { beforeMessageId }),
      keptMessageIds: [...copied.ids].sort(),
    }
    for (const hook of open.hooks.list('session.fork')) {
      try {
        await runHook(() => hook.fn(s.rt.contextOf(hook.owner), structuredClone(event)), {
          hook: 'session.fork',
          owner: hook.owner,
          timeoutMs: hookTimeoutOf(s.rt.agent.config),
        })
      } catch (error) {
        hookFailed(s.rt, 'session.fork', hook.owner, error)
      }
    }
  } catch (error) {
    s.log.warn('eharness: session.fork hooks could not run', { error })
  }
  return forked as never
}

export async function apiClearGrants(s: SessionCtx): Promise<void> {
  assertOpen(s)
  await ensureOpen(s)
  const core = s.rt.state.core()
  if (core.grants === undefined) return
  delete core.grants
  s.rt.state.markDirty()
  await s.rt.state.writeIfDirty()
}
