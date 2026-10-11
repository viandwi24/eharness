/**
 * The "Telegram bot" connector: an `apiKey` connector whose only secret is the bot token from
 * @BotFather. `test()` calls `getMe` (and `getWebhookInfo`) and explains privacy mode. The token
 * is sealed by the connection store like any connector secret; it never appears in a view, a log
 * line or an error text (`scrubToken`).
 */
import { type AnyConnectorDefinition, defineConnector } from 'eharness/connectors'
import { ehMeta } from 'eharness/providers'
import { z } from 'zod'
import { scrubToken } from './adapter.ts'

export const TELEGRAM_CONNECTOR_ID = 'telegram-bot'
export const DEFAULT_API_ROOT = 'https://api.telegram.org'

/** The shape @BotFather hands out: `<digits>:<35 characters>`. */
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/

export const PRIVACY_ON =
  'Privacy mode is on: in groups the bot only sees messages that mention it, replies to it and commands. To let it observe a whole group, make the bot a group admin, or turn privacy mode off in @BotFather (/setprivacy), then remove and re-add the bot to the group.'
export const PRIVACY_OFF = 'The bot can read all messages of the groups it is in.'

export function privacyGuidance(canReadAllGroupMessages: boolean): string {
  return canReadAllGroupMessages ? PRIVACY_OFF : PRIVACY_ON
}

export function telegramConnector(options: { apiRoot?: string } = {}): AnyConnectorDefinition {
  const apiRoot = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/$/, '')
  return defineConnector({
    id: TELEGRAM_CONNECTOR_ID,
    version: '1',
    name: 'Telegram bot',
    description: 'Let an agent live in Telegram chats as a bot: groups, topics, channels and DMs.',
    icon: 'telegram-logo',
    publisher: 'Telegram',
    homepage: 'https://core.telegram.org/bots',
    docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    category: 'channels',
    source: 'curated',
    scopes: ['workspace'],
    auth: {
      type: 'apiKey',
      fields: z.object({
        token: z
          .string()
          .min(1)
          .meta({
            title: 'Bot token',
            description:
              'From @BotFather (/newbot). Stored encrypted; it is never shown again after saving.',
            ...ehMeta({ group: 'auth', secret: true, widget: 'password' }),
          }),
      }),
    },
    // chat access is configured on the Channels page, not as agent tools
    capabilities: [],
    test: async (ctx) => {
      const token = String((ctx.settings as { token?: unknown }).token ?? '').trim()
      if (!TOKEN_SHAPE.test(token)) {
        return {
          ok: false,
          message:
            'That does not look like a bot token (it looks like 123456:ABC...). Copy it from @BotFather.',
        }
      }
      const call = async (method: string): Promise<{ status: number; body: unknown }> => {
        const res = await ctx.fetch(`${apiRoot}/bot${token}/${method}`, {
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
        let body: unknown
        try {
          body = await res.json()
        } catch {
          body = undefined
        }
        return { status: res.status, body }
      }
      try {
        const me = await call('getMe')
        if (me.status === 401 || me.status === 404) {
          return {
            ok: false,
            message:
              'Telegram rejected the token. Check it with @BotFather (/token) or create a new one.',
          }
        }
        const result = me.body as { ok?: boolean; result?: Record<string, unknown> } | undefined
        if (!result?.ok || result.result === undefined) {
          return { ok: false, message: `Telegram answered with an error (HTTP ${me.status}).` }
        }
        const bot = result.result as {
          username?: string
          first_name?: string
          can_read_all_group_messages?: boolean
        }
        const parts = [privacyGuidance(bot.can_read_all_group_messages === true)]
        try {
          const hook = await call('getWebhookInfo')
          const url = (hook.body as { result?: { url?: string } } | undefined)?.result?.url
          if (url) {
            parts.push(
              'A webhook is set on this bot. Polling needs it removed: the Channels page can do that when you connect the bot.',
            )
          }
        } catch {
          // the webhook check is a courtesy
        }
        return {
          ok: true,
          accountLabel: bot.username === undefined ? (bot.first_name ?? 'bot') : `@${bot.username}`,
          message: parts.join(' '),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach Telegram: ${scrubToken(error instanceof Error ? error.message : String(error), token).slice(0, 160)}`,
        }
      }
    },
  })
}
