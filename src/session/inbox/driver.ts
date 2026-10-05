/**
 * The inbox drain of one live session (internal): claims items of the durable `InboxAdapter`
 * when notified, on a poll timer and when a turn ends, and applies them in id order — steers and
 * aborts into the running turn, everything else as the next turn when the session is free here.
 *
 * Items are acked only after their effect is durable (at-least-once); redelivered items that the
 * session already applied are skipped (dedupe, `./dedupe.ts`). Items this drain still holds (the
 * ids of a started unit, the items after it, steers handed to the running turn) stay claimed:
 * every claim of the same owner renews them (`claimTtlMs`), and the items after a unit are
 * released only once its turn committed or ended, so another holder never starts them out of id
 * order.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 * @see docs/decisions/0024-durable-inbox-port.md
 */
import type {
  ActiveTurn,
  CollectOptions,
  InboxAdapter,
  InboxItem,
  SessionStateSnapshot,
} from '../../agent/session-types.ts'
import type { HarnessWarning } from '../../errors.ts'
import type { NormalizedInput } from '../input.ts'
import type { SessionRuntime } from '../runtime.ts'
import { collectDue, mergeInputs, resolveCollect } from './collect.ts'
import { inboxIdsIn } from './dedupe.ts'
import { fromSerialized } from './serialize.ts'

/** Default `inbox.pollMs`. */
export const DEFAULT_INBOX_POLL_MS = 2_000

/** One turn made from inbox items. */
export interface InboxUnit {
  kind: 'send' | 'wake'
  input: NormalizedInput | undefined
  /** Item ids (acked at the turn's commit point). */
  ids: string[]
  /** User message metadata: one item → `inboxId`, merged `collect` items → `collected`. */
  meta: { inboxId: string } | { collected: Array<{ inboxId?: string; clientId?: string }> }
}

/** The running turn as the drain sees it. */
export interface DrainTurn {
  turnId: string
  /**
   * Deliver a steer at the next step boundary; false when the turn stopped taking input.
   * Idempotent per `inboxId`: a steer the turn already holds is not delivered again.
   */
  steer(input: NormalizedInput, inboxId: string): boolean
}

/** What the session provides to its inbox drain. */
export interface DrainHost {
  rt: SessionRuntime
  adapter: InboxAdapter
  /** `recovery.staleMs` (`false`: recovery disabled, no `activeTurn` is ever written). */
  staleMs: number | false
  claimTtlMs: number
  pollMs: number
  /** Default debounce of `collect` items (`config.inbox.collect`). */
  collect: CollectOptions | undefined
  /** The turn running in this process, if any. */
  current(): DrainTurn | undefined
  /** No turn runs here, nothing is queued here: a unit may start now. */
  free(): boolean
  /** Open the session and load / validate its context (throws like a turn's preparation). */
  prepare(): Promise<void>
  /** Drop the hot cache: the stored state changed behind this instance. */
  invalidate(): void
  /** Start a unit now (the caller checked `free()`); false when it could not start. */
  start(unit: InboxUnit): boolean
  /** Abort the running turn (an abort item matched it). */
  abort(reason: string | undefined): void
  /** Called whenever the drain becomes idle (session `idle()` waiters). */
  settled(): void
}

/** The drain of one session. */
export interface InboxDrain {
  /** Drain now (coalesced: one drain at a time, re-run once if asked again meanwhile). */
  drain(): void
  /** Ack applied items and emit `inbox-drained`. */
  ack(ids: string[], turnId?: string): Promise<void>
  /** Make items ready again (their effect was not applied). */
  release(ids: string[]): Promise<void>
  /** A turn of another instance is live: do not claim until a state read says otherwise. */
  foreign(turnId: string): void
  /** A drain is running or a `collect` flush is scheduled (the session is not idle). */
  readonly busy: boolean
  close(): void
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

/** A live `activeTurn` of another instance in a stored snapshot. */
export function liveForeignTurn(
  stored: SessionStateSnapshot | null,
  owner: string,
  staleMs: number | false,
): ActiveTurn | undefined {
  const active = stored?.core?.activeTurn
  if (active === undefined || active.owner === owner) return undefined
  if (staleMs !== false && Date.now() - active.heartbeatAt > staleMs) return undefined
  return active
}

/** Create the inbox drain of a session (subscribes and starts polling at once). */
export function createInboxDrain(host: DrainHost): InboxDrain {
  const { rt, adapter } = host
  const sessionId = rt.id
  let closed = false
  let running: Promise<void> | undefined
  let again = false
  let dueTimer: ReturnType<typeof setTimeout> | undefined
  /** A live foreign turn seen by the last drain: skip claims while it is live. */
  let foreignTurn: string | undefined
  /** Claimed ids this drain keeps (unit ids, parked ids, steers of the turn): never re-applied. */
  const held = new Set<string>()
  /** The items after a started unit: kept claimed until the unit's ids are acked or released. */
  let parked: { unit: Set<string>; ids: string[] } | undefined
  /** Pending acks / releases: a drain waits for them, so it never acts on a stale claim. */
  const inflight = new Set<Promise<void>>()
  /** Drains while items are held, so their claims are renewed before they expire. */
  let renewTimer: ReturnType<typeof setInterval> | undefined

  function hold(ids: readonly string[]): void {
    for (const id of ids) held.add(id)
    if (renewTimer === undefined && held.size > 0 && !closed) {
      renewTimer = setInterval(() => drain(), Math.max(1, Math.floor(host.claimTtlMs / 3)))
      unref(renewTimer)
    }
  }

  function unhold(ids: readonly string[]): void {
    for (const id of ids) held.delete(id)
    if (held.size === 0 && renewTimer !== undefined) {
      clearInterval(renewTimer)
      renewTimer = undefined
    }
  }

  /** Ids of a unit were settled (acked or released): the items parked behind it, if any. */
  function unpark(ids: readonly string[]): string[] {
    const current = parked
    if (current === undefined || !ids.some((id) => current.unit.has(id))) return []
    parked = undefined
    return current.ids
  }

  function track(work: Promise<void>): Promise<void> {
    inflight.add(work)
    return work.finally(() => {
      inflight.delete(work)
    })
  }

  const warn = (what: string, error: unknown) => {
    const warning: HarnessWarning = {
      code: 'W_INBOX_FAILED',
      message: `Inbox ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { sessionId, operation: what },
    }
    rt.warn(warning, `inbox:${what}`)
  }

  function ack(ids: string[], turnId?: string): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    const after = unpark(ids)
    return track(
      (async () => {
        let ok = true
        try {
          await adapter.ack(ids)
        } catch (error) {
          ok = false
          warn('ack', error) // redelivered after the claim expires; dedupe skips it then
        }
        unhold(ids)
        await releaseNow(after)
        if (!ok) return
        rt.events.emit(
          turnId === undefined
            ? { type: 'inbox-drained', inboxIds: [...ids] }
            : { type: 'inbox-drained', inboxIds: [...ids], turnId },
        )
      })(),
    )
  }

  function release(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    return track(releaseNow([...ids, ...unpark(ids)]))
  }

  async function releaseNow(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    try {
      await adapter.release(ids)
    } catch (error) {
      warn('release', error) // claimable again once the claim expires
    }
    unhold(ids)
  }

  async function peek(): Promise<SessionStateSnapshot | null> {
    return rt.state.peek()
  }

  function delivered(extra: readonly string[] | undefined): Set<string> {
    const out = inboxIdsIn(rt.view ?? [])
    for (const id of rt.state.core().inboxDelivered ?? []) out.add(id)
    for (const id of extra ?? []) out.add(id)
    return out
  }

  function normalized(item: Extract<InboxItem, { kind: 'send' }>): NormalizedInput | undefined {
    try {
      return fromSerialized(item.input, {
        acceptClientMetadata: rt.options.acceptClientMetadata === true,
        files: rt.agent.config.inputFiles,
      })
    } catch (error) {
      warn('input', error)
      return undefined
    }
  }

  /** A turn runs here: aborts and steers now, everything else after it (released). */
  async function applyRunning(items: InboxItem[], turn: DrainTurn): Promise<void> {
    const done: string[] = []
    const back: string[] = []
    const seen = delivered(undefined)
    for (const item of items) {
      if (held.has(item.id)) continue // still ours: its unit or the running turn has it
      if (item.kind === 'abort') {
        if (item.turnId === undefined || item.turnId === turn.turnId) host.abort(item.reason)
        done.push(item.id)
      } else if (seen.has(item.id)) {
        done.push(item.id)
      } else if (item.kind === 'send' && item.mode === 'steer') {
        const input = normalized(item)
        if (input === undefined) {
          done.push(item.id)
          continue
        }
        // held (claim renewed) until acked once delivered and saved, or released by the turn
        hold([item.id])
        if (!turn.steer(input, item.id)) {
          unhold([item.id])
          back.push(item.id)
        }
      } else {
        back.push(item.id)
      }
    }
    await ack(done)
    await release(back)
  }

  /** Nothing runs here: the first unit starts now, the rest waits in the inbox. */
  async function applyIdle(claimed: InboxItem[]): Promise<void> {
    const items = claimed.filter((i) => !held.has(i.id))
    if (items.length === 0) return
    const all = items.map((i) => i.id)
    let stored: SessionStateSnapshot | null
    try {
      stored = await peek()
      const foreign = liveForeignTurn(stored, rt.owner, host.staleMs)
      if (foreign !== undefined) {
        foreignTurn = foreign.turnId
        await release(all)
        return
      }
      // the stored state changed behind this instance, or an item was claimed before (its
      // claimer may have applied it): reload, dedupe reads the stored messages
      const redelivered = items.some((i) => i.attempts > 1)
      const changed = stored !== null && stored.rev !== rt.state.snapshot().rev
      if ((changed || redelivered) && !rt.state.dirty) {
        host.invalidate()
      }
      await host.prepare()
    } catch (error) {
      warn('drain', error)
      await release(all)
      return
    }
    const seen = delivered(stored?.core?.inboxDelivered)
    const done: string[] = []
    const rest: InboxItem[] = []
    for (const item of items) {
      // an abort with no turn here targets a turn that ended (never held by pending approvals);
      // an item the session already applied is a redelivery
      if (item.kind === 'abort' || seen.has(item.id)) done.push(item.id)
      else rest.push(item)
    }
    const approvals =
      (stored === null ? rt.state.core().pending : stored.core?.pending) !== undefined
    if (rest.length === 0 || approvals || !host.free()) {
      await ack(done)
      await release(rest.map((i) => i.id))
      return
    }
    const unit = makeUnit(rest, seen, done)
    const used = new Set(unit === undefined ? [] : unit.ids)
    const after = rest.map((i) => i.id).filter((id) => !used.has(id) && !done.includes(id))
    await ack(done)
    if (unit === undefined) {
      await release(after)
      // an unusable head was dropped: the rest is drained at once (a collect wait has its timer)
      if (dueTimer === undefined && rest.length > 1) again = true
      return
    }
    if (closed || !host.free()) {
      await release([...unit.ids, ...after])
      return
    }
    // the items after the unit stay claimed (renewed) until its turn commits or ends, so no other
    // holder starts them before it (id order): released together with the unit's ids
    hold([...unit.ids, ...after])
    if (after.length > 0) parked = { unit: new Set(unit.ids), ids: after }
    if (!host.start(unit)) await release(unit.ids)
  }

  /** The first unit of `rest` (its head is a send or wake item that was not applied yet). */
  function makeUnit(rest: InboxItem[], seen: Set<string>, done: string[]): InboxUnit | undefined {
    const head = rest[0] as InboxItem
    if (head.kind === 'wake') {
      const ids: string[] = []
      for (const item of rest) {
        if (item.kind !== 'wake') break
        if (seen.has(item.id)) done.push(item.id)
        else ids.push(item.id)
      }
      const first = ids[0]
      return first === undefined
        ? undefined
        : { kind: 'wake', input: undefined, ids, meta: { inboxId: first } }
    }
    if (head.kind !== 'send') return undefined
    if (head.mode !== 'collect') {
      const input = normalized(head)
      if (input === undefined) {
        done.push(head.id)
        return undefined
      }
      return { kind: 'send', input, ids: [head.id], meta: { inboxId: head.id } }
    }
    const options = resolveCollect(host.collect, head.collect)
    const burst: Array<Extract<InboxItem, { kind: 'send' }>> = []
    for (const item of rest) {
      if (item.kind !== 'send' || item.mode !== 'collect') break
      if (seen.has(item.id)) {
        done.push(item.id)
        continue
      }
      burst.push(item)
    }
    if (burst.length === 0) return undefined
    const count = Math.min(burst.length, options.maxItems)
    const taken = burst.slice(0, count)
    const due = collectDue(
      {
        firstAt: (taken[0] as InboxItem).at,
        lastAt: Math.max(...burst.map((i) => i.at)),
        count: burst.length,
      },
      options,
      Date.now(),
    )
    if (!due.due) {
      schedule(due.at)
      return undefined
    }
    const inputs: NormalizedInput[] = []
    const collected: Array<{ inboxId?: string; clientId?: string }> = []
    const ids: string[] = []
    for (const item of taken) {
      ids.push(item.id)
      const input = normalized(item)
      if (input === undefined) continue
      inputs.push(input)
      collected.push(
        input.clientId === undefined
          ? { inboxId: item.id }
          : { inboxId: item.id, clientId: input.clientId },
      )
    }
    if (inputs.length === 0) {
      done.push(...ids)
      return undefined
    }
    return { kind: 'send', input: mergeInputs(inputs), ids, meta: { collected } }
  }

  /** Drain again at `at` (a `collect` burst becomes due). */
  function schedule(at: number): void {
    if (closed) return
    if (dueTimer !== undefined) clearTimeout(dueTimer)
    dueTimer = setTimeout(
      () => {
        dueTimer = undefined
        drain()
      },
      Math.max(0, at - Date.now()) + 1,
    )
    unref(dueTimer)
  }

  async function drainOnce(): Promise<void> {
    while (inflight.size > 0) await Promise.all([...inflight])
    if (closed) return
    let turn = host.current()
    if (turn === undefined) {
      if (!host.free()) return // a turn is starting or compact() runs: drained when it ends
      if (foreignTurn !== undefined) {
        const foreign = liveForeignTurn(await peek(), rt.owner, host.staleMs)
        if (foreign !== undefined) {
          foreignTurn = foreign.turnId
          return
        }
        foreignTurn = undefined
      }
    }
    const items = await adapter.claim(sessionId, rt.owner, { claimTtlMs: host.claimTtlMs })
    if (items.length === 0) return
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const notHeld = () => items.filter((i) => !held.has(i.id)).map((i) => i.id)
    if (closed) {
      await release(notHeld())
      return
    }
    turn = host.current()
    if (turn !== undefined) return applyRunning(items, turn)
    if (!host.free()) {
      await release(notHeld())
      return
    }
    return applyIdle(items)
  }

  function drain(): void {
    if (closed) return
    if (running !== undefined) {
      again = true
      return
    }
    running = (async () => {
      do {
        again = false
        try {
          await drainOnce()
        } catch (error) {
          warn('claim', error)
        }
      } while (again && !closed)
    })().finally(() => {
      running = undefined
      host.settled()
    })
  }

  let unsubscribe: (() => void) | undefined
  if (adapter.subscribe !== undefined) {
    try {
      unsubscribe = adapter.subscribe(sessionId, () => drain())
    } catch (error) {
      warn('subscribe', error)
    }
  }
  let pollTimer: ReturnType<typeof setInterval> | undefined
  if (host.pollMs > 0) {
    pollTimer = setInterval(() => drain(), host.pollMs)
    unref(pollTimer)
  }
  queueMicrotask(drain)

  return {
    drain,
    ack,
    release,
    foreign(turnId) {
      foreignTurn = turnId
    },
    get busy() {
      return running !== undefined || dueTimer !== undefined
    },
    close() {
      closed = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      if (renewTimer !== undefined) clearInterval(renewTimer)
      renewTimer = undefined
      if (dueTimer !== undefined) clearTimeout(dueTimer)
      dueTimer = undefined
      try {
        unsubscribe?.()
      } catch {}
    },
  }
}
