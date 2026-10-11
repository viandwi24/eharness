import type { HarnessUIMessage, StopReason } from '../../messages/types.ts'
import type { InboxSettle } from '../inbox/driver.ts'
import type { TurnCtx } from './ctx.ts'
import { withoutUndefined } from './helpers.ts'

/** Settle the op's inbox items once (ack when applied, else by outcome). */
export function settleOpInbox(t: TurnCtx, how: 'applied' | InboxSettle): void {
  const items = t.op.inbox
  if (items === undefined || t.inboxSettled) return
  t.inboxSettled = true
  if (how === 'applied') t.host.inboxApplied(items.ids, t.turnId)
  else t.host.inboxNotApplied(items.ids, how)
}

/**
 * Set `deliveredIn` on kind messages delivered as `data-eh.input` whose part is in the saved
 * snapshot of finish-step `upTo` (spec 11 §6.3: at-least-once, never zero times).
 */
export async function markDelivered(t: TurnCtx, upTo: number): Promise<void> {
  // inbox steers in the saved snapshot are applied (spec 05 §12 rule 5)
  const steers: string[] = []
  for (const entry of t.deliveredSteers) {
    if (entry.done || entry.afterFinish >= upTo) continue
    entry.done = true
    steers.push(entry.inboxId)
  }
  if (steers.length > 0) t.host.inboxApplied(steers, t.turnId)
  for (const entry of t.deliveredEvents) {
    if (entry.done || entry.afterFinish >= upTo || t.assistantId === undefined) continue
    entry.done = true
    const eharness = entry.message.metadata?.eharness
    const updated: HarnessUIMessage = {
      ...entry.message,
      metadata: {
        ...entry.message.metadata,
        eharness: { ...(eharness ?? { v: 1, createdAt: t.startedAt }), deliveredIn: t.assistantId },
      },
    }
    try {
      await t.host.persist([updated])
    } catch (error) {
      entry.done = false
      t.rt.log.warn('eharness: marking a delivered event failed; it may be projected again', {
        error,
      })
    }
  }
}

/** Undelivered steers: queued `send` turns, or `input-dropped` for tool-pending / aborts. */
export async function settleInbox(t: TurnCtx, stop: StopReason): Promise<void> {
  const leftovers = await t.inbox.close()
  let wake = false
  const wakeIds: string[] = []
  for (const item of leftovers) {
    const steer = item.steer
    if (steer === undefined) {
      // an undelivered event stays for the next turn; a wake starts that turn (not after aborts)
      if (item.wake === true && stop !== 'aborted' && stop !== 'timeout') {
        wake = true
        if (item.event !== undefined) wakeIds.push(item.event.id)
      }
      continue
    }
    if (stop === 'tool-pending' || stop === 'aborted' || stop === 'timeout') {
      t.rt.events.emit(
        withoutUndefined({
          type: 'input-dropped' as const,
          reason: stop === 'tool-pending' ? ('tool-pending' as const) : ('aborted' as const),
          text: steer.text,
          clientId: steer.input.clientId,
        }),
      )
      item.settle?.('dropped')
      // a closing session hands a durable steer to the next holder; otherwise it is dropped
      if (item.inboxId !== undefined) {
        t.host.inboxNotApplied([item.inboxId], t.rt.closed ? { how: 'defer' } : { how: 'drop' })
      }
    } else {
      // a durable steer is released before the session's end-of-turn drain runs
      await t.host.enqueueSteer({ input: steer.input, contexts: steer.contexts }, item.inboxId)
      item.settle?.(t.rt.closed ? 'dropped' : 'turn')
    }
  }
  if (wake) await t.host.enqueueWake(wakeIds, stop === 'tool-pending')
}
