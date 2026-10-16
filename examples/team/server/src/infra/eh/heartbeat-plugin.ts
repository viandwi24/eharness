/**
 * `heartbeat` plugin (docs/plans/P40-team-autonomous-operations.md, D9): the tool of the heartbeat
 * session and the hook that records how a beat ended.
 *
 *  - `team_status`  heartbeat sessions only. The server's deterministic observations as one compact
 *                   text (and the new messages of the watched chats): stuck, failed and long-waiting work, old decisions, failing programs and
 *                   routines, connectors that need sign-in, the budget, and repeated requests that
 *                   may deserve a program. Findings already reported inside their window are left
 *                   out, so the model reads only what is new.
 *  - `turn.end`     a beat's turn ended: record the
 *                   structured result, queue what is new for the digest, interrupt for urgent items.
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { READ_BRIEFINGS_DESCRIPTION, READ_BRIEFINGS_TOOL } from '../../domain/briefings.ts'
import {
  BEAT_DECISIONS,
  type HeartbeatDestination,
  NOTE_TOOL,
  TEAM_STATUS_TOOL,
} from '../../domain/heartbeat.ts'
import { NOTES_TOOL, ORDER_DONE_TOOL, PATTERN_TOOL } from '../../domain/heartbeat-notes.ts'
import { originOfSession } from '../../domain/run-profiles.ts'
import { HEARTBEAT_REPORT_TOOL, STANDING_ORDERS_NOTE } from '../../domain/standing-orders.ts'
import type { StandingOrderApi } from './standing-order-plugin.ts'

/** What the plugin needs from the app (`app/heartbeat.ts` over the deps, built in `main.ts`). */
export interface HeartbeatIntake {
  status(agentId: string): Promise<string>
  ended(end: { agentId: string; stop: string; output: unknown }): Promise<void>
  /** The agent (slug) may read the briefings: the lead, in a chat thread. */
  canReadBriefings(agentSlug: string): boolean
  /** The latest briefings, or the one of a day, as text. */
  briefings(query: { limit?: number; day?: string }): string
  /** Append a line to today's notes of the agent (fixed path, append-only). */
  note(
    agentId: string,
    entry: {
      chat: string
      messageIds?: string[]
      noticed: string
      decision: (typeof BEAT_DECISIONS)[number]
      confidence?: string | undefined
      evidence?: string[] | undefined
      order?: string | undefined
    },
  ): Promise<string>
  /** The notes of the given days with unresolved references marked. */
  readNotes(agentId: string, days: string[]): Promise<string>
  /** Append a confirmed pattern (evidence on at least two days). */
  pattern(agentId: string, input: { pattern: string; days: string[] }): Promise<string>
  /** End a deadline order with its outcome. */
  orderDone(agentId: string, orderId: string, outcome: string): Promise<string>
  /** The agent (slug) has a heartbeat that is on: its chats are told about standing orders. */
  heartbeatOn(agentSlug: string): boolean
  /** The chats of the active standing orders as of the running beat; read by the gate on every call. */
  allowed(agentId: string): HeartbeatDestination[]
  /** What the live orders of owners and admins open for the running beat (needs, ledger paths). */
  grants(agentId: string): { needs: string[]; writes: string[] }
  /** Count a post the beat is about to make to a destination; a readable refusal over the cap or for a repeat. */
  reservePost(agentId: string, to: string, text: string): string | undefined
  /** Report to the web chat of a standing order. A readable string either way. */
  reportWeb(agentId: string, orderId: string, text: string): Promise<string>
  /** The standing orders (`standing_order` tool of the chats). */
  orders: StandingOrderApi
}

export interface HeartbeatPluginOptions {
  /** Late-bound: the plugin is built before the app deps. */
  intake: () => HeartbeatIntake | undefined
}

export const TEAM_STATUS_DESCRIPTION =
  'What the server found about the team since it last told you: stuck, failed or long-waiting ' +
  'tasks, decisions waiting too long, programs and routines that fail or paused themselves, ' +
  'connectors that need sign-in, the budget, new messages in the chats it watches, and requests ' +
  'the client repeated that may deserve a standing program. Read-only. Findings already reported are not listed again.'

/** Said (once, static) in the chats of an agent whose heartbeat is on: standing orders. */
export const HEARTBEAT_NOTE = STANDING_ORDERS_NOTE

export function heartbeat(options: HeartbeatPluginOptions): HarnessPlugin<'heartbeat'> {
  return definePlugin({
    name: 'heartbeat',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const origin = originOfSession(sessionId)
      const intake = () => {
        const found = options.intake()
        if (found === undefined) throw new Error('the heartbeat is not ready')
        return found
      }
      const note =
        origin === 'dm' && options.intake()?.heartbeatOn(ctx.agent.id) === true
          ? { instructions: [{ text: HEARTBEAT_NOTE, id: 'heartbeat-note' }] as never }
          : {}
      // the lead reads the briefings from any chat thread (the digest is a page, not a message)
      if (origin === 'dm') {
        if (options.intake()?.canReadBriefings(ctx.agent.id) !== true) return note
        return {
          ...note,
          tools: {
            [READ_BRIEFINGS_TOOL]: tool({
              description: READ_BRIEFINGS_DESCRIPTION,
              inputSchema: z.object({
                days: z.number().int().min(1).max(7).optional(),
                day: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .optional(),
              }),
              metadata: { risk: 'read', idempotent: true },
              execute: async (input): Promise<string> => {
                try {
                  return intake().briefings({
                    ...(input.days === undefined ? {} : { limit: input.days }),
                    ...(input.day === undefined ? {} : { day: input.day }),
                  })
                } catch (error) {
                  return `ERROR: could not read the briefings: ${errorText(error)}`
                }
              },
            }),
          } as never,
        }
      }
      if (origin !== 'heartbeat') return note
      const agentId = sessionId.slice('heartbeat:'.length)
      return {
        tools: {
          [TEAM_STATUS_TOOL]: tool({
            description: TEAM_STATUS_DESCRIPTION,
            inputSchema: z.object({}),
            metadata: { risk: 'read', idempotent: true },
            execute: async (): Promise<string> => {
              try {
                return await intake().status(agentId)
              } catch (error) {
                return `ERROR: could not read the team status: ${errorText(error)}`
              }
            },
          }),
          [HEARTBEAT_REPORT_TOOL]: tool({
            description:
              'Report to the web chat of a standing order that was given there: pass the order id and one or two short lines. The text appears in that chat and rings the bell. Only for an order whose report destination is the web chat (for a chat order use channel_send). Refused over the daily limit or when you already said it.',
            inputSchema: z.object({
              order: z.string().min(1).max(80).describe('The id of the standing order.'),
              text: z.string().min(1).max(1500).describe('What to tell the person, short.'),
            }),
            metadata: { risk: 'external', idempotent: false },
            execute: async (input): Promise<string> => {
              try {
                return await intake().reportWeb(agentId, input.order, input.text)
              } catch (error) {
                return `ERROR: could not report: ${errorText(error)}`
              }
            },
          }),
          [NOTE_TOOL]: tool({
            description:
              "Append one line to today's observation notes (append-only, one file per day under /library/notes/heartbeat/). A note is a fact with its proof: the chat or topic, the platform message ids (or another evidence reference: a URL, a /library/... path, session:<id>#<message id>), how sure you are (seen: you read it yourself; inferred), what it is, and your decision (note, report, escalate). A note without evidence is refused. Pass `order` when it is about a standing order.",
            inputSchema: z.object({
              chat: z.string().min(1).max(120).describe('The chat or topic name.'),
              messageIds: z
                .array(z.string().max(80))
                .max(10)
                .optional()
                .describe('Platform message ids of that chat (evidence).'),
              evidence: z
                .array(z.string().max(300))
                .max(6)
                .optional()
                .describe(
                  'Other evidence: https URL, /library/... path, session:<id>#<message id>.',
                ),
              confidence: z
                .enum(['seen', 'inferred'])
                .optional()
                .describe('seen: you read it yourself. inferred: you concluded it. Required.'),
              noticed: z
                .string()
                .min(1)
                .max(500)
                .describe('What you noticed, one or two sentences.'),
              decision: z.enum(BEAT_DECISIONS),
              order: z
                .string()
                .max(80)
                .optional()
                .describe('The id of the standing order it is about.'),
            }),
            metadata: { risk: 'write', idempotent: false },
            execute: async (input): Promise<string> => {
              try {
                return await intake().note(agentId, input)
              } catch (error) {
                return `ERROR: could not write the note: ${errorText(error)}`
              }
            },
          }),
          [NOTES_TOOL]: tool({
            description:
              'Read your observation notes of given days (YYYY-MM-DD, team timezone; default today and yesterday). A line whose library file or session no longer exists is marked "no longer resolves": do not build on it.',
            inputSchema: z.object({
              days: z
                .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
                .max(8)
                .optional(),
            }),
            metadata: { risk: 'read', idempotent: true },
            execute: async (input): Promise<string> => {
              try {
                return await intake().readNotes(agentId, input.days ?? [])
              } catch (error) {
                return `ERROR: could not read the notes: ${errorText(error)}`
              }
            },
          }),
          [PATTERN_TOOL]: tool({
            description:
              'Weekly review: write one confirmed pattern. Only what has notes with evidence on at least two different days is a pattern; name those days. Refused otherwise.',
            inputSchema: z.object({
              pattern: z.string().min(1).max(500),
              days: z
                .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
                .min(1)
                .max(8),
            }),
            metadata: { risk: 'write', idempotent: false },
            execute: async (input): Promise<string> => {
              try {
                return await intake().pattern(agentId, input)
              } catch (error) {
                return `ERROR: could not write the pattern: ${errorText(error)}`
              }
            },
          }),
          [ORDER_DONE_TOOL]: tool({
            description:
              'End a `deadline` standing order with its outcome (what you found, what you did, what you reported). The order stays listed as done. Do not call it when you could not find out.',
            inputSchema: z.object({
              order: z.string().min(1).max(80).describe('The id of the deadline order.'),
              outcome: z.string().min(1).max(600),
            }),
            metadata: { risk: 'write', idempotent: false },
            execute: async (input): Promise<string> => {
              try {
                return await intake().orderDone(agentId, input.order, input.outcome)
              } catch (error) {
                return `ERROR: could not end the order: ${errorText(error)}`
              }
            },
          }),
        } as never,
        hooks: {
          'turn.end': async (
            hookCtx: HarnessContext,
            e: { stop: string; output?: unknown },
          ): Promise<void> => {
            try {
              await intake().ended({ agentId, stop: e.stop, output: e.output })
            } catch (error) {
              hookCtx.log.warn(`heartbeat: could not record the beat: ${errorText(error)}`)
            }
          },
        } as never,
      }
    },
  })
}
