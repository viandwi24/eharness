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
 * With `inbox.retry` every release is classified (rule 11): a deferral (the item was not tried)
 * undoes the claim's attempt (`uncount`), a failed attempt waits a backoff (`delayMs`) and records
 * `lastError`; an item past `maxAttempts` or failing with a non-retryable error is dead-lettered
 * and reported (rules 12–13). Without `inbox.retry` releases carry no options (0.4).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 * @see docs/decisions/0024-durable-inbox-port.md
 * @see docs/decisions/0026-inbox-retries-and-dead-letter.md
 */
import type {
  ActiveTurn,
  CollectOptions,
  DeadInboxItem,
  InboxAdapter,
  InboxItem,
  InboxReleaseOptions,
  SessionStateSnapshot,
} from '../../agent/session-types.ts'
import type { InboxRetryOptions } from '../../agent/types.ts'
import { HarnessError, type HarnessWarning } from '../../errors.ts'
import type { NormalizedInput } from '../input.ts'
import type { SessionRuntime } from '../runtime.ts'
import { collectDue, mergeInputs, resolveCollect } from './collect.ts'
import { inboxIdsIn } from './dedupe.ts'
import { backoffDelay, failureText, isNonRetryable } from './retry.ts'
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

/**
 * How a unit's items end when they were not applied (spec 05 §12 rules 3, 11, 13):
 * - `defer`: not tried (held, dropped by `close()`, a missed steer) — released, attempt undone;
 * - `retry`: a failed attempt that is always retried (`EH_SESSION_BUSY` / `EH_STORAGE` before the
 *   commit point, a write after it) — released with backoff;
 * - `error`: failed before the commit point with another error — acked without `inbox.retry`
 *   (0.4); with it dead at once when non-retryable, else like `retry`;
 * - `drop`: an outcome, not a failure (input blocked, aborted by its caller) — acked.
 */
export type InboxSettle =
  | { how: 'defer' }
  | { how: 'retry'; error: unknown }
  | { how: 'error'; error: unknown }
  | { how: 'drop' }

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
  /** `config.inbox.retry` (undefined: 0.4 behaviour, releases carry no options). */
  retry: InboxRetryOptions | undefined
  /** `config.inbox.onDeadLetter`. */
  onDeadLetter: ((item: DeadInboxItem) => void | Promise<void>) | undefined
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
  /** Apply a due `wait-timeout` item: record the wait's timeout result (spec 11 §4.2 rule 6). */
  expireWait(waitId: string): Promise<void>
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
  /** Make items ready again without trying them (a deferral, `settle(ids, { how: 'defer' })`). */
  release(ids: string[]): Promise<void>
  /** Settle items whose effect was not applied (release, retry with backoff, ack or dead). */
  settle(ids: string[], outcome: InboxSettle): Promise<void>
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
  /** Drain when the earliest backoff of a failed attempt ends (also without polling). */
  let retryTimer: { at: number; timer: ReturnType<typeof setTimeout> } | undefined
  /** The items this drain claimed and did not settle yet (attempts, kind, lastError). */
  const claimed = new Map<string, InboxItem>()
  const retry = host.retry

  function hold(ids: readonly string[]): void {
    for (const id of ids) held.add(id)
    if (renewTimer === undefined && held.size > 0 && !closed) {
      renewTimer = setInterval(() => drain(), Math.max(1, Math.floor(host.claimTtlMs / 3)))
      unref(renewTimer)
    }
  }

  function unhold(ids: readonly string[]): void {
    for (const id of ids) {
      held.delete(id)
      claimed.delete(id)
    }
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
    return settle(ids, { how: 'defer' })
  }

  function settle(ids: string[], outcome: InboxSettle): Promise<void> {
    if (ids.length === 0) return Promise.resolve()
    if (outcome.how === 'drop' || (outcome.how === 'error' && retry === undefined)) {
      // an outcome (or a 0.4 drop): acked; `ack` releases the items parked behind the unit
      return ack(ids)
    }
    const after = unpark(ids)
    return track(
      (async () => {
        if (outcome.how === 'defer') {
          await releaseNow(ids)
        } else if (outcome.how === 'error' && isNonRetryable(retry ?? {}, outcome.error)) {
          await bury(items(ids), 'non-retryable', failureText(outcome.error))
        } else {
          await releaseFailed(ids, outcome.error)
        }
        await releaseNow(after)
      })(),
    )
  }

  /** The claimed items of `ids` (a minimal stand-in for one this drain did not claim). */
  function items(ids: readonly string[]): InboxItem[] {
    return ids.map(
      (id) => claimed.get(id) ?? { kind: 'wake', messageId: '', at: Date.now(), id, attempts: 1 },
    )
  }

  /** Release items; without options a deferral (with `inbox.retry` its attempt is undone). */
  async function releaseNow(ids: string[], opts?: InboxReleaseOptions): Promise<void> {
    if (ids.length === 0) return
    try {
      // always with `owner`: a stale holder's release must not touch a newer owner's claim
      if (retry === undefined) await adapter.release(ids, { owner: rt.owner })
      else await adapter.release(ids, { ...(opts ?? { uncount: true }), owner: rt.owner })
    } catch (error) {
      warn('release', error) // claimable again once the claim expires
    }
    unhold(ids)
  }

  /** Release items after a failed attempt: backoff from their attempts, `lastError`. */
  async function releaseFailed(ids: string[], error: unknown): Promise<void> {
    if (retry === undefined) return releaseNow(ids)
    const attempts = Math.max(1, ...items(ids).map((i) => i.attempts))
    const delayMs = backoffDelay(attempts, retry.backoff)
    await releaseNow(ids, { delayMs, lastError: failureText(error) })
    wakeAt(Date.now() + delayMs)
  }

  /** Drain once a backoff ended (the poll would find it too; this also works with `pollMs: 0`). */
  function wakeAt(at: number): void {
    if (closed) return
    if (retryTimer !== undefined && retryTimer.at <= at) return
    if (retryTimer !== undefined) clearTimeout(retryTimer.timer)
    const timer = setTimeout(
      () => {
        retryTimer = undefined
        drain()
      },
      Math.max(0, at - Date.now()) + 1,
    )
    unref(timer)
    retryTimer = { at, timer }
  }

  /** `inbox.retry.maxAttempts` is set and the item's counted claims exceed it (rule 12). */
  function overLimit(item: InboxItem): boolean {
    const max = retry?.maxAttempts
    return max !== undefined && item.kind !== 'abort' && item.attempts > max
  }

  /**
   * Dead-letter items (rule 12): `deadLetter` (or, without it, `ack` after reporting), then
   * report them (`onDeadLetter`, `inbox-dead`, `W_INBOX_DEAD_LETTER`). Never loses an item: a
   * failed `deadLetter` (or a failed `onDeadLetter` without one) releases it (a deferral).
   */
  async function bury(list: InboxItem[], reason: string, lastError?: string): Promise<void> {
    if (list.length === 0) return
    const ids = list.map((i) => i.id)
    const deadAt = Date.now()
    const dead = list.map((item): DeadInboxItem => {
      const out: DeadInboxItem = { ...structuredClone(item), sessionId, deadAt, reason }
      const text = lastError ?? item.lastError
      if (text !== undefined) out.lastError = text
      return out
    })
    if (adapter.deadLetter !== undefined) {
      try {
        const info = lastError === undefined ? { reason } : { reason, lastError }
        await adapter.deadLetter(ids, info)
      } catch (error) {
        warn('deadLetter', error)
        await releaseNow(ids)
        return
      }
      unhold(ids)
      for (const item of dead) {
        await callback(item)
        announce(item)
      }
      return
    }
    // no dead store: the application's callback is the dead store, so it runs first
    for (const item of dead) {
      if (!(await callback(item))) {
        // a throwing callback must not make the item spin: released with a backoff delay
        if (retry === undefined) await releaseNow([item.id])
        else {
          const delayMs = backoffDelay(Math.max(1, item.attempts), retry.backoff)
          await releaseNow([item.id], { uncount: true, delayMs })
          wakeAt(Date.now() + delayMs)
        }
        continue
      }
      try {
        await adapter.ack([item.id])
      } catch (error) {
        warn('ack', error) // redelivered after the claim expires, reported again then
      }
      unhold([item.id])
      announce(item)
    }
  }

  /** Run `onDeadLetter` (false when it threw: `W_HOOK_FAILED`). */
  async function callback(item: DeadInboxItem): Promise<boolean> {
    if (host.onDeadLetter === undefined) return true
    try {
      await host.onDeadLetter(structuredClone(item))
      return true
    } catch (error) {
      rt.warn(
        {
          code: 'W_HOOK_FAILED',
          message: `inbox.onDeadLetter threw: ${error instanceof Error ? error.message : String(error)}`,
          details: { hook: 'inbox.onDeadLetter', owner: 'app', sessionId, inboxId: item.id },
        },
        `inbox:onDeadLetter:${item.id}`,
      )
      return false
    }
  }

  /** The `inbox-dead` event and the `W_INBOX_DEAD_LETTER` warning of a dead item. */
  function announce(item: DeadInboxItem): void {
    rt.events.emit({
      type: 'inbox-dead',
      inboxId: item.id,
      kind: item.kind,
      reason: item.reason,
      attempts: item.attempts,
    })
    const why = item.lastError === undefined ? '' : ` (${item.lastError})`
    rt.warn(
      {
        code: 'W_INBOX_DEAD_LETTER',
        message: `Inbox item ${item.id} (${item.kind}) is dead after ${item.attempts} attempt(s): ${item.reason}${why}`,
        details: {
          sessionId,
          inboxId: item.id,
          kind: item.kind,
          attempts: item.attempts,
          reason: item.reason,
        },
      },
      `inbox:dead:${item.id}`,
    )
  }

  /** Stored inputs that no longer normalize (with `inbox.retry`): dead or retried (rule 13). */
  async function settleBad(list: Array<{ item: InboxItem; error: unknown }>): Promise<void> {
    for (const { item, error } of list) {
      if (isNonRetryable(retry ?? {}, error)) {
        await bury([item], 'non-retryable', failureText(error))
      } else await releaseFailed([item.id], error)
    }
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

  /** Stored inputs of the current drain that no longer normalize (only with `inbox.retry`). */
  let bad: Array<{ item: InboxItem; error: unknown }> = []

  function normalized(item: Extract<InboxItem, { kind: 'send' }>): NormalizedInput | undefined {
    try {
      return fromSerialized(item.input, {
        acceptClientMetadata: rt.options.acceptClientMetadata === true,
        files: rt.agent.config.inputFiles,
      })
    } catch (error) {
      warn('input', error)
      if (retry !== undefined) bad.push({ item, error })
      return undefined
    }
  }

  /** A turn runs here: aborts and steers now, everything else after it (released). */
  async function applyRunning(items: InboxItem[], turn: DrainTurn): Promise<void> {
    const done: string[] = []
    const back: string[] = []
    const dead: InboxItem[] = []
    const seen = delivered(undefined)
    bad = []
    for (const item of items) {
      if (held.has(item.id)) continue // still ours: its unit or the running turn has it
      if (item.kind === 'abort') {
        if (item.turnId === undefined || item.turnId === turn.turnId) host.abort(item.reason)
        done.push(item.id)
      } else if (seen.has(item.id)) {
        done.push(item.id)
      } else if (overLimit(item)) {
        dead.push(item)
      } else if (item.kind === 'send' && item.mode === 'steer') {
        const input = normalized(item)
        if (input === undefined) {
          if (retry === undefined) done.push(item.id)
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
    const invalid = bad
    bad = []
    await ack(done)
    await bury(dead, 'max-attempts')
    await settleBad(invalid)
    await release(back)
  }

  /** Nothing runs here: the first unit starts now, the rest waits in the inbox. */
  async function applyIdle(batch: InboxItem[]): Promise<void> {
    const items = batch.filter((i) => !held.has(i.id))
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
      // a failure of the session, not of its items: a deferral (a storage outage never
      // dead-letters healthy items), drained again after the minimum backoff
      if (retry === undefined) await release(all)
      else {
        const delayMs = backoffDelay(1, retry.backoff)
        await track(releaseNow(all, { uncount: true, delayMs, lastError: failureText(error) }))
        wakeAt(Date.now() + delayMs)
      }
      return
    }
    const seen = delivered(stored?.core?.inboxDelivered)
    const done: string[] = []
    const rest: InboxItem[] = []
    const dead: InboxItem[] = []
    const timeouts: Array<Extract<InboxItem, { kind: 'wait-timeout' }>> = []
    for (const item of items) {
      // an abort with no turn here targets a turn that ended (never held by pending approvals);
      // an item the session already applied is a redelivery (dedupe runs before attempt limits)
      if (item.kind === 'abort' || seen.has(item.id)) done.push(item.id)
      else if (overLimit(item)) dead.push(item)
      else if (item.kind === 'wait-timeout')
        timeouts.push(item) // like aborts: never held by pending
      else rest.push(item)
    }
    if (dead.length > 0) {
      await ack(done.splice(0))
      await bury(dead, 'max-attempts')
    }
    // due wait timeouts: recorded with a compare-and-set, idempotent (a wait that is already
    // resolved or gone just acks); a busy or failing session retries them (spec 05 §12 rule 15)
    for (const item of timeouts) {
      try {
        await host.expireWait(item.waitId)
        done.push(item.id)
      } catch (error) {
        const busy = error instanceof HarnessError && error.code === 'EH_SESSION_BUSY'
        await settle([item.id], busy ? { how: 'defer' } : { how: 'retry', error })
      }
    }
    const approvals =
      timeouts.length > 0
        ? rt.state.core().pending !== undefined
        : (stored === null ? rt.state.core().pending : stored.core?.pending) !== undefined
    if (rest.length === 0 || approvals || !host.free()) {
      await ack(done)
      await release(rest.map((i) => i.id))
      return
    }
    bad = []
    const unit = makeUnit(rest, seen, done)
    const invalid = bad
    bad = []
    const used = new Set(unit === undefined ? [] : unit.ids)
    for (const entry of invalid) used.add(entry.item.id)
    const after = rest.map((i) => i.id).filter((id) => !used.has(id) && !done.includes(id))
    await ack(done)
    await settleBad(invalid)
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
        if (retry === undefined) done.push(head.id)
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
      const input = normalized(item)
      // 0.4: an invalid input rides along (acked with the unit); with `inbox.retry` it is settled
      // on its own (dead or retried)
      if (input === undefined && retry !== undefined) continue
      ids.push(item.id)
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
    for (const item of items) if (!held.has(item.id)) claimed.set(item.id, item)
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
    settle,
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
      if (retryTimer !== undefined) clearTimeout(retryTimer.timer)
      retryTimer = undefined
      try {
        unsubscribe?.()
      } catch {}
    },
  }
}
