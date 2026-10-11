/**
 * The two seams between the channels gateway and the rest of the app, kept out of `main.ts`:
 *
 *  - `watchPendingChanges` wraps the activity store: every `pending-changed` event of a channel
 *    session tells the gateway what still waits, so an approval announced in a chat is updated
 *    when the web app (or anything else) answers it first.
 *  - `channelApprovalAnswerer` answers an item the way the web app does (the library's
 *    `answerAttention`, on the session that owns it), for the buttons of a chat.
 */
import { type ActivityStore, answerAttention } from 'eharness/activity'
import type { AgentRepo } from '../../app/ports.ts'
import type { AgentFactory } from '../eh/agent-factory.ts'
import type { ApprovalAnswerInput } from './gateway.ts'

export function watchPendingChanges(
  inner: ActivityStore,
  onChange: (event: { sessionId: string; waiting: string[] }) => Promise<void> | undefined,
): ActivityStore {
  return {
    ...inner,
    append: async (events) => {
      const records = await inner.append(events)
      for (const r of records) {
        if (r.type !== 'pending-changed' || r.sessionId === null) continue
        if (!r.sessionId.startsWith('channel:')) continue
        const waiting = Array.isArray(r.payload.waiting)
          ? (r.payload.waiting as Array<{ id?: unknown }>)
              .map((w) => w.id)
              .filter((id): id is string => typeof id === 'string')
          : []
        // never let a gateway problem break the feed
        void Promise.resolve(onChange({ sessionId: r.sessionId, waiting })).catch(() => undefined)
      }
      return records
    },
    read: (q) => inner.read(q),
    lastSeq: () => inner.lastSeq(),
    prunedThrough: () => inner.prunedThrough(),
    prune: (o) => inner.prune(o),
  }
}

export function channelApprovalAnswerer(deps: {
  factory: AgentFactory
  agents: AgentRepo
  store: ActivityStore
}): (input: ApprovalAnswerInput) => Promise<{
  status: 'resumed' | 'recorded' | 'already-answered' | 'not-found'
}> {
  return async (input) => {
    const def = deps.agents.get(input.agentId)
    if (def === undefined) return { status: 'not-found' }
    await deps.factory.prepare(def)
    const result = await answerAttention(input.itemId, {
      sessionId: input.sessionId,
      answer: { kind: 'approval', approved: input.approved },
      open: () => deps.factory.openSession(def, input.sessionId),
      peek: (id) => deps.factory.peek(id),
      actor: input.actor,
      store: deps.store,
      agentId: def.id,
    })
    return { status: result.status }
  }
}
