/**
 * The runner of the heartbeat and the daily digest (docs/plans/P40-team-autonomous-operations.md,
 * D9 and D10). The routine service claims the slot of a `sys:` routine and calls this module;
 * what to do is decided in `app/heartbeat.ts`, deterministically.
 *
 * A beat is one turn of the rolling session `heartbeat:<agentId>` (compaction keeps it small), a
 * `send` with a structured-output spec like a program run. Its end is recorded by the `turn.end`
 * hook of `heartbeat-plugin.ts`, not by awaiting the run here: a beat that parked on `escalate`
 * and continued after the client decided (maybe on another instance) is recorded the same way.
 *
 * The DM message of an urgent finding or of the digest is an `eh.event` injected into the lead's
 * DM (`session.inject`): stored at once, no model call, and the lead reads it as context at its
 * next turn, so the client can answer "tell me more about the second item".
 */
import { errorText } from 'eharness'
import { z } from 'zod'
import { abandonBeat, beginBeat, type DigestOutcome, runDigest } from '../../app/heartbeat.ts'
import type {
  AgentRepo,
  Deps,
  EventAppender,
  HeartbeatPorts,
  HeartbeatStore,
} from '../../app/ports.ts'
import { previewOf } from '../../domain/tasks.ts'
import type { AgentFactory } from './agent-factory.ts'

/** The rolling session of an agent's heartbeat. */
export const heartbeatSessionId = (agentId: string): string => `heartbeat:${agentId}`

/** Model steps one beat may take (a beat reads a summary and a few files). */
export const HEARTBEAT_MAX_STEPS = 20

/** The structured result of a beat: nothing to show (`ok`) or what needs attention. */
export const BEAT_SCHEMA = z.object({
  status: z
    .enum(['ok', 'attention'])
    .describe('ok: nothing needs the client attention (items empty). attention: items follow.'),
  items: z
    .array(
      z.object({
        kind: z.string().max(60).describe('The kind of the finding, e.g. task.stuck.'),
        title: z.string().min(1).max(200).describe('One line.'),
        detail: z.string().max(1000).describe('One or two sentences: what and why it matters.'),
        links: z
          .array(z.string().max(300))
          .max(8)
          .optional()
          .describe('App paths or library paths as evidence.'),
        urgent: z
          .boolean()
          .optional()
          .describe('true only when waiting for the daily digest would cost something.'),
        fingerprint: z
          .string()
          .max(200)
          .optional()
          .describe('The fingerprint of the team_status finding this is about, unchanged.'),
      }),
    )
    .max(20),
})

export interface SystemRunner {
  /** Fire the heartbeat of `agentId` for `slot`. `skipped` costs no model call. */
  heartbeat(
    agentId: string,
    input: { slot: number },
  ): Promise<{ started: boolean; reason?: string; sessionId: string }>
  /** Build and send the digest of `slot`'s day. */
  digest(input: { slot: number }): Promise<DigestOutcome>
}

export interface HeartbeatServiceDeps {
  /** The app deps, built after the factory. */
  deps: () => Deps
  agents: AgentRepo
  events: EventAppender
  store: HeartbeatStore
  /** The workspace budget ledger scope: spend and limit of this month. */
  budget: () => Promise<{ spentUsd: number; limitUsd: number | null } | null>
  log?: { warn(message: string): void }
}

export interface HeartbeatService extends SystemRunner {
  /** The ports `Deps.heartbeat` needs. */
  ports: HeartbeatPorts
  /** Beats started by this process that have not ended (tests wait for them). */
  idle(): Promise<void>
}

const textOf = (message: { parts: Array<Record<string, unknown>> }): string =>
  message.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim()

export function createHeartbeatService(
  factory: AgentFactory,
  options: HeartbeatServiceDeps,
): HeartbeatService {
  const log = options.log ?? { warn() {} }
  const inflight = new Set<Promise<unknown>>()
  const lead = () => options.agents.list().find((a) => a.role === 'lead')

  const ports: HeartbeatPorts = {
    store: options.store,
    budget: options.budget,

    run: (agentId, at) => service.heartbeat(agentId, { slot: at }),

    async requests(sessionId, limit) {
      const messages = await factory.peek(sessionId).messages({ limit })
      const out: Array<{ text: string; at: number }> = []
      for (const m of messages) {
        const meta = (
          m.metadata as { eharness?: { kind?: string; createdAt?: number } } | undefined
        )?.eharness
        if (m.role !== 'user' || meta?.kind !== undefined) continue
        const text = textOf(m as never)
        // frames the app or the core wrote for the model are not the client's words
        if (text === '' || text.startsWith('<')) continue
        out.push({ text, at: meta?.createdAt ?? 0 })
      }
      return out
    },

    async notify({ name, text, key, at }) {
      const def = lead()
      if (def === undefined) return
      await factory.prepare(def)
      const sessionId = `dm:${def.id}`
      const session = factory.openSession(def, sessionId)
      await (
        session as unknown as {
          inject(kind: string, data: unknown, opts?: { key?: string }): Promise<unknown>
        }
      ).inject('eh.event', { name, text }, { key })
      options.events.append({
        type: 'message-added',
        agentId: def.id,
        sessionId,
        payload: { role: 'assistant', preview: previewOf(text.replace(/\*\*/g, '')) },
        at,
      })
    },
  }

  const service: HeartbeatService = {
    ports,

    async heartbeat(agentId, { slot }) {
      const sessionId = heartbeatSessionId(agentId)
      const def = options.agents.get(agentId)
      const d = options.deps()
      if (def === undefined || def.archivedAt !== null) {
        return { started: false, reason: 'the agent is archived', sessionId }
      }
      await factory.prepare(def)
      const peek = factory.peek(sessionId)
      const plan = await beginBeat(d, agentId, {
        id: String(slot),
        at: slot,
        session: { busy: (await peek.busy()) !== null, waiting: (await peek.pending()) !== null },
      })
      if (!plan.run) return { started: false, reason: plan.reason, sessionId }

      try {
        const run = factory.openSession(def, sessionId).send(plan.prompt, {
          output: { schema: BEAT_SCHEMA, description: 'The result of this heartbeat.' },
          ifBusy: 'reject',
          maxSteps: HEARTBEAT_MAX_STEPS,
        })
        // the end is recorded by the turn.end hook; this only catches a run that never started
        const watched = run.result.then(
          () => undefined,
          (error: unknown) => {
            log.warn(`heartbeat ${sessionId} failed: ${errorText(error)}`)
            abandonBeat(d, agentId, `failed: ${errorText(error)}`, Date.now())
          },
        )
        inflight.add(watched)
        void watched.finally(() => inflight.delete(watched))
      } catch (error) {
        abandonBeat(d, agentId, `could not start: ${errorText(error)}`, Date.now())
        return { started: false, reason: errorText(error), sessionId }
      }
      return { started: true, sessionId }
    },

    digest: ({ slot }) => runDigest(options.deps(), slot),

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
  return service
}
