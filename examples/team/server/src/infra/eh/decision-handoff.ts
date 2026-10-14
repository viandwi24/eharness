/**
 * Answers the decisions that park a run on an external wait (`escalate_wait`, `request_authority`)
 * through `eharness/handoff` (spec 32): `resolveHandoff` does the option check and the
 * compare-and-set on the decisions table (`decisions-handoff-store.ts`), then hands the answer to
 * the session. The delivery is the team's own (`decision-service.ts`): the agent reads the
 * structured answer `{ decision, note, answeredBy, attribution }` and the continuation keeps its
 * report spec and step limit, which the library's text answer cannot carry.
 *
 * A losing answer never delivers (`resolveHandoff` delivers only for the winner). The claim rides
 * in the same compare-and-set as the answer through `metadata` (`claimMetadata`), and `output`
 * is the structured answer the agent reads. The sessions adapter stays thin: the continuation
 * options (report spec, step limit, output cap), the busy retry and the run tracking depend on the
 * agent definition, which `DecisionService.resume` owns.
 */
import { resolveHandoff } from 'eharness/handoff'
import type { DecisionHandoff, DecisionStore, ParkedAnswer, ParkedResult } from '../../app/ports.ts'
import type { Decision, DecisionAnswer } from '../../domain/decisions.ts'
import type { DecisionService } from './decision-service.ts'
import { claimMetadata, decisionHandoffStore, REJECT_OPTION } from './decisions-handoff-store.ts'

const CLIENT_ID = 'client'

export function createDecisionHandoff(
  decisions: DecisionStore,
  resolver: Pick<DecisionService, 'resume'>,
): DecisionHandoff {
  const store = decisionHandoffStore(decisions)
  return {
    async answerParked(d: Decision, a: ParkedAnswer): Promise<ParkedResult> {
      let reached = false
      let delivery = 'resumed' as 'resumed' | 'recorded' | 'gone'
      const sessions = {
        session: () => ({
          async resolveWait(_waitId: string, result: { output: unknown } | { errorText: string }) {
            reached = true
            a.beforeDeliver?.()
            const answer = (result as { output: DecisionAnswer }).output
            delivery = await resolver.resume(decisions.get(d.id) ?? d, answer)
            return { status: 'recorded' as const, remaining: 0 }
          },
        }),
      }
      try {
        const resolution = await resolveHandoff({
          store,
          sessions,
          id: d.id,
          answer: {
            optionId: a.status === 'rejected' ? REJECT_OPTION : a.outcome.decision,
            text: a.note,
            by: CLIENT_ID,
            at: a.decidedAt,
          },
          output: () => a.answer,
          metadata: claimMetadata({
            outcome: a.outcome,
            ...(a.payload === undefined ? {} : { payload: a.payload }),
            decidedBy: CLIENT_ID,
          }),
        })
        if (resolution.status === 'invalid') {
          throw new Error(resolution.error)
        }
        if (resolution.status !== 'resolved') {
          const now = decisions.get(d.id)
          return { kind: 'closed', status: now?.status ?? 'expired' }
        }
      } catch (error) {
        // the answer did not reach the session (or the effect before it failed): nothing is decided
        if (reached) decisions.reopen(d.id)
        throw error
      }
      const decision = decisions.get(d.id) as Decision
      return delivery === 'gone'
        ? { kind: 'gone', decision }
        : { kind: 'delivered', decision, delivery }
    },
  }
}
