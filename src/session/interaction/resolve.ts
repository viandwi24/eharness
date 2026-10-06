/**
 * Session-level operations on external waits (internal): `resolveWait`, `expireWaits`,
 * `pendingWaits`, the durable `wait-timeout` items and the live timer.
 *
 * Recording is a compare-and-set on the stored state (`setIf`); nothing runs in memory before it
 * commits, so any instance can record a result and the first one wins. The continuation reuses the
 * `respond()` path, which consumes the pending state atomically (ADR-0012).
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 * @see docs/decisions/0027-external-waits-park-at-the-tool-boundary.md
 */
import { asSchema, type Tool, type UIMessage } from 'ai'
import type {
  HarnessRun,
  InboxAdapter,
  ResolveWaitResult,
  SendOptions,
} from '../../agent/session-types.ts'
import type { ToolOutputConfig } from '../../agent/types.ts'
import { HarnessError } from '../../errors.ts'
import type { PendingExternal, WaitResult } from '../../messages/types.ts'
import type { ToolOutputSink } from '../../registry/output-limits.ts'
import { externalOf, type WaitStart } from '../../registry/external.ts'
import { listSourceTools } from '../../registry/tools.ts'
import { finishToolOutput, hookFailed } from '../../registry/wrap.ts'
import type { OpenSession, SessionRuntime } from '../runtime.ts'
import {
  applyStart,
  dueExternals,
  isKnownPending,
  MAX_TIMER_MS,
  nextTimeoutAt,
  timeoutResult,
  unresolvedCount,
} from './waits.ts'

/** Compare-and-set attempts of one recording before giving up (the state keeps changing). */
const RECORD_ATTEMPTS = 6

type Recorded =
  | { status: 'recorded'; remaining: number }
  | { status: 'already-resolved' }
  | { status: 'not-pending' }

/** What the wait operations need from the session. */
export interface WaitOpsHost {
  rt: SessionRuntime
  ensureOpen(): Promise<OpenSession>
  /** Load / validate the message view (the pending message holds the call input). */
  ensureContext(): Promise<void>
  /** Start the continuation through the `respond()` path; throws `EH_SESSION_BUSY` / `CLOSED`. */
  continueRun(options: SendOptions): HarnessRun<UIMessage>
  inbox: InboxAdapter | undefined
  /** `config.toolOutput`. */
  toolOutput: ToolOutputConfig | undefined
  /** `recovery.staleMs`: how long a never-started wait is left to its own instance. */
  staleMs: number
  warnInbox(operation: string, error: unknown): void
  notify(): Promise<void>
}

/** The wait operations of one session. */
export interface WaitOps {
  resolveWait(
    waitId: string,
    result: { output: unknown } | { errorText: string },
    options?: SendOptions,
  ): Promise<ResolveWaitResult<UIMessage>>
  expireWaits(now?: number): Promise<{ expired: string[]; run?: HarnessRun<UIMessage> }>
  pendingWaits(): Promise<PendingExternal[]>
  /** Apply a due `wait-timeout` inbox item (the drain acks it afterwards). */
  expireOne(waitId: string): Promise<void>
  /**
   * A turn parked and its pending state is stored: run the `start` of its waits, then the durable
   * timer items and the live timer. Never throws.
   */
  parked(pending: { externals?: PendingExternal[] }): Promise<void>
  /** Dispatch the `start` of waits a crashed instance never started (session open). Never throws. */
  redispatch(): Promise<void>
  /** Re-arm the live timer from the cached pending state (after a turn ended). */
  arm(): void
  dispose(): void
}

function busy(id: string): HarnessError {
  return new HarnessError('EH_SESSION_BUSY', `A turn of session '${id}' is running.`, {
    details: { sessionId: id },
  })
}

function isBusy(error: unknown): boolean {
  return error instanceof HarnessError && error.code === 'EH_SESSION_BUSY'
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

/** Create the wait operations of a session. */
export function createWaitOps(host: WaitOpsHost): WaitOps {
  const { rt } = host
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Operations that change the cached state run one at a time per instance. */
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  /** Find the tool of a wait: static tools, the source cache, then a fresh source listing. */
  async function toolOf(open: OpenSession, name: string): Promise<Tool | undefined> {
    const fixed = open.tools.find((t) => t.name === name)
    if (fixed !== undefined) return fixed.tool
    for (const list of open.sourceCache.values()) {
      const hit = list.find((t) => t.name === name)
      if (hit !== undefined) return hit.tool
    }
    try {
      const listed = await listSourceTools({
        sources: open.toolSources,
        cache: open.sourceCache,
        taken: new Set(open.tools.map((t) => t.name)),
        contextOf: rt.contextOf,
        warn: rt.warn,
      })
      return listed.find((t) => t.name === name)?.tool
    } catch {
      return undefined
    }
  }

  /** Validate, `tool.after` and limit a result: what is stored is what the model will see. */
  async function prepare(
    entry: PendingExternal,
    source:
      | { kind: 'result'; result: { output: unknown } | { errorText: string } }
      | { kind: 'timeout' },
  ): Promise<WaitResult> {
    if (source.kind === 'timeout' && 'errorText' in entry.onTimeout) return timeoutResult(entry)
    if (source.kind === 'result' && 'errorText' in source.result) {
      return { errorText: source.result.errorText, by: 'result' }
    }
    const open = await host.ensureOpen()
    const tool = await toolOf(open, entry.toolName)
    let output: unknown =
      source.kind === 'result'
        ? (source.result as { output: unknown }).output
        : (timeoutResult(entry) as { output: unknown }).output
    if (source.kind === 'result' && tool?.outputSchema !== undefined) {
      const validate = asSchema(tool.outputSchema as never).validate
      if (validate !== undefined) {
        const checked = await validate(output)
        if (!checked.success) {
          throw new HarnessError(
            'EH_INVALID_INPUT',
            `The result of wait '${entry.waitId}' does not match the output schema of tool '${entry.toolName}': ${checked.error.message}`,
            {
              details: { reason: 'invalid-result', waitId: entry.waitId, tool: entry.toolName },
              cause: checked.error,
            },
          )
        }
        output = checked.value
      }
    }
    await host.ensureContext()
    const message = rt.view?.find((m) => m.id === rt.state.core().pending?.messageId)
    const part = message?.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === entry.toolCallId,
    ) as { input?: unknown } | undefined
    const final = await finishToolOutput(entry.toolName, entry.toolCallId, part?.input, output, {
      hooks: open.hooks,
      contextOf: rt.contextOf,
      warn: rt.warn,
      status: () => {},
      limits: {
        config: host.toolOutput,
        toolOutputs: open.services.get('toolOutputs') as ToolOutputSink | undefined,
      },
    })
    return { output: final as never, by: source.kind === 'timeout' ? 'timeout' : 'result' }
  }

  /** Reload the stored state unless this instance has unwritten changes. */
  async function refresh(): Promise<void> {
    if (!rt.state.dirty) await rt.state.load()
  }

  /**
   * Record the result of one wait with a compare-and-set (spec 11 §4.2 rule 3). The first result
   * wins; the same wait again is `already-resolved`; a consumed pending state is `not-pending`.
   */
  function record(
    waitId: string,
    source: Parameters<typeof prepare>[1],
  ): Promise<Recorded & { by?: 'result' | 'timeout' }> {
    return serial(() => recordNow(waitId, source))
  }

  async function recordNow(
    waitId: string,
    source: Parameters<typeof prepare>[1],
  ): Promise<Recorded & { by?: 'result' | 'timeout' }> {
    const lock = rt.options.lock
    let release: (() => Promise<void>) | undefined
    if (lock !== undefined && !rt.state.canCas) {
      try {
        release = await lock.acquire(rt.id, { signal: rt.signal })
      } catch (error) {
        throw new HarnessError('EH_SESSION_BUSY', 'The session is locked by another instance.', {
          cause: error,
        })
      }
    }
    try {
      let prepared: WaitResult | undefined
      for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
        await refresh()
        const pending = rt.state.core().pending
        if (pending === undefined || !isKnownPending(pending)) return { status: 'not-pending' }
        const entry = pending.externals?.find((e) => e.waitId === waitId)
        if (entry === undefined) return { status: 'not-pending' }
        if (entry.result !== undefined) return { status: 'already-resolved' }
        prepared ??= await prepare(entry, source)
        entry.result = structuredClone(prepared)
        rt.state.markDirty()
        let ok: boolean
        try {
          ok = await rt.state.write({ cas: true })
        } catch (error) {
          delete entry.result
          throw error
        }
        if (ok) {
          rt.events.emit({ type: 'wait-resolved', waitId, by: prepared.by })
          return { status: 'recorded', remaining: unresolvedCount(pending), by: prepared.by }
        }
        // another instance wrote first: reload and look again (its result may be ours to lose)
        rt.state.discard()
        await rt.state.load()
      }
      throw new HarnessError(
        'EH_SESSION_BUSY',
        'The session state kept changing while the result was recorded; try again.',
        { details: { waitId } },
      )
    } finally {
      if (release !== undefined) {
        try {
          await release()
        } catch (error) {
          rt.log.warn('eharness: releasing the session lock failed', { error })
        }
      }
    }
  }

  /** Continue the parked message when every wait is resolved; `undefined` when a turn runs. */
  function tryContinue(options: SendOptions): HarnessRun<UIMessage> | undefined {
    try {
      return host.continueRun(options)
    } catch (error) {
      if (isBusy(error)) return undefined
      throw error
    }
  }

  async function resolveWait(
    waitId: string,
    result: { output: unknown } | { errorText: string },
    options: SendOptions & { actor?: unknown } = {},
  ): Promise<ResolveWaitResult<UIMessage>> {
    if (typeof waitId !== 'string' || waitId.length === 0) {
      throw new HarnessError('EH_INVALID_INPUT', 'resolveWait() needs a wait id.')
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      !('output' in result || 'errorText' in result) ||
      ('errorText' in result && typeof result.errorText !== 'string')
    ) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        'resolveWait() needs a result: `{ output }` or `{ errorText }`.',
      )
    }
    await host.ensureOpen()
    if (rt.running) throw busy(rt.id)
    const outcome = await record(waitId, { kind: 'result', result })
    if (outcome.status !== 'recorded') return { status: outcome.status }
    arm()
    if (outcome.remaining > 0) return { status: 'recorded', remaining: outcome.remaining }
    const { actor: _actor, ...rest } = options
    const run = tryContinue(rest)
    return run === undefined ? { status: 'recorded', remaining: 0 } : { status: 'continued', run }
  }

  async function expireWaits(
    now: number = Date.now(),
  ): Promise<{ expired: string[]; run?: HarnessRun<UIMessage> }> {
    await host.ensureOpen()
    if (rt.running) throw busy(rt.id)
    await redispatch()
    await refresh()
    const pending = rt.state.core().pending
    if (pending === undefined || !isKnownPending(pending)) return { expired: [] }
    const expired: string[] = []
    for (const entry of dueExternals(pending, now)) {
      const outcome = await record(entry.waitId, { kind: 'timeout' })
      if (outcome.status === 'recorded') expired.push(entry.waitId)
    }
    // all waits resolved (also by an earlier instance that never continued): continue now
    const after = rt.state.core().pending
    if (
      after !== undefined &&
      isKnownPending(after) &&
      (after.externals?.length ?? 0) > 0 &&
      unresolvedCount(after) === 0
    ) {
      const run = tryContinue({})
      if (run !== undefined) return { expired, run }
    }
    return { expired }
  }

  async function expireOne(waitId: string): Promise<void> {
    await host.ensureOpen()
    if (rt.running) throw busy(rt.id)
    const outcome = await record(waitId, { kind: 'timeout' })
    if (outcome.status === 'recorded' && outcome.remaining === 0) tryContinue({})
  }

  async function pendingWaits(): Promise<PendingExternal[]> {
    const stored = await rt.state.peek()
    const pending = stored?.core?.pending
    if (pending === undefined || !isKnownPending(pending)) return []
    return structuredClone(pending.externals ?? [])
  }

  function arm(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (rt.closed) return
    const at = nextTimeoutAt(rt.state.core().pending)
    if (at === undefined) return
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS)
    timer = setTimeout(() => {
      timer = undefined
      // a running turn re-arms the timer when it ends
      if (rt.closed || rt.running) return
      void expireWaits()
        .catch((error: unknown) => {
          if (!isBusy(error)) rt.log.warn('eharness: wait expiry failed', { error })
        })
        .finally(() => arm())
    }, delay + 1)
    unref(timer)
  }

  /** Run `fn` under the session lock when the adapter has no compare-and-set (like `record`). */
  async function underLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = rt.options.lock
    if (lock === undefined || rt.state.canCas) return fn()
    const release = await lock.acquire(rt.id, { signal: rt.signal })
    try {
      return await fn()
    } finally {
      await release().catch((error: unknown) => {
        rt.log.warn('eharness: releasing the session lock failed', { error })
      })
    }
  }

  /**
   * Run the `start` of every wait of the stored pending state whose `start` was not dispatched
   * (spec 11 §4.2 rule 1), in tool-call order, then store what they returned (`started: true`,
   * correlation id, payload, timeout overrides) with a compare-and-set. A throwing `start` is
   * `W_HOOK_FAILED`; the wait stays parked until its timeout. A result that another instance
   * recorded meanwhile is kept.
   */
  async function dispatchStarts(holdsLock: boolean): Promise<void> {
    const todo = (rt.state.core().pending?.externals ?? []).filter(
      (e) => e.started === false && e.result === undefined,
    )
    if (todo.length === 0) return
    const open = await host.ensureOpen()
    await host.ensureContext()
    const message = rt.view?.find((m) => m.id === rt.state.core().pending?.messageId)
    const outs = new Map<string, WaitStart>()
    for (const entry of todo) {
      const fixed = open.tools.find((t) => t.name === entry.toolName)
      const meta = externalOf(fixed?.tool ?? (await toolOf(open, entry.toolName)))
      if (meta?.start === undefined) {
        outs.set(entry.waitId, {})
        continue
      }
      const owner = fixed?.owner ?? 'app'
      const part = message?.parts.find(
        (p) => (p as { toolCallId?: string }).toolCallId === entry.toolCallId,
      ) as { input?: unknown } | undefined
      const ctx = rt.contextOf(owner)
      try {
        const out = await meta.start(part?.input, {
          waitId: entry.waitId,
          toolCallId: entry.toolCallId,
          ctx,
          abortSignal: ctx.turn?.abortSignal ?? rt.signal,
        })
        outs.set(entry.waitId, out ?? {})
      } catch (error) {
        hookFailed(rt, `externalTool.start(${entry.toolName})`, owner, error)
        outs.set(entry.waitId, {})
      }
    }
    const store = async (): Promise<void> => {
      for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
        await refresh()
        const pending = rt.state.core().pending
        if (pending === undefined || !isKnownPending(pending)) return
        let changed = false
        for (const entry of pending.externals ?? []) {
          const out = outs.get(entry.waitId)
          // a recorded result means the work ran: nothing to store, and no write that could
          // disturb the instance that is already continuing
          if (out === undefined || entry.started !== false || entry.result !== undefined) continue
          applyStart(entry, out, Date.now)
          entry.started = true
          changed = true
        }
        if (!changed) return
        rt.state.markDirty()
        if (await rt.state.write({ cas: true })) return
        rt.state.discard()
        await rt.state.load()
      }
      rt.log.warn('eharness: storing the outcome of external start failed (state kept changing)')
    }
    await serial(() => (holdsLock ? store() : underLock(store)))
  }

  async function parked(_pending: { externals?: PendingExternal[] }): Promise<void> {
    try {
      try {
        await dispatchStarts(true)
      } catch (error) {
        rt.log.warn('eharness: starting external waits failed', { error })
      }
      await armTimers(rt.state.core().pending?.externals ?? [])
    } catch (error) {
      rt.log.warn('eharness: arming wait timeouts failed', { error })
    }
  }

  /** The redispatch in flight: an instance never starts the same wait twice at once. */
  let redispatching: Promise<void> | undefined
  function redispatch(): Promise<void> {
    redispatching ??= redispatchNow().finally(() => {
      redispatching = undefined
    })
    return redispatching
  }

  async function redispatchNow(): Promise<void> {
    try {
      if (rt.closed || rt.running) return
      await refresh()
      const pending = rt.state.core().pending
      if (pending === undefined || !isKnownPending(pending)) return
      const due = Date.now() - host.staleMs
      if (
        !(pending.externals ?? []).some(
          (e) => e.started === false && e.result === undefined && (e.parkedAt ?? 0) <= due,
        )
      ) {
        return
      }
      await dispatchStarts(false)
      await armTimers(rt.state.core().pending?.externals ?? [])
    } catch (error) {
      rt.log.warn('eharness: starting external waits failed', { error })
    }
  }

  async function armTimers(externals: PendingExternal[]): Promise<void> {
    const inbox = host.inbox
    if (inbox !== undefined) {
      for (const entry of externals) {
        if (entry.timeoutAt === undefined || entry.result !== undefined) continue
        try {
          const inboxId = await inbox.enqueue(rt.id, {
            kind: 'wait-timeout',
            waitId: entry.waitId,
            at: Date.now(),
            availableAt: entry.timeoutAt,
          })
          rt.events.emit({ type: 'inbox-enqueued', inboxId, kind: 'wait-timeout' })
        } catch (error) {
          host.warnInbox('enqueue', error) // the live timer and expireWaits() still apply
        }
      }
    }
    arm()
  }

  return {
    resolveWait,
    expireWaits,
    pendingWaits,
    expireOne,
    parked,
    redispatch,
    arm,
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
