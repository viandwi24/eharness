/**
 * Hands the answer of a decision back to the session it came from
 * (docs/plans/P40-team-autonomous-operations.md, D5).
 *
 * The park is eharness' external wait (spec 11 §4.2): `escalate` and `request_authority` are
 * `externalTool()`s, so the turn stopped `tool-pending` and the pending state (with the wait id
 * `w_<toolCallId>`) is in the session's stored state, not in any process. Deciding calls
 * `session.resolveWait(waitId, { output })` on a session opened through the agent factory: it
 * works from any instance, also after a restart, and continues the SAME assistant message with the
 * decision as the tool output. A program run continues with its structured-report spec again
 * (`output` is not carried over a `tool-pending` stop, spec 05 §3.3 rule 7), so the continuation
 * still ends with a typed report that the task index stores.
 *
 * A decision made from a final report has no wait: the answer is a new message in the finished
 * session (`session.send`).
 */
import { errorText } from 'eharness'
import { formatHandBack } from 'eharness/browser'
import type { AgentRepo, DecisionResolver } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { declinedTakeoverText } from '../../domain/browser.ts'
import { type Decision, type DecisionAnswer, followUpText } from '../../domain/decisions.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import { PROGRAM_RUN_MAX_STEPS, parseProgramSession } from '../../domain/programs.ts'
import type { AgentFactory } from './agent-factory.ts'
import { BEAT_SCHEMA } from './heartbeat-service.ts'
import { REPORT_SCHEMA } from './program-service.ts'

export interface DecisionService extends DecisionResolver {
  /** Continuations started by this process that have not ended (tests wait for them). */
  idle(): Promise<void>
}

export interface DecisionServiceDeps {
  agents: AgentRepo
  /** How long a busy session (a turn ending right now) is retried before giving up (ms). */
  busyRetryMs?: number
  /** Called when a decided takeover must give the browser back to the agent (plan P48). */
  handBack?: (profileId: string) => Promise<unknown>
  /** Called when a continued session ends (the deliverable re-check of a decided run). */
  afterRun?: (sessionId: string) => Promise<void>
  log?: { warn(message: string): void }
}

/**
 * What the parked `browser_request_human` reads (its output is a string, unlike the structured
 * answer of other escalations): the hand-back line, or the refusal.
 */
export function takeoverOutput(decision: Decision, answer: DecisionAnswer): string | undefined {
  if (decision.kind !== 'escalation' || decision.payload.takeover === undefined) return undefined
  if (answer.decision === 'rejected') return declinedTakeoverText(answer.note)
  // the live page hands the line over as the note; a card answer gets the default one
  if (answer.note.includes('handed the browser back')) return answer.note
  const note = answer.note.trim()
  return `${formatHandBack({ by: 'The client' })}${note === '' ? '' : ` Note: ${note}`}`
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const isBusy = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'EH_SESSION_BUSY'

/**
 * The options of a continuation turn of a session: a program run continues with its report spec, a
 * heartbeat with its result spec (`output` is not carried over a stop, spec 05 §3.3 rule 7). Shared
 * by the decision hand-back and the automatic retry of a failed turn (`turn-retry-service.ts`).
 */
export function continuationOptions(factory: AgentFactory, def: AgentDef, sessionId: string) {
  if (sessionId.startsWith('heartbeat:')) {
    return { output: { schema: BEAT_SCHEMA, description: 'The result of this heartbeat.' } }
  }
  return parseProgramSession(sessionId) === undefined
    ? {}
    : {
        output: { schema: REPORT_SCHEMA, description: 'The final report of this program run.' },
        // the continuation is a new turn: without this it gets the agent's default step limit
        // and a long (chunked) run that parked once is cut off early
        maxSteps: PROGRAM_RUN_MAX_STEPS,
        // and the output cap its budget can afford, as in the first turn
        ...factory.programTurn(def, sessionId),
      }
}

export function createDecisionService(
  factory: AgentFactory,
  deps: DecisionServiceDeps,
): DecisionService {
  const log = deps.log ?? { warn() {} }
  const busyRetryMs = deps.busyRetryMs ?? 3000
  const inflight = new Set<Promise<unknown>>()
  const track = (run: { result: Promise<unknown> }, sessionId: string): void => {
    const watched = run.result
      .then(() => deps.afterRun?.(sessionId))
      .then(
        () => undefined,
        (error: unknown) => log.warn(`resumed session ${sessionId} failed: ${errorText(error)}`),
      )
    inflight.add(watched)
    void watched.finally(() => inflight.delete(watched))
  }
  const options = (def: AgentDef, sessionId: string) => continuationOptions(factory, def, sessionId)

  return {
    async resume(decision, answer) {
      if (decision.sessionId === null) return 'gone'
      const def = deps.agents.get(decision.agentId)
      if (def === undefined) throw notFound('agent', decision.agentId)
      if (def.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
      await factory.prepare(def)
      const session = factory.openSession(def, decision.sessionId)

      if (decision.waitId === null) {
        // a decision made from a final report: the session is idle, the answer is a new message
        const run = session.send(followUpText(decision, answer), {
          ...options(def, decision.sessionId),
          ifBusy: 'queue',
        })
        track(run, decision.sessionId)
        return 'resumed'
      }

      const takeover = takeoverOutput(decision, answer)
      if (takeover !== undefined && decision.kind === 'escalation') {
        // the person is done (or declined): the agent drives the browser again
        await deps
          .handBack?.(decision.payload.takeover?.profileId as string)
          ?.catch((error: unknown) => log.warn(`browser hand-back failed: ${errorText(error)}`))
      }
      const end = Date.now() + busyRetryMs
      for (;;) {
        try {
          const result = await session.resolveWait(
            decision.waitId,
            { output: takeover ?? answer },
            options(def, decision.sessionId),
          )
          if (result.status === 'continued') {
            track(result.run, decision.sessionId)
            return 'resumed'
          }
          if (result.status === 'recorded') return 'recorded'
          // `already-resolved` is the answer another instance recorded first: done
          return result.status === 'already-resolved' ? 'resumed' : 'gone'
        } catch (error) {
          // the turn that parked is still ending (`start` runs inside it): retry shortly
          if (!isBusy(error) || Date.now() > end) throw error
          await sleep(40)
        }
      }
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}
