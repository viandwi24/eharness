/**
 * The runner of the heartbeat and the daily digest (docs/plans/P40-team-autonomous-operations.md,
 * D9 and D10). The routine service claims the slot of a `sys:` routine and calls this module;
 * what to do is decided in `app/heartbeat.ts`, deterministically.
 *
 * A beat is one turn of the rolling session `heartbeat:<agentId>` (compaction keeps it small), a
 * `send` with a structured-output spec like a program run. Its end is recorded by the `turn.end`
 * hook of `heartbeat-plugin.ts`, not by awaiting the run here (the heartbeat never parks: urgent things go to the lead DM).
 *
 * The DM message of an urgent finding or of the digest is an `eh.event` injected into the lead's
 * DM (`session.inject`): stored at once, no model call, and the lead reads it as context at its
 * next turn, so the client can answer "tell me more about the second item".
 */
import { errorText } from 'eharness'
import { z } from 'zod'
import {
  abandonBeat,
  beginBeat,
  type DigestOutcome,
  planActivityWake,
  runDigest,
} from '../../app/heartbeat.ts'
import type {
  AgentRepo,
  Deps,
  EventAppender,
  HeartbeatChannels,
  HeartbeatPorts,
  HeartbeatStore,
} from '../../app/ports.ts'
import type { BeatTrigger } from '../../domain/heartbeat.ts'
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
        decision: z
          .enum(['note', 'report', 'escalate'])
          .optional()
          .describe(
            'What you did about it: note (only noted), report (you told the destination of a standing order), escalate (the owner must look).',
          ),
        reason: z
          .string()
          .max(300)
          .optional()
          .describe('One line: why you noted, spoke or escalated (the owner audits this).'),
      }),
    )
    .max(20),
})

export interface SystemRunner {
  /** Fire the heartbeat of `agentId` for `slot`. `skipped` costs no model call. */
  heartbeat(
    agentId: string,
    input: { slot: number; trigger?: BeatTrigger; orderId?: string },
  ): Promise<{ started: boolean; reason?: string; sessionId: string }>
  /** Build and send the digest of `slot`'s day. */
  digest(input: { slot: number }): Promise<DigestOutcome>
  /** Post a reminder created from a chat (no model call). `skipped` says why nothing was posted. */
  reminder?(id: string, input: { slot: number }): Promise<{ posted: boolean; reason?: string }>
}

export interface HeartbeatServiceDeps {
  /** The app deps, built after the factory. */
  deps: () => Deps
  agents: AgentRepo
  events: EventAppender
  store: HeartbeatStore
  /** The workspace budget ledger scope: spend and limit of this month. */
  budget: () => Promise<{ spentUsd: number; limitUsd: number | null } | null>
  /** The tools the agent has for the needs of an order (from its last activation). */
  needsTools?: (agentId: string, needs: readonly string[]) => { tools: string[]; missing: string[] }
  /** The chat gateway side (destinations, watched chats, activity); absent = no chat features. */
  channels?: HeartbeatChannels
  /**
   * How long new messages settle before an early beat starts (default 30 s), so a burst of
   * messages is one beat that sees all of it.
   */
  activitySettleMs?: number
  log?: { warn(message: string): void }
}

export interface HeartbeatService extends SystemRunner {
  /** The ports `Deps.heartbeat` needs. */
  ports: HeartbeatPorts
  /**
   * A message arrived in a chat (the gateway's ingest): maybe wake the beat of the agent early,
   * debounced to one early beat per `ACTIVITY_MIN_GAP_MS`. Never throws.
   */
  activity(event: { connectionId: string; nodeId: string; at: number }): Promise<void>
  /** Cancel pending early beats (shutdown). */
  close(): void
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
  /** One pending early beat per agent. */
  const wakes = new Map<string, ReturnType<typeof setTimeout>>()

  const ports: HeartbeatPorts = {
    store: options.store,
    budget: options.budget,
    ...(options.channels === undefined ? {} : { channels: options.channels }),

    run: (agentId, at) => service.heartbeat(agentId, { slot: at }),

    ...(options.needsTools === undefined ? {} : { needsTools: options.needsTools }),

    async sessionExists(sessionId) {
      try {
        return (await factory.peek(sessionId).messages({ limit: 1 })).length > 0
      } catch {
        return false
      }
    },

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
  }

  const RETRY_MS = 90_000
  const MAX_RETRIES = 6
  const retryDeadline = (agentId: string, orderId: string, tries: number): void => {
    if (tries >= MAX_RETRIES) return
    const timer = setTimeout(() => {
      wakes.delete(`${agentId}:${orderId}`)
      service
        .heartbeat(agentId, { slot: Date.now(), trigger: 'deadline', orderId })
        .then((out) => {
          if (!out.started && /still running/.test(out.reason ?? '')) {
            retryDeadline(agentId, orderId, tries + 1)
          }
        })
        .catch((error) => log.warn(`deadline beat of ${agentId} failed: ${errorText(error)}`))
    }, RETRY_MS)
    timer.unref?.()
    wakes.set(`${agentId}:${orderId}`, timer)
  }

  const service: HeartbeatService = {
    ports,

    async activity(event) {
      try {
        const plan = await planActivityWake(options.deps(), event)
        if (plan === undefined || wakes.has(plan.agentId)) return
        const settle = options.activitySettleMs ?? 30_000
        const delay = Math.max(plan.notBefore - Date.now(), 0) + settle
        const timer = setTimeout(() => {
          wakes.delete(plan.agentId)
          const at = Date.now()
          service.heartbeat(plan.agentId, { slot: at, trigger: 'activity' }).catch((error) => {
            log.warn(`early heartbeat of ${plan.agentId} failed: ${errorText(error)}`)
          })
        }, delay)
        timer.unref?.()
        wakes.set(plan.agentId, timer)
      } catch (error) {
        log.warn(`heartbeat activity wake failed: ${errorText(error)}`)
      }
    },

    close() {
      for (const timer of wakes.values()) clearTimeout(timer)
      wakes.clear()
    },

    async heartbeat(agentId, { slot, trigger, orderId }) {
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
        ...(trigger === undefined ? {} : { trigger }),
        ...(orderId === undefined ? {} : { orderId }),
      })
      if (!plan.run) {
        // the exact wake of a deadline fires once: when the previous beat is still running, try again soon
        if (trigger === 'deadline' && orderId !== undefined && /still running/.test(plan.reason)) {
          retryDeadline(agentId, orderId, 0)
        }
        return { started: false, reason: plan.reason, sessionId }
      }

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
