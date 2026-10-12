/**
 * Reminders for web-chat agents (UX pass, follow-up of P41 L6): the same `reminder` tool a channel
 * session has (create, list, cancel, update; `message` / `request` / `verbatim`), usable from a web
 * thread. The target is the thread the reminder was made in: when it fires, the fixed text is
 * stored in that thread as a notice and rings the bell, with no model call (the delivery is
 * `reminders.web.deliver` in `main.ts`). The reminders are rows of `ch_reminders` with the
 * connection `web`, scheduled as `sys:reminder:<id>` routines, and they appear on the Routines page
 * next to the channel ones.
 *
 * Who may: the person using the app is the client, so a reminder for themselves needs no approval
 * (`reminder` is a rule-allowed own write, `connector-catalog.ts`). Naming a chat (`chat`, `topic`,
 * `connection`) hands the call to the channel tool of the agent, which applies its role rules.
 * Only a person's own chat gets the tool: tasks, programs, routines, heartbeats and rehearsals do
 * not (no reminders from reminders).
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import type { z } from 'zod'
import { originOfSession } from '../../domain/run-profiles.ts'
import type { ChannelGateway } from './gateway.ts'
import { flat, timeLine } from './header.ts'
import {
  absoluteTime,
  misusedMessage,
  type ReminderRow,
  reminderText,
  WEB_REMINDER_CONNECTION,
  webReminderSession,
} from './reminders.ts'
import { REMINDER_TOOL, reminderSchema, selfTools } from './self-tools.ts'

export interface WebRemindersOptions {
  /** Late-bound: the plugin is built before the gateway. */
  gateway: () => ChannelGateway | undefined
  /** The agent (id) of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string } | undefined
}

export const WEB_REMINDER_DESCRIPTION =
  'Reminders at a time in the team timezone, without a model call: create (`message` is REQUIRED, plus when), list, cancel, update. Example: {"action":"create","message":"Time to leave","inMinutes":10}. ' +
  'Use it for "remind me in 3 minutes", "tomorrow at 9 remind me to ...", "every weekday at 17:00 remind me ...". ' +
  'A reminder is NOT a plan or a program: never use propose_plan or the work queue for one. ' +
  '`message` is what appears in this chat when it fires and must read as the reminder itself ("Time to leave", "Waktunya pulang"), not as the request ("remind me to ..."): put the request in `request` and write the reminder in `message`. ' +
  "Quote the person's exact words only when they gave words to post (verbatim). " +
  'The reminder is delivered into this chat thread (and the bell) unless you name another chat with `chat`/`topic`, which only works for an agent with a chat connection. ' +
  'Echo the exact time back to the person.'

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** One line of a web reminder for `list`. */
function describe(r: ReminderRow, zone: string): string {
  return `- ${r.id} [${r.status}] ${r.whenText} in this chat: "${clip(flat(r.body, 200), 200)}"${
    r.lastFiredAt === null ? '' : ` last fired ${timeLine(r.lastFiredAt, zone)}`
  }`
}

/** The text a web reminder posts when it fires. */
export const webReminderPost = (body: string): string => reminderText(body)

export function webReminders(options: WebRemindersOptions): HarnessPlugin<'web-reminders'> {
  return definePlugin({
    name: 'web-reminders',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const gw = options.gateway()
      if (gw === undefined) return {}
      const agent = options.agentOf(ctx.agent.id)
      if (agent === undefined) return {}
      // a channel session has its own `reminder` tool (the channels plugin)
      if (gw.conversationOf(sessionId) !== undefined) return {}
      // only a person's own chat: not a delegation, task, program, routine, heartbeat or rehearsal
      const origin = originOfSession(sessionId, ctx.session.parent !== undefined)
      if (origin !== 'dm') return {}
      const agentId = agent.id

      const toChannel = (input: z.infer<typeof reminderSchema>): Promise<string> | undefined => {
        const rem = input.id === undefined ? undefined : gw.reminders.get(input.id)
        const named =
          input.chat !== undefined || input.topic !== undefined || input.connection !== undefined
        const channelRow = rem !== undefined && rem.connectionId !== WEB_REMINDER_CONNECTION
        if (!named && !channelRow) return undefined
        if (gw.connectionsOf(agentId).length === 0) {
          return Promise.resolve(
            'ERROR: this agent has no chat connection, so a reminder can only be delivered into this chat. Leave out chat, topic and connection.',
          )
        }
        const own = selfTools({ gw, sessionId, agentId, origin })[REMINDER_TOOL] as {
          execute: (input: unknown) => Promise<string>
        }
        return own.execute(input)
      }

      const reminder = async (input: z.infer<typeof reminderSchema>): Promise<string> => {
        try {
          const zone = gw.timezone()
          const delegated = toChannel(input)
          if (delegated !== undefined) return await delegated

          if (input.action === 'list') {
            const rows = gw.reminders
              .list(WEB_REMINDER_CONNECTION, input.all === true ? {} : { status: 'active' })
              .filter((r) => r.agentId === agentId)
              .slice(0, 50)
            if (rows.length === 0)
              return input.all === true
                ? 'There are no reminders.'
                : 'There are no active reminders.'
            return `Reminders (${rows.length}), team timezone ${zone}:\n${rows.map((r) => describe(r, zone)).join('\n')}`
          }

          if (input.action === 'cancel') {
            if (input.id === undefined) return 'ERROR: cancel needs id (from list).'
            const r = gw.reminders.get(input.id)
            if (r === undefined || webReminderSession(r) === undefined || r.agentId !== agentId)
              return `ERROR: no reminder ${input.id}.`
            if (r.status !== 'active')
              return `Reminder ${r.id} is already ${r.status}: nothing to cancel.`
            gw.reminders.cancel(r.id)
            return `Cancelled reminder ${r.id} (${r.whenText}): "${clip(flat(r.body, 120), 120)}".`
          }

          const when = {
            ...(input.at === undefined ? {} : { at: input.at }),
            ...(input.inMinutes === undefined ? {} : { inMinutes: input.inMinutes }),
            ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
            ...(input.time === undefined ? {} : { time: input.time }),
            ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
            ...(input.dayOfMonth === undefined ? {} : { dayOfMonth: input.dayOfMonth }),
          }
          const hasWhen = Object.keys(when).length > 0
          const message = input.message?.trim()
          if (message !== undefined && message !== '') {
            const bad = misusedMessage(message, input.request, input.verbatim === true)
            if (bad !== undefined) return bad
          }

          if (input.action === 'update') {
            if (input.id === undefined) return 'ERROR: update needs id (from list).'
            const r = gw.reminders.get(input.id)
            if (r === undefined || webReminderSession(r) === undefined || r.agentId !== agentId)
              return `ERROR: no reminder ${input.id}.`
            const res = gw.reminders.update(r.id, {
              ...(message === undefined || message === '' ? {} : { text: message }),
              ...(hasWhen ? { when } : {}),
            })
            if ('error' in res) return `ERROR: ${res.error}`
            return `Updated. ${describe(res.reminder, zone)}`
          }

          if (message === undefined || message === '')
            return 'ERROR: create needs message (what appears when it fires, written as the reminder itself). Call again with message, for example {"action":"create","message":"Time to leave","inMinutes":10}.'
          if (!hasWhen) return 'ERROR: create needs when: at, inMinutes, or repeat with time.'
          const created = gw.reminders.createInThread({
            sessionId,
            agentId,
            text: message,
            when,
            createdBy: { name: 'You', role: 'owner' },
          })
          if ('error' in created) return `ERROR: ${created.error}`
          const r = created.reminder
          return `Reminder set (id ${r.id}): ${r.whenText}, in this chat. It will appear as: "${clip(flat(webReminderPost(r.body), 200), 200)}" and ring the bell. It was set ${absoluteTime(Date.now(), zone)}. Tell the person this exact time.`
        } catch (error) {
          return `ERROR: ${errorText(error)}`
        }
      }

      return {
        tools: {
          [REMINDER_TOOL]: tool({
            description: WEB_REMINDER_DESCRIPTION,
            inputSchema: reminderSchema,
            metadata: { risk: 'write', idempotent: false },
            execute: (input): Promise<string> => reminder(input),
          }),
        } as never,
      }
    },
  })
}
