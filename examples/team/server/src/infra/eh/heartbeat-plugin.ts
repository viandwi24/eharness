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
import { BEAT_DECISIONS, NOTE_TOOL, TEAM_STATUS_TOOL } from '../../domain/heartbeat.ts'
import { originOfSession } from '../../domain/run-profiles.ts'

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
    },
  ): Promise<string>
  /** The agent (slug) has a heartbeat that is on: its chats are told how to set the checklist. */
  heartbeatOn(agentSlug: string): boolean
  /** Where the beat may post (`reportTo`) and its daily cap; read by the gate on every call. */
  posting(agentId: string): {
    reportTo: { connectionId: string; nodeId: string } | null
    maxPostsPerDay: number
  }
  /** Count a post the beat is about to make; a readable refusal over the cap or for a repeat. */
  reservePost(agentId: string, text: string): string | undefined
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

/**
 * Said (once, static) in the chats of an agent whose heartbeat is on, so "be proactive about X"
 * becomes a line of its checklist instead of a promise nobody keeps.
 */
export const HEARTBEAT_NOTE = [
  '## Your heartbeat',
  '',
  'You have a heartbeat: a quiet check-in on a schedule (and when watched chats get new messages) that',
  'runs only if your checklist, the memory file `HEARTBEAT.md` in your own memory, has real lines in it',
  '(headings and comments do not count). When the owner asks you to be proactive or to keep an eye on',
  'something ("tell the group if you notice spam"), write it there as one short line with your memory',
  'tools, keeping the lines already in the file, and say so. The heartbeat only reads; it may post',
  'only to the report chat the owner chose in your heartbeat settings, and nowhere else.',
].join('\n')

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
        (origin === 'dm' || origin === 'lead') &&
        options.intake()?.heartbeatOn(ctx.agent.id) === true
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
          [NOTE_TOOL]: tool({
            description:
              "Append one line to today's observation notes (append-only, one file per day under /library/notes/heartbeat/). Write what you noticed in a chat: the chat or topic, the message ids, what it is, and your decision (note, say, escalate). Read-only otherwise: this is the only thing you can write.",
            inputSchema: z.object({
              chat: z.string().min(1).max(120).describe('The chat or topic name.'),
              messageIds: z.array(z.string().max(80)).max(10).optional(),
              noticed: z
                .string()
                .min(1)
                .max(500)
                .describe('What you noticed, one or two sentences.'),
              decision: z.enum(BEAT_DECISIONS),
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
