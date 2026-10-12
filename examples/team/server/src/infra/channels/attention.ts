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
import { answerOutput, pendingQuestions, type Question, type QuestionResult } from 'eharness/ask'
import type { AgentRepo } from '../../app/ports.ts'
import type { AgentFactory } from '../eh/agent-factory.ts'
import type { ApprovalAnswerer } from './gateway.ts'

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

/** The questions of a pending `ask_user_question` call of a session (undefined when it is not pending). */
async function questionsOf(
  deps: { factory: AgentFactory },
  sessionId: string,
  itemId: string,
): Promise<Question[] | undefined> {
  const pending = await deps.factory.peek(sessionId).pending()
  const call = pendingQuestions(pending).find((q) => q.toolCallId === itemId)
  return call?.questions
}

export function channelApprovalAnswerer(deps: {
  factory: AgentFactory
  agents: AgentRepo
  store: ActivityStore
}): ApprovalAnswerer {
  const answer: ApprovalAnswerer = async (input) => {
    const def = deps.agents.get(input.agentId)
    if (def === undefined) return { status: 'not-found' }
    await deps.factory.prepare(def)
    let questionAnswer:
      | { kind: 'client-tool'; output: unknown }
      | { kind: 'client-tool'; errorText: string }
      | undefined
    if (input.kind === 'question' && input.answers !== undefined) {
      // the person answered: the same tool output the web app writes (`answerOutput`)
      const pending = await deps.factory.peek(input.sessionId).pending()
      const call = pendingQuestions(pending).find((q) => q.toolCallId === input.itemId)
      if (call === undefined) return { status: 'not-found' }
      const result: QuestionResult = input.answers === null ? null : { answers: input.answers }
      const out = answerOutput(call, result)
      questionAnswer =
        'output' in out
          ? { kind: 'client-tool', output: out.output }
          : { kind: 'client-tool', errorText: out.errorText }
    }
    const result = await answerAttention(input.itemId, {
      sessionId: input.sessionId,
      answer:
        input.kind === 'question'
          ? (questionAnswer ?? {
              kind: 'client-tool',
              errorText: input.reason ?? 'The question was not answered.',
            })
          : {
              kind: 'approval',
              approved: input.approved,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
      open: () => deps.factory.openSession(def, input.sessionId),
      peek: (id) => deps.factory.peek(id),
      actor: input.actor,
      store: deps.store,
      agentId: def.id,
    })
    return { status: result.status }
  }
  answer.questions = (input) => questionsOf(deps, input.sessionId, input.itemId)
  return answer
}
