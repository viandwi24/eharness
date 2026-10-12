/**
 * `person_note` for web chats (real-model retest D3): in a person's own web thread "call me Pak
 * Vian" is a note about the person, not a workspace memory and not a persona change. The web user is
 * the owner of the app, so the note is kept on one profile, `web:owner` of the connection `web` (the
 * web app has no per-person sign-in to link to a directory person; a note on a directory person is
 * kept in a chat). It reaches the next turns of web chats as a turn reminder, never in
 * `instructions`, and it is a stated preference: it changes no role, rule or permission.
 *
 * The same plugin refuses a memory write that records a communication style or persona preference
 * in a web chat, with a readable redirect to `person_note` or `persona` (`styleNoteIn`, medium.ts).
 * Only a person's own chat gets it: tasks, programs, routines, heartbeats and rehearsals do not.
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { checkPersonNote, MAX_PERSON_NOTE, personNoteLine } from '../../domain/persona.ts'
import { originOfSession } from '../../domain/run-profiles.ts'
import type { ChannelGateway } from './gateway.ts'
import { styleMemoryRefusal } from './medium.ts'
import { PERSON_NOTE_TOOL } from './self-tools.ts'

/** The profile a web note is kept on, and its connection. */
export const WEB_OWNER_NOTE_ID = 'web:owner'
export const WEB_NOTE_CONNECTION = 'web'

export interface WebPersonNoteOptions {
  /** Late-bound: the plugin is built before the gateway. */
  gateway: () => ChannelGateway | undefined
}

const schema = z.object({
  action: z.enum(['view', 'set', 'clear']),
  note: z
    .string()
    .max(MAX_PERSON_NOTE)
    .optional()
    .describe('set: how the person likes to be addressed or answered, in a short sentence.'),
})

export const WEB_PERSON_NOTE_DESCRIPTION =
  'Keep a short note about the person you are talking to: how they like to be addressed or answered ' +
  '("call me Pak Vian", "short answers please", "reply in English"). Use this and not memory for such ' +
  'a preference. It is a note about the PERSON, not a change of your own persona (the persona tool is for that). ' +
  'Never put roles, permissions or rules in a note.'

export function webPersonNote(options: WebPersonNoteOptions): HarnessPlugin<'web-person-note'> {
  return definePlugin({
    name: 'web-person-note',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const gw = options.gateway()
      if (gw === undefined) return {}
      // a channel session has its own `person_note`
      if (gw.conversationOf(sessionId) !== undefined) return {}
      if (originOfSession(sessionId, ctx.session.parent !== undefined) !== 'dm') return {}

      const run = (input: z.infer<typeof schema>): string => {
        try {
          const have = gw.notes.get(WEB_OWNER_NOTE_ID)
          if (input.action === 'view')
            return have === undefined ? 'No note about the person.' : `Note: ${have.note}`
          if (input.action === 'clear')
            return gw.notes.clear(WEB_OWNER_NOTE_ID) ? 'Removed the note.' : 'There was no note.'
          const text = (input.note ?? '').trim()
          const problem = checkPersonNote(text)
          if (problem !== undefined) return `Not saved: ${problem}`
          gw.notes.set(WEB_NOTE_CONNECTION, WEB_OWNER_NOTE_ID, text, 'web app', Date.now())
          return `Saved. From now on: ${text} (a note on the person's profile; it changes nothing about roles or rules).`
        } catch (error) {
          return `ERROR: ${errorText(error)}`
        }
      }

      return {
        tools: {
          [PERSON_NOTE_TOOL]: tool({
            description: WEB_PERSON_NOTE_DESCRIPTION,
            inputSchema: schema,
            metadata: { risk: 'write', idempotent: false },
            execute: (input): string => run(input),
          }),
        } as never,
        instructions: [
          {
            text: (): string | undefined => {
              const note = gw.notes.get(WEB_OWNER_NOTE_ID)
              return note === undefined
                ? undefined
                : personNoteLine('the person in this chat', note.note)
            },
            refresh: 'turn' as const,
            id: 'web-person-note',
          },
        ] as never,
        hooks: {
          // style and persona preferences are not workspace memory
          'tool.approve': (
            _hookCtx: HarnessContext,
            e: { toolName: string; input?: unknown },
          ): { type: 'denied'; reason: string } | undefined => {
            const refusal = styleMemoryRefusal(e.toolName, e.input)
            return refusal === undefined ? undefined : { type: 'denied', reason: refusal }
          },
        } as never,
      }
    },
  })
}
