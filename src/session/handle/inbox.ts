import { asSchema } from 'ai'
import type { AbortRequestResult, StateAdapter } from '../../agent/session-types.ts'
import { HarnessError, storageError } from '../../errors.ts'
import { errorText } from '../../internal/util.ts'
import { createKindMessage } from '../../messages/kinds.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { liveForeignTurn } from '../inbox/driver.ts'
import { kindText } from '../interaction/inbox.ts'
import { DEFAULT_STALE_MS, requestRemoteAbort } from '../remote-abort.ts'
import type { SessionCtx } from './ctx.ts'
import { ensureContext, ensureOpen, persist } from './open.ts'
import { assertOpen, begin, enqueue, touch } from './queue.ts'

/** The kind's projection for inline delivery; a throwing projection is not delivered inline. */
export function inlineText(
  s: SessionCtx,
  message: HarnessUIMessage,
  kind: string,
): string | undefined {
  try {
    return kindText(message, s.internals.messages, s.id)
  } catch (error) {
    s.rt.warn(
      {
        code: 'W_HOOK_FAILED',
        message: `The model projection of kind '${kind}' threw; the message is not delivered into the running turn: ${errorText(error)}`,
        details: { kind },
      },
      `kind:${kind}`,
    )
    return undefined
  }
}

/** Request the abort of a turn running in another instance (spec 05 §9.1, §12 rule 4). */
export async function remoteAbort(
  s: SessionCtx,
  reason: string | undefined,
): Promise<AbortRequestResult> {
  const inbox = s.args.inbox
  const staleMs =
    s.config.recovery === false ? false : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS)
  if (inbox !== undefined && staleMs !== false) {
    let stored: Awaited<ReturnType<StateAdapter['get']>>
    try {
      stored = await s.args.state.get(s.id)
    } catch (error) {
      throw new HarnessError('EH_STORAGE', 'State storage failed (abort request).', {
        cause: error,
      })
    }
    const active = liveForeignTurn(stored, s.rt.owner, staleMs, s.rt)
    if (active === undefined) return { target: 'idle' }
    try {
      const inboxId = await inbox.enqueue(s.id, {
        kind: 'abort',
        turnId: active.turnId,
        at: Date.now(),
        ...(reason === undefined ? {} : { reason }),
      })
      s.events.emit({ type: 'inbox-enqueued', inboxId, kind: 'abort' })
      await notify(s)
      return { target: 'remote' }
    } catch (error) {
      // the state path stays the fallback (ADR-0021)
      inboxWarning(s, 'enqueue', error)
    }
  }
  return stateAbort(s, reason)
}

export function inboxWarning(s: SessionCtx, operation: string, error: unknown): void {
  s.rt.warn(
    {
      code: 'W_INBOX_FAILED',
      message: `Inbox ${operation} failed: ${errorText(error)}`,
      details: { sessionId: s.id, operation },
    },
    `inbox:${operation}`,
  )
}

/** Wake the instances subscribed to this session (best effort). */
export async function notify(s: SessionCtx): Promise<void> {
  try {
    await s.args.inbox?.notify?.(s.id)
  } catch (error) {
    inboxWarning(s, 'notify', error)
  }
}
/** Dedupe key of the `wake` item of a kind message (spec 05 §12 rule 17). */
export function wakeKey(_s: SessionCtx, messageId: string): string {
  return `wake:${messageId}`
}

/** Store a `wake` item of an already saved kind message; false when the inbox failed. */
export async function holdWakeDurably(s: SessionCtx, messageId: string): Promise<boolean> {
  if (s.args.inbox === undefined || s.drain === undefined) return false
  try {
    // one item per event, also when an app repairs a stranded one (`wake:<messageId>`, ADR-0054)
    const item = { kind: 'wake' as const, messageId, at: Date.now() }
    if (s.args.inbox.enqueueOnce !== undefined) {
      const stored = await s.args.inbox.enqueueOnce(s.id, {
        ...item,
        dedupeKey: wakeKey(s, messageId),
      })
      if (!stored.duplicate)
        s.events.emit({ type: 'inbox-enqueued', inboxId: stored.id, kind: 'wake' })
    } else {
      const inboxId = await s.args.inbox.enqueue(s.id, item)
      s.events.emit({ type: 'inbox-enqueued', inboxId, kind: 'wake' })
    }
    await notify(s)
    return true
  } catch (error) {
    inboxWarning(s, 'enqueue', error)
    return false
  }
}

/** Approvals or client tool calls of this session wait for an answer (stored state). */
export async function storedPending(s: SessionCtx): Promise<boolean> {
  try {
    return (await s.args.state.get(s.id))?.core?.pending !== undefined
  } catch (error) {
    s.warnLimited(
      'stored-pending',
      'eharness: reading the stored pending state failed (using the cached one)',
      { error },
    )
    return s.rt.state.core().pending !== undefined
  }
}

/** A turn of this session running in another instance, read from the stored state. */
export async function foreignTurn(s: SessionCtx): Promise<string | undefined> {
  const staleMs =
    s.config.recovery === false ? false : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS)
  if (staleMs === false) return undefined
  let stored: Awaited<ReturnType<StateAdapter['get']>>
  try {
    stored = await s.args.state.get(s.id)
  } catch (error) {
    // the drain decides (it releases what a busy session cannot take)
    s.warnLimited('foreign-turn', 'eharness: reading the stored state for a foreign turn failed', {
      error,
    })
    return undefined
  }
  return liveForeignTurn(stored, s.rt.owner, staleMs, s.rt)?.turnId
}

export function stateAbort(s: SessionCtx, reason: string | undefined): Promise<AbortRequestResult> {
  return requestRemoteAbort(
    {
      sessionId: s.id,
      adapter: s.args.state,
      owner: s.rt.owner,
      staleMs:
        s.config.recovery === false ? false : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS),
      warn: s.rt.warn,
      // the stored state changed behind this instance's cache: reload at the next operation
      written: () => {
        if (s.current === undefined && s.loading === undefined) s.rt.view = undefined
      },
    },
    reason,
  )
}

export async function injectOnce(
  s: SessionCtx,
  kind: string,
  data: unknown,
  options: { key?: string; wake?: boolean; deliver?: 'next-step' | 'end-of-turn' | string },
): Promise<{ message: unknown; run?: unknown }> {
  assertOpen(s)
  const registered = s.internals.messages.kind(kind)
  if (registered === undefined) {
    throw new HarnessError('EH_INVALID_INPUT', `Unknown message kind '${kind}'.`, {
      details: { kind },
    })
  }
  const validate = asSchema(registered.def.schema).validate
  let value: unknown = data
  if (validate !== undefined) {
    const result = await validate(data)
    if (!result.success) {
      throw new HarnessError(
        'EH_INVALID_INPUT',
        `Invalid payload for kind '${kind}': ${result.error.message}`,
        { details: { kind }, cause: result.error },
      )
    }
    value = result.value
  }
  const key = options.key
  if (key !== undefined && (typeof key !== 'string' || key === '' || key.length > 200)) {
    throw new HarnessError(
      'EH_INVALID_INPUT',
      'inject({ key }) must be a non-empty string of at most 200 characters.',
    )
  }
  touch(s)
  await ensureOpen(s)
  if (key !== undefined) {
    // stored messages, not the hot cache: another instance may have saved it
    let recent: HarnessUIMessage[] = []
    try {
      recent = (await s.rt.messages.load({ sessionId: s.id, limit: 200 })) as HarnessUIMessage[]
    } catch (error) {
      throw storageError('Message', 'load', error)
    }
    const existing = recent.find((m) => m.metadata?.eharness?.key === key)
    if (existing !== undefined) return { message: structuredClone(existing) as never }
  }
  if (s.rt.view === undefined) await ensureContext(s)
  const message = createKindMessage(kind, value, {
    id: s.rt.nextId(),
    role: registered.def.role,
    createdAt: Date.now(),
    parentId: s.rt.view?.at(-1)?.id ?? null,
    ...(s.rt.turn === undefined ? {} : { turnId: s.rt.turn.info.id }),
    ...(key === undefined ? {} : { key }),
  })
  const [saved] = await persist(s, [message])
  const out = saved ?? message
  s.events.emit({ type: 'message', message: out as never })
  const result = { message: structuredClone(out) as never }
  const wake = options.wake === true
  // next-step delivery (wake while running implies it, spec 11 §6.3)
  if ((options.deliver === 'next-step' || wake) && s.current !== undefined) {
    const text = inlineText(s, out, kind)
    if (text !== undefined && s.current.deliverEvent(out, text, wake)) return result
  }
  if (!wake || s.rt.closed) return result
  // a turn of this session runs in another instance, or approvals / client tool calls wait for
  // an answer (stored, so also those another instance parked): hand the wake to the durable
  // inbox. Whoever holds the session runs it once it is free (spec 05 §12, ADR-0054)
  if (
    s.current === undefined &&
    !s.rt.running &&
    s.args.inbox !== undefined &&
    s.drain !== undefined
  ) {
    const foreign = await foreignTurn(s)
    const parked = foreign === undefined && (await storedPending(s))
    if (foreign !== undefined || parked) {
      if (await holdWakeDurably(s, out.id)) {
        if (foreign !== undefined) s.drain.foreign(foreign)
        return result
      }
    }
  }
  if (s.rt.closed) return result
  // wake an idle session now; otherwise (a turn is ending, compact() runs, or approvals wait
  // for an answer) a no-input wake turn is queued and runs when the session is free
  if (!s.rt.running && s.rt.state.core().pending === undefined) {
    return {
      ...result,
      run: begin(s, { kind: 'wake', input: undefined, options: {}, queued: false }) as never,
    }
  }
  return { ...result, run: enqueue(s, { kind: 'wake', input: undefined, options: {} }) as never }
}
