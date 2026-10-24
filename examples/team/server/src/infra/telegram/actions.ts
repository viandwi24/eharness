/**
 * The platform layer of a Telegram BOT: what the Bot API can do that the generic channel tools
 * (send, reply, upload, react, edit, delete, pin) do not cover. Few tools with an `action`
 * enum (a compact tool list keeps the prompt cache prefix small); each tool has one static risk.
 *
 *   telegram_chat_info          read         chat, member count, administrators (exact rights), one member
 *   telegram_join_requests      external     list / approve / decline pending join requests
 *   telegram_chat_messages      external     pin, unpin, polls and quizzes, copy, forward, albums
 *   telegram_chat_topics        write        forum topics (create, edit, close, reopen, General topic)
 *   telegram_chat_settings      write+owner  title, description, photo removal, default permissions, sticker set
 *   telegram_chat_members       write+owner  ban, unban, kick, restrict, promote, demote, admin title, sender chats
 *   telegram_chat_invites       external+owner  invite links (export, create, edit, revoke)
 *   telegram_bot_profile        write+owner  the bot's own commands, description and name
 *   telegram_chat_destructive   destructive+owner+confirm  delete a topic, delete messages in bulk, leave a chat
 *
 * Who may (decided in code, never by what a message says): the channels plugin refuses `ownerOnly`
 * tools unless the requester is an owner (the signed-in web owner counts as one; members and guests
 * never get a native tool at all). Destructive actions also need `confirm: true` here. Every call
 * goes through the API governor, which writes the audit row (who asked, role, target, parameter
 * summary, result, duration); a refusal is reported with `reportRefusal`, a failure with
 * `reportFailure`. An error is per request: it never opens the outbound circuit breaker.
 *
 * Bot API limits that are explained to the model instead of attempted: a bot cannot create groups
 * or channels, cannot add people to a chat, cannot set slow mode, channel signatures or the
 * linked discussion group, cannot read history, and can message only people who started it.
 */
import type { Bot } from 'grammy'
import { GrammyError } from 'grammy'
import { z } from 'zod'
import { reportFailure, reportRefusal } from '../channels/governor.ts'
import type { JoinRequest, JoinRequestStore, JoinResolution } from '../channels/join-requests.ts'
import type { NativeAction } from '../channels/types.ts'
import { scrubToken } from './adapter.ts'

// --- join requests held for the agent ----------------------------------------------------------

export {
  createJoinRequestStore,
  type JoinRequest,
  type JoinRequestStore,
} from '../channels/join-requests.ts'

// --- rights and fields ---------------------------------------------------------------------------

/** Every administrator right of `promoteChatMember` (groups and channels). */
export const ADMIN_RIGHTS = [
  'is_anonymous',
  'can_manage_chat',
  'can_change_info',
  'can_post_messages',
  'can_edit_messages',
  'can_delete_messages',
  'can_invite_users',
  'can_restrict_members',
  'can_pin_messages',
  'can_manage_topics',
  'can_promote_members',
  'can_manage_video_chats',
  'can_post_stories',
  'can_edit_stories',
  'can_delete_stories',
  'can_manage_tags',
  'can_manage_direct_messages',
] as const
type AdminRight = (typeof ADMIN_RIGHTS)[number]

/** The default member permissions of a group (`setChatPermissions`, `restrictChatMember`). */
export const MEMBER_PERMISSIONS = [
  'can_send_messages',
  'can_send_audios',
  'can_send_documents',
  'can_send_photos',
  'can_send_videos',
  'can_send_video_notes',
  'can_send_voice_notes',
  'can_send_polls',
  'can_send_other_messages',
  'can_add_web_page_previews',
  'can_react_to_messages',
  'can_change_info',
  'can_invite_users',
  'can_pin_messages',
  'can_manage_topics',
] as const

const chatField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Chat id (e.g. -1001234567890) or @channelusername. Needed for every action but bot_profile.',
  )
const userField = z.coerce
  .number()
  .int()
  .optional()
  .describe('Telegram user id (a number). A bot cannot resolve @usernames of people.')
const messageField = z.coerce.number().int().optional().describe('Message id.')
const messagesField = z
  .array(z.coerce.number().int())
  .min(1)
  .max(100)
  .optional()
  .describe('Message ids (up to 100).')
const topicField = z.coerce.number().int().optional().describe('Forum topic id.')
const confirmField = z
  .boolean()
  .optional()
  .describe(
    'Must be true for destructive requests: ask the person first, then repeat with confirm true.',
  )
const rightsField = z
  .array(z.enum(ADMIN_RIGHTS))
  .optional()
  .describe(
    `The admin rights to HAVE after the call (every other right is switched off). Groups: can_manage_chat, can_change_info, can_delete_messages, can_invite_users, can_restrict_members, can_pin_messages, can_manage_topics, can_manage_video_chats, can_promote_members, is_anonymous, can_manage_tags. Channels: can_post_messages, can_edit_messages, can_delete_messages, can_invite_users, can_change_info, can_manage_chat, can_promote_members, can_post_stories, can_edit_stories, can_delete_stories, can_manage_direct_messages.`,
  )
const permissionsField = z
  .array(z.enum(MEMBER_PERMISSIONS))
  .optional()
  .describe('The permissions members/the restricted person HAVE (every other one is switched off).')

// --- readable errors -------------------------------------------------------------------------------

interface Ctx {
  /** `tool.action` as shown in errors. */
  what: string
  /** The admin right the bot needs for it, by Bot API name. */
  right?: string
}

const RIGHT_WORDS: Record<string, string> = {
  can_change_info: 'Change group info',
  can_delete_messages: 'Delete messages',
  can_restrict_members: 'Ban users',
  can_invite_users: 'Invite users via link',
  can_pin_messages: 'Pin messages',
  can_manage_topics: 'Manage topics',
  can_promote_members: 'Add new admins',
  can_post_messages: 'Post messages (channels)',
  can_edit_messages: "Edit other people's messages (channels)",
  can_manage_chat: 'Manage the chat',
  can_manage_video_chats: 'Manage video chats',
}

const rightPhrase = (right?: string): string =>
  right === undefined
    ? 'the right administrator permission'
    : `the administrator right "${RIGHT_WORDS[right] ?? right}" (${right})`

/** What a Bot API refusal means for the model and the owner, with the missing right named. */
export function explainBotError(error: unknown, ctx: Ctx, token?: string): string {
  const raw =
    error instanceof GrammyError
      ? error.description
      : error instanceof Error
        ? error.message
        : String(error)
  const d = scrubToken(raw, token)
  const lower = d.toLowerCase()
  const t = (s: string): string => `${ctx.what}: ${s} (Telegram said: ${d})`
  if (
    /not enough rights|chat_admin_required|need administrator rights|have no rights|rights to/.test(
      lower,
    )
  ) {
    return t(
      `the bot does not have ${rightPhrase(ctx.right)} in this chat, or it is not an administrator there. An owner of the chat has to make the bot an administrator with that right (chat settings, Administrators)`,
    )
  }
  if (
    /can't demote chat creator|can't remove chat owner|owner/.test(lower) &&
    /creator|owner/.test(lower)
  ) {
    return t('the target is the creator (owner) of the chat: nobody can change or remove them')
  }
  if (/user is an administrator of the chat|can't restrict|can't ban|administrator/.test(lower)) {
    return t(
      'the target is an administrator. A bot cannot ban or restrict admins, and it can only change the rights of admins it promoted itself (an admin promoted by someone else must be changed by them or by the creator)',
    )
  }
  if (/method is available (for|only)|supergroup|channel chats only|only for/.test(lower)) {
    return t('this only works in supergroups and channels (basic groups do not support it)')
  }
  if (/chat not found|bot is not a member|bot was kicked|forbidden: bot/.test(lower)) {
    return t('the bot is not in that chat (or the chat id is wrong). Add the bot to the chat first')
  }
  if (/user not found|participant_id_invalid|user_not_participant|member not found/.test(lower)) {
    return t('that person is not a member of the chat, or the user id is wrong')
  }
  if (/not modified/.test(lower)) return t('nothing to change: it is already like that')
  if (/forum|topic/.test(lower)) {
    return t(
      'the chat is not a forum with topics, or the topic id does not exist (General is topic 1)',
    )
  }
  if (/message to .* not found|message_id_invalid|message can't be|message not found/.test(lower)) {
    return t('the message does not exist, is too old, or the bot cannot touch it')
  }
  if (/initiate conversation|can't initiate|blocked by the user|user is deactivated/.test(lower)) {
    return t(
      'the person has to open the bot and press Start first: bots cannot message people first',
    )
  }
  if (/hide_requester_missing|join request|not found/.test(lower)) {
    return t('there is no pending join request for that person (it may have been handled already)')
  }
  return `${ctx.what}: Telegram refused: ${d}`
}

const LIMITS = {
  add_member:
    'Bots cannot add people to a group or channel. Send the person an invite link (telegram_chat_invites create_link) in a chat where they already talk to the bot: a bot can only message people who started it. With a link that requires approval, their request arrives here and telegram_join_requests approves it.',
  create_chat:
    'Bots cannot create groups or channels. A person (or the Telegram user account connector, if one is connected) creates it, then adds the bot as an administrator.',
  slow_mode:
    'The Bot API has no slow mode setting. An admin sets it in the Telegram app (group settings, Permissions, Slow mode); getChat shows the current value.',
  signatures:
    'Channel post signatures and sender names are not part of the Bot API: change them in the Telegram app.',
  discussion_group:
    'Linking a channel to a discussion group is not in the Bot API: do it in the Telegram app (channel settings, Discussion). getChat shows the linked chat.',
  set_photo:
    'setChatPhoto needs a file upload, which this tool does not take. Set the photo in the Telegram app; delete_photo works.',
} as const

// --- the actions -------------------------------------------------------------------------------

export interface BotActionDeps {
  bot: Bot
  token: string
  joinRequests: JoinRequestStore
  /** A pending request was answered by this bot's tool: the adapter tells the gateway (`member.join_request_resolved`). */
  resolved?: (request: JoinRequest, resolution: JoinResolution) => void
  now?: () => number
}

const chatArg = (value: string): number | string => (/^-?\d+$/.test(value) ? Number(value) : value)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  return m < 60
    ? `${m} min ago`
    : m < 2880
      ? `${Math.round(m / 60)} h ago`
      : `${Math.round(m / 1440)} d ago`
}

const nameOf = (u: {
  first_name?: string
  last_name?: string
  username?: string
  id: number
}): string =>
  `${[u.first_name, u.last_name].filter(Boolean).join(' ') || 'someone'} (id ${u.id}${u.username === undefined ? '' : `, @${u.username}`})`

const flags = (o: object, names: readonly string[]): { on: string[]; off: string[] } => {
  const r = o as Record<string, unknown>
  const on: string[] = []
  const off: string[] = []
  for (const n of names) {
    if (r[n] === true) on.push(n)
    else if (r[n] === false) off.push(n)
  }
  return { on, off }
}

export function botActions(d: BotActionDeps): NativeAction[] {
  const { bot, token } = d
  const now = d.now ?? Date.now

  /** A refusal made here (not by Telegram): audited as refused, answered as text. */
  const refuse = (text: string): string => {
    reportRefusal(text)
    return text
  }

  /** Run one Bot API call and turn a Telegram error into a sentence (a flood wait is thrown so the governor parks). */
  async function attempt(ctx: Ctx, fn: () => Promise<string>): Promise<string> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) throw error
      const text = explainBotError(error, ctx, token)
      // a missing right or a forbidden target is a refusal, anything else a failure
      if (
        /does not have|is an administrator|creator|not in that chat|only works in|not a member|start first|no pending/.test(
          text,
        )
      ) {
        reportRefusal(text.slice(0, 160))
      } else reportFailure(text.slice(0, 160))
      return text
    }
  }

  const need = (input: Record<string, unknown>, fields: string[]): string | undefined => {
    const missing = fields.filter((f) => input[f] === undefined || input[f] === '')
    return missing.length === 0
      ? undefined
      : `ERROR: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for this action.`
  }

  const untilOf = (input: Record<string, unknown>): { until_date?: number } => {
    const minutes = input.for_minutes
    if (typeof minutes === 'number' && minutes > 0) {
      return { until_date: Math.floor(now() / 1000) + Math.round(minutes * 60) }
    }
    return {}
  }

  const rightsMap = (list: readonly AdminRight[] | undefined): Record<AdminRight, boolean> =>
    Object.fromEntries(ADMIN_RIGHTS.map((r) => [r, list?.includes(r) === true])) as Record<
      AdminRight,
      boolean
    >
  const permMap = (list: readonly string[] | undefined): Record<string, boolean> =>
    Object.fromEntries(MEMBER_PERMISSIONS.map((p) => [p, list?.includes(p) === true]))

  /** Shared entry: pick the action, check the fields, run under the readable-error wrapper. */
  type Handler = {
    need?: string[]
    right?: string
    confirm?: string
    run(input: Record<string, unknown>, chat: number | string): Promise<string>
  }
  const dispatch =
    (tool: string, table: Record<string, Handler>, noChat: readonly string[] = []) =>
    async (input: Record<string, unknown>): Promise<string> => {
      const action = String(input.action)
      const h = table[action]
      const what = `${tool}.${action}`
      if (h === undefined)
        return `ERROR: unknown action "${action}". Use one of: ${Object.keys(table).join(', ')}.`
      if (!noChat.includes(action) && (typeof input.chat !== 'string' || input.chat === '')) {
        return 'ERROR: chat is required for this action.'
      }
      const missing = need(input, h.need ?? [])
      if (missing !== undefined) {
        reportFailure(missing)
        return missing
      }
      if (h.confirm !== undefined && input.confirm !== true) {
        return refuse(
          `Not done: ${h.confirm}. Ask the person to confirm, then repeat the same call with confirm: true.`,
        )
      }
      const chat = typeof input.chat === 'string' ? chatArg(input.chat) : ''
      return attempt({ what, ...(h.right === undefined ? {} : { right: h.right }) }, () =>
        h.run(input, chat),
      )
    }

  const n = (v: unknown): number => Number(v)
  const s = (v: unknown): string => String(v)

  // --- chat_info (read) ---------------------------------------------------------------------
  const info = dispatch(
    'chat_info',
    {
      chat: {
        run: async (_i, chat) => {
          const c = (await bot.api.getChat(chat)) as unknown as Record<string, unknown>
          const lines = [
            `${s(c.title ?? c.first_name ?? c.id)} (${s(c.id)}) type ${s(c.type)}${c.username ? ` @${s(c.username)}` : ''}${c.is_forum === true ? ', forum with topics' : ''}`,
          ]
          if (c.description) lines.push(`Description: ${clip(s(c.description), 400)}`)
          if (typeof c.slow_mode_delay === 'number')
            lines.push(
              `Slow mode: ${c.slow_mode_delay} s between messages (a person sets it in the app; bots cannot).`,
            )
          if (c.linked_chat_id !== undefined)
            lines.push(`Linked discussion/channel chat: ${s(c.linked_chat_id)}`)
          if (c.join_by_request === true)
            lines.push('New members must be approved (join requests).')
          if (c.has_protected_content === true)
            lines.push('Content is protected (no forwarding or saving).')
          if (c.permissions !== undefined && typeof c.permissions === 'object') {
            const f = flags(c.permissions as object, MEMBER_PERMISSIONS)
            lines.push(
              `Members may: ${f.on.join(', ') || 'nothing'}.${f.off.length > 0 ? ` Not allowed: ${f.off.join(', ')}.` : ''}`,
            )
          }
          if (c.pinned_message !== undefined) lines.push('A message is pinned.')
          return lines.join('\n')
        },
      },
      member_count: {
        run: async (_i, chat) => `${await bot.api.getChatMemberCount(chat)} members.`,
      },
      administrators: {
        run: async (_i, chat) => {
          const list = await bot.api.getChatAdministrators(chat)
          return [
            `${list.length} administrator(s):`,
            ...list.map((a) => {
              const on = ADMIN_RIGHTS.filter(
                (r) => (a as unknown as Record<string, unknown>)[r] === true,
              )
              const title = 'custom_title' in a && a.custom_title ? ` "${a.custom_title}"` : ''
              return `- ${nameOf(a.user)}${a.user.is_bot ? ' [bot]' : ''}: ${a.status}${title}${a.status === 'creator' ? ' (all rights)' : on.length > 0 ? `, rights: ${on.join(', ')}` : ', no rights'}`
            }),
          ].join('\n')
        },
      },
      member: {
        need: ['user'],
        run: async (i, chat) => {
          const m = (await bot.api.getChatMember(chat, n(i.user))) as unknown as Record<
            string,
            unknown
          > & {
            user: { id: number; first_name?: string; last_name?: string; username?: string }
            status: string
          }
          const extra: string[] = []
          if (m.status === 'administrator') {
            const on = ADMIN_RIGHTS.filter((r) => m[r] === true)
            extra.push(`rights: ${on.join(', ') || 'none'}`)
            if (m.custom_title) extra.push(`title "${s(m.custom_title)}"`)
            extra.push(
              m.can_be_edited === true
                ? 'the bot may edit this admin'
                : 'the bot may NOT edit this admin (promoted by someone else)',
            )
          }
          if (m.status === 'restricted') {
            const f = flags(m, MEMBER_PERMISSIONS)
            extra.push(`allowed: ${f.on.join(', ') || 'nothing'}`)
            if (typeof m.until_date === 'number' && m.until_date > 0)
              extra.push(`until ${new Date(m.until_date * 1000).toISOString()}`)
          }
          if (m.status === 'kicked' && typeof m.until_date === 'number' && m.until_date > 0)
            extra.push(`banned until ${new Date(m.until_date * 1000).toISOString()}`)
          return `${nameOf(m.user)}: ${m.status}${extra.length > 0 ? `; ${extra.join('; ')}` : ''}`
        },
      },
      limits: {
        run: async () =>
          'Bot API limits: bots cannot create groups or channels, add members, read history, set slow mode, channel signatures or the discussion link, and can only message people who started them. Bots cannot list all members (only administrators; telegram_chat_info member checks one user id they know).',
      },
    },
    ['limits'],
  )

  // --- join requests -----------------------------------------------------------------------------
  const answered = (chatId: string, userId: string, resolution: JoinResolution): void => {
    const r = d.joinRequests.resolve(chatId, userId, resolution, 'this bot')
    if (r !== undefined) d.resolved?.(r, resolution)
  }
  const joins = dispatch(
    'join_requests',
    {
      list: {
        run: async (_i, _chat) => {
          const chatId = typeof _i.chat === 'string' ? String(chatArg(_i.chat)) : undefined
          const list = d.joinRequests.list(chatId)
          if (list.length === 0)
            return 'No pending join requests seen by this bot (requests made before it was connected, or answered elsewhere, are not listed).'
          return [
            `${list.length} pending join request(s):`,
            ...list
              .slice(0, 30)
              .map(
                (r) =>
                  `- ${r.name} (id ${r.userId}${r.username === undefined ? '' : `, @${r.username}`}) wants into "${r.chatTitle}" (${r.chatId}) ${ago(r.at, now())}${r.link === undefined ? '' : ` via ${r.link}`}${r.bio === undefined ? '' : `; bio: ${clip(r.bio, 120)}`}`,
              ),
            ...(list.length > 30
              ? [`...and ${list.length - 30} more (name a chat to narrow the list).`]
              : []),
          ].join('\n')
        },
      },
      approve: {
        need: ['user'],
        right: 'can_invite_users',
        run: async (i, chat) => {
          await bot.api.approveChatJoinRequest(chat, n(i.user))
          answered(String(chat), s(i.user), 'approved')
          return `Join request of ${s(i.user)} approved: they are in the chat now.`
        },
      },
      decline: {
        need: ['user'],
        right: 'can_invite_users',
        run: async (i, chat) => {
          await bot.api.declineChatJoinRequest(chat, n(i.user))
          answered(String(chat), s(i.user), 'declined')
          return `Join request of ${s(i.user)} declined.`
        },
      },
    },
    ['list'],
  )

  // --- messages ----------------------------------------------------------------------------------
  const messages = dispatch('chat_messages', {
    pin: {
      need: ['message'],
      right: 'can_pin_messages',
      run: async (i, chat) => {
        await bot.api.pinChatMessage(chat, n(i.message), {
          disable_notification: i.notify !== true,
        })
        return `Message ${s(i.message)} pinned${i.notify === true ? ' (members were notified)' : ' silently'}.`
      },
    },
    unpin: {
      right: 'can_pin_messages',
      run: async (i, chat) => {
        await bot.api.unpinChatMessage(
          chat,
          ...(i.message === undefined ? [] : ([{ message_id: n(i.message) }] as never[])),
        )
        return i.message === undefined
          ? 'The most recent pinned message was unpinned.'
          : `Message ${s(i.message)} unpinned.`
      },
    },
    unpin_all: {
      right: 'can_pin_messages',
      confirm: 'unpinning ALL messages of the chat cannot be undone',
      run: async (_i, chat) => {
        await bot.api.unpinAllChatMessages(chat)
        return 'All pinned messages were unpinned.'
      },
    },
    send_poll: {
      need: ['question', 'options'],
      run: async (i, chat) => {
        const options = (i.options as string[]).map((text) => ({ text }))
        const quiz = i.quiz === true
        if (quiz && i.correct_option === undefined)
          return refuse(
            'Not done: a quiz needs correct_option (the 0-based index of the right answer).',
          )
        if (quiz && n(i.correct_option) >= options.length)
          return refuse('Not done: correct_option is outside the options.')
        const m = await bot.api.sendPoll(chat, s(i.question), options, {
          is_anonymous: i.anonymous !== false,
          ...(i.multiple === true && !quiz ? { allows_multiple_answers: true } : {}),
          ...(quiz ? { type: 'quiz' as const, correct_option_ids: [n(i.correct_option)] } : {}),
          ...(quiz && typeof i.explanation === 'string'
            ? { explanation: i.explanation.slice(0, 200) }
            : {}),
          ...(typeof i.open_seconds === 'number' ? { open_period: i.open_seconds } : {}),
          ...(i.topic === undefined ? {} : { message_thread_id: n(i.topic) }),
        })
        return `${quiz ? 'Quiz' : 'Poll'} posted as message ${m.message_id}.`
      },
    },
    stop_poll: {
      need: ['message'],
      run: async (i, chat) => {
        const p = await bot.api.stopPoll(chat, n(i.message))
        return `Poll closed. Votes: ${p.options.map((o) => `${o.text}=${o.voter_count}`).join(', ')} (total ${p.total_voter_count}).`
      },
    },
    copy: {
      need: ['to_chat'],
      run: async (i, chat) => {
        const ids =
          (i.messages as number[] | undefined) ?? (i.message === undefined ? [] : [n(i.message)])
        if (ids.length === 0) return 'ERROR: message or messages is required for this action.'
        const to = chatArg(s(i.to_chat))
        const extra = i.topic === undefined ? {} : { message_thread_id: n(i.topic) }
        if (ids.length === 1) {
          const r = await bot.api.copyMessage(to, chat, ids[0] as number, extra)
          return `Copied to ${s(i.to_chat)} as message ${r.message_id} (no link to the original).`
        }
        const r = await bot.api.copyMessages(to, chat, ids, extra)
        return `Copied ${r.length} message(s) to ${s(i.to_chat)} (no link to the originals).`
      },
    },
    forward: {
      need: ['to_chat'],
      run: async (i, chat) => {
        const ids =
          (i.messages as number[] | undefined) ?? (i.message === undefined ? [] : [n(i.message)])
        if (ids.length === 0) return 'ERROR: message or messages is required for this action.'
        const to = chatArg(s(i.to_chat))
        const extra = i.topic === undefined ? {} : { message_thread_id: n(i.topic) }
        if (ids.length === 1) {
          const r = await bot.api.forwardMessage(to, chat, ids[0] as number, extra)
          return `Forwarded to ${s(i.to_chat)} as message ${r.message_id}.`
        }
        const r = await bot.api.forwardMessages(to, chat, ids, extra)
        return `Forwarded ${r.length} message(s) to ${s(i.to_chat)}.`
      },
    },
    send_album: {
      need: ['photo_urls'],
      run: async (i, chat) => {
        const urls = (i.photo_urls as string[]).filter((u) => /^https:\/\//.test(u))
        if (urls.length < 2 || urls.length > 10)
          return refuse('Not done: an album needs 2 to 10 https photo urls.')
        const r = await bot.api.sendMediaGroup(
          chat,
          urls.map((media, k) => ({
            type: 'photo' as const,
            media,
            ...(k === 0 && typeof i.caption === 'string'
              ? { caption: i.caption.slice(0, 1024) }
              : {}),
          })),
          i.topic === undefined ? {} : { message_thread_id: n(i.topic) },
        )
        return `Album of ${r.length} photo(s) posted.`
      },
    },
  })

  // --- topics ------------------------------------------------------------------------------------
  const topics = dispatch('chat_topics', {
    create: {
      need: ['name'],
      right: 'can_manage_topics',
      run: async (i, chat) => {
        const t = await bot.api.createForumTopic(chat, s(i.name))
        return `Topic "${t.name}" created (topic id ${t.message_thread_id}).`
      },
    },
    edit: {
      need: ['topic', 'name'],
      right: 'can_manage_topics',
      run: async (i, chat) => {
        await bot.api.editForumTopic(chat, n(i.topic), { name: s(i.name) })
        return `Topic ${s(i.topic)} renamed.`
      },
    },
    close: {
      need: ['topic'],
      right: 'can_manage_topics',
      run: async (i, chat) => {
        await bot.api.closeForumTopic(chat, n(i.topic))
        return `Topic ${s(i.topic)} closed.`
      },
    },
    reopen: {
      need: ['topic'],
      right: 'can_manage_topics',
      run: async (i, chat) => {
        await bot.api.reopenForumTopic(chat, n(i.topic))
        return `Topic ${s(i.topic)} reopened.`
      },
    },
    unpin_all: {
      need: ['topic'],
      right: 'can_pin_messages',
      run: async (i, chat) => {
        await bot.api.unpinAllForumTopicMessages(chat, n(i.topic))
        return `Pinned messages of topic ${s(i.topic)} were unpinned.`
      },
    },
    general_rename: {
      need: ['name'],
      right: 'can_manage_topics',
      run: async (i, chat) => {
        await bot.api.editGeneralForumTopic(chat, s(i.name))
        return 'General topic renamed.'
      },
    },
    general_close: {
      right: 'can_manage_topics',
      run: async (_i, chat) => {
        await bot.api.closeGeneralForumTopic(chat)
        return 'General topic closed.'
      },
    },
    general_reopen: {
      right: 'can_manage_topics',
      run: async (_i, chat) => {
        await bot.api.reopenGeneralForumTopic(chat)
        return 'General topic reopened.'
      },
    },
    general_hide: {
      right: 'can_manage_topics',
      run: async (_i, chat) => {
        await bot.api.hideGeneralForumTopic(chat)
        return 'General topic hidden.'
      },
    },
    general_unhide: {
      right: 'can_manage_topics',
      run: async (_i, chat) => {
        await bot.api.unhideGeneralForumTopic(chat)
        return 'General topic shown again.'
      },
    },
  })

  // --- settings ----------------------------------------------------------------------------------
  const settings = dispatch(
    'chat_settings',
    {
      set_title: {
        need: ['title'],
        right: 'can_change_info',
        run: async (i, chat) => {
          await bot.api.setChatTitle(chat, s(i.title))
          return 'Title changed.'
        },
      },
      set_description: {
        need: ['description'],
        right: 'can_change_info',
        run: async (i, chat) => {
          await bot.api.setChatDescription(chat, s(i.description))
          return 'Description changed.'
        },
      },
      delete_photo: {
        right: 'can_change_info',
        run: async (_i, chat) => {
          await bot.api.deleteChatPhoto(chat)
          return 'Chat photo removed.'
        },
      },
      set_permissions: {
        need: ['permissions'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.setChatPermissions(chat, permMap(i.permissions as string[]), {
            use_independent_chat_permissions: i.independent === true,
          })
          return `Default member permissions set: ${(i.permissions as string[]).join(', ') || 'none'}.`
        },
      },
      set_sticker_set: {
        need: ['sticker_set'],
        right: 'can_change_info',
        run: async (i, chat) => {
          await bot.api.setChatStickerSet(chat, s(i.sticker_set))
          return 'Sticker set set (supergroups with enough boosts only).'
        },
      },
      delete_sticker_set: {
        right: 'can_change_info',
        run: async (_i, chat) => {
          await bot.api.deleteChatStickerSet(chat)
          return 'Sticker set removed.'
        },
      },
      set_photo: { run: async () => refuse(LIMITS.set_photo) },
      slow_mode: { run: async () => refuse(LIMITS.slow_mode) },
      signatures: { run: async () => refuse(LIMITS.signatures) },
      discussion_group: { run: async () => refuse(LIMITS.discussion_group) },
      create_chat: { run: async () => refuse(LIMITS.create_chat) },
    },
    ['create_chat'],
  )

  // --- members -----------------------------------------------------------------------------------
  const members = dispatch(
    'chat_members',
    {
      ban: {
        need: ['user'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          if (i.revoke_messages === true && i.confirm !== true) {
            return refuse(
              'Not done: banning with revoke_messages deletes everything the person wrote. Ask the person to confirm, then repeat with confirm: true.',
            )
          }
          await bot.api.banChatMember(chat, n(i.user), {
            ...untilOf(i),
            ...(i.revoke_messages === true ? { revoke_messages: true } : {}),
          })
          return `User ${s(i.user)} banned${typeof i.for_minutes === 'number' ? ` for ${i.for_minutes} minutes` : ' (until unbanned)'}${i.revoke_messages === true ? ', their messages deleted' : ''}.`
        },
      },
      unban: {
        need: ['user'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.unbanChatMember(chat, n(i.user), {
            only_if_banned: i.only_if_banned !== false,
          })
          return `User ${s(i.user)} may join again.`
        },
      },
      kick: {
        need: ['user'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.banChatMember(chat, n(i.user))
          await bot.api.unbanChatMember(chat, n(i.user), { only_if_banned: true })
          return `User ${s(i.user)} removed from the chat (they can join again with a link).`
        },
      },
      restrict: {
        need: ['user', 'permissions'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.restrictChatMember(chat, n(i.user), permMap(i.permissions as string[]), {
            ...untilOf(i),
            use_independent_chat_permissions: i.independent === true,
          })
          return `User ${s(i.user)} may now: ${(i.permissions as string[]).join(', ') || 'nothing'}${typeof i.for_minutes === 'number' ? ` (for ${i.for_minutes} minutes)` : ''}.`
        },
      },
      promote: {
        need: ['user', 'rights'],
        right: 'can_promote_members',
        run: async (i, chat) => {
          await bot.api.promoteChatMember(chat, n(i.user), rightsMap(i.rights as AdminRight[]))
          return `User ${s(i.user)} is an administrator with: ${(i.rights as string[]).join(', ') || 'no rights'}. The bot can only hand out rights it holds itself.`
        },
      },
      edit_admin: {
        need: ['user', 'rights'],
        right: 'can_promote_members',
        run: async (i, chat) => {
          await bot.api.promoteChatMember(chat, n(i.user), rightsMap(i.rights as AdminRight[]))
          return `Rights of admin ${s(i.user)} are now: ${(i.rights as string[]).join(', ') || 'none'}.`
        },
      },
      demote: {
        need: ['user'],
        right: 'can_promote_members',
        run: async (i, chat) => {
          await bot.api.promoteChatMember(chat, n(i.user), rightsMap([]))
          return `User ${s(i.user)} is no longer an administrator (only possible for admins this bot promoted).`
        },
      },
      admin_title: {
        need: ['user', 'title'],
        right: 'can_promote_members',
        run: async (i, chat) => {
          await bot.api.setChatAdministratorCustomTitle(chat, n(i.user), s(i.title).slice(0, 16))
          return `Admin title of ${s(i.user)} set (max 16 characters, no emoji, admins promoted by the bot in a supergroup only).`
        },
      },
      ban_sender_chat: {
        need: ['sender_chat'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.banChatSenderChat(chat, n(i.sender_chat))
          return `Channel ${s(i.sender_chat)} can no longer write in this chat as itself.`
        },
      },
      unban_sender_chat: {
        need: ['sender_chat'],
        right: 'can_restrict_members',
        run: async (i, chat) => {
          await bot.api.unbanChatSenderChat(chat, n(i.sender_chat))
          return `Channel ${s(i.sender_chat)} may write in this chat again.`
        },
      },
      add_member: { run: async () => refuse(LIMITS.add_member) },
    },
    ['add_member'],
  )

  // --- invites -----------------------------------------------------------------------------------
  const linkOpts = (i: Record<string, unknown>): Record<string, unknown> => ({
    ...(typeof i.name === 'string' ? { name: i.name.slice(0, 32) } : {}),
    ...(typeof i.expire_minutes === 'number'
      ? { expire_date: Math.floor(now() / 1000) + Math.round(i.expire_minutes * 60) }
      : {}),
    ...(typeof i.member_limit === 'number' ? { member_limit: i.member_limit } : {}),
    ...(i.requires_approval === true ? { creates_join_request: true } : {}),
  })
  const invites = dispatch('chat_invites', {
    export_link: {
      right: 'can_invite_users',
      run: async (_i, chat) =>
        `Primary invite link (the old one stops working): ${await bot.api.exportChatInviteLink(chat)}`,
    },
    create_link: {
      right: 'can_invite_users',
      run: async (i, chat) => {
        if (i.requires_approval === true && typeof i.member_limit === 'number') {
          return refuse(
            'Not done: a link that needs approval cannot also have a member limit (Telegram rule).',
          )
        }
        const l = await bot.api.createChatInviteLink(chat, linkOpts(i))
        return `Invite link created: ${l.invite_link}${l.creates_join_request ? ' (each person needs approval: telegram_join_requests)' : ''}.`
      },
    },
    edit_link: {
      need: ['link'],
      right: 'can_invite_users',
      run: async (i, chat) => {
        const l = await bot.api.editChatInviteLink(chat, s(i.link), linkOpts(i))
        return `Invite link updated: ${l.invite_link}.`
      },
    },
    revoke_link: {
      need: ['link'],
      right: 'can_invite_users',
      run: async (i, chat) => {
        const l = await bot.api.revokeChatInviteLink(chat, s(i.link))
        return `Invite link revoked${l.is_revoked ? '' : ' (Telegram did not confirm)'}.`
      },
    },
  })

  // --- bot profile -------------------------------------------------------------------------------
  const profile = dispatch(
    'bot_profile',
    {
      set_commands: {
        need: ['commands'],
        run: async (i) => {
          const list = (i.commands as Array<{ command: string; description: string }>).map((c) => ({
            command: c.command.replace(/^\//, '').toLowerCase(),
            description: c.description,
          }))
          await bot.api.setMyCommands(list)
          return `Bot commands set: ${list.map((c) => `/${c.command}`).join(', ')}.`
        },
      },
      set_description: {
        need: ['text'],
        run: async (i) => {
          await bot.api.setMyDescription(s(i.text).slice(0, 512))
          return 'Bot description set.'
        },
      },
      set_name: {
        need: ['text'],
        run: async (i) => {
          await bot.api.setMyName(s(i.text).slice(0, 64))
          return 'Bot name set (Telegram allows this only a few times per period).'
        },
      },
    },
    ['set_commands', 'set_description', 'set_name'],
  )

  // --- destructive -------------------------------------------------------------------------------
  const destructive = dispatch('chat_destructive', {
    delete_topic: {
      need: ['topic'],
      right: 'can_delete_messages',
      confirm: 'deleting a topic deletes all its messages for everyone',
      run: async (i, chat) => {
        await bot.api.deleteForumTopic(chat, n(i.topic))
        return `Topic ${s(i.topic)} deleted with all its messages.`
      },
    },
    delete_messages: {
      need: ['messages'],
      right: 'can_delete_messages',
      confirm: 'deleting messages in bulk cannot be undone',
      run: async (i, chat) => {
        const ids = i.messages as number[]
        await bot.api.deleteMessages(chat, ids)
        return `Asked Telegram to delete ${ids.length} message(s) (ones older than 48 hours in groups, or already gone, are skipped silently).`
      },
    },
    leave_chat: {
      confirm: 'the bot leaves the chat and loses its settings there',
      run: async (_i, chat) => {
        await bot.api.leaveChat(chat)
        return 'The bot left the chat. An admin has to add it again to come back.'
      },
    },
  })

  const act = z.enum

  return [
    {
      name: 'chat_info',
      risk: 'read',
      summary:
        'Read a Telegram chat as the bot: chat (title, description, slow mode, linked chat, default permissions), member_count, administrators (with their exact rights), member (status and rights of one user id), limits (what bots cannot do). Bots cannot list all members.',
      schema: z.object({
        action: act(['chat', 'member_count', 'administrators', 'member', 'limits']),
        chat: chatField,
        user: userField,
      }),
      run: info,
    },
    {
      name: 'join_requests',
      risk: 'external',
      summary:
        'Pending join requests of chats whose invite link needs approval: list (who, which chat, bio, link used), approve or decline one by user id. The bot needs the "invite users" admin right. Approve or decline according to the owner\'s rules; when unsure, ask an owner.',
      schema: z.object({
        action: act(['list', 'approve', 'decline']),
        chat: chatField,
        user: userField,
      }),
      run: joins,
    },
    {
      name: 'chat_messages',
      risk: 'external',
      summary:
        'Telegram message tools beyond plain send: pin (notify true to alert members) / unpin / unpin_all, send_poll (poll or quiz: quiz true + correct_option index + explanation, open_seconds 5-600), stop_poll, copy and forward (chat is the source, to_chat the destination, one or many message ids), send_album (2-10 https photo urls). The bot needs the matching admin right (pin messages).',
      schema: z.object({
        action: act([
          'pin',
          'unpin',
          'unpin_all',
          'send_poll',
          'stop_poll',
          'copy',
          'forward',
          'send_album',
        ]),
        chat: chatField,
        to_chat: z.string().optional().describe('Destination chat of copy / forward.'),
        message: messageField,
        messages: messagesField,
        topic: topicField,
        notify: z.boolean().optional().describe('pin: notify members (default silent).'),
        question: z.string().max(300).optional(),
        options: z.array(z.string().min(1).max(100)).min(2).max(10).optional(),
        anonymous: z.boolean().optional(),
        multiple: z.boolean().optional().describe('Poll with several answers (not quizzes).'),
        quiz: z.boolean().optional(),
        correct_option: z
          .number()
          .int()
          .min(0)
          .max(9)
          .optional()
          .describe('Quiz: 0-based index of the right option.'),
        explanation: z.string().max(200).optional().describe('Quiz: shown after answering.'),
        open_seconds: z.number().int().min(5).max(600).optional(),
        photo_urls: z.array(z.string()).max(10).optional(),
        caption: z.string().max(1024).optional(),
        confirm: confirmField,
      }),
      run: messages,
    },
    {
      name: 'chat_topics',
      risk: 'write',
      summary:
        'Forum topics of a supergroup with topics: create, edit (rename), close, reopen, unpin_all, and the General topic (general_rename, general_close, general_reopen, general_hide, general_unhide). Needs the "manage topics" admin right. Deleting a topic is in telegram_chat_destructive.',
      schema: z.object({
        action: act([
          'create',
          'edit',
          'close',
          'reopen',
          'unpin_all',
          'general_rename',
          'general_close',
          'general_reopen',
          'general_hide',
          'general_unhide',
        ]),
        chat: chatField,
        topic: topicField,
        name: z.string().min(1).max(128).optional(),
      }),
      run: topics,
    },
    {
      name: 'chat_settings',
      risk: 'write',
      ownerOnly: true,
      summary:
        'Change a Telegram group or channel as the bot (owner only): set_title, set_description, delete_photo, set_permissions (default member permissions; independent true for per-type permissions), set_sticker_set, delete_sticker_set. Not possible for a bot, answered readably: set_photo (needs an upload), slow_mode, signatures, discussion_group, create_chat (bots cannot create groups or channels). The bot must be an administrator with the matching right.',
      schema: z.object({
        action: act([
          'set_title',
          'set_description',
          'delete_photo',
          'set_permissions',
          'set_sticker_set',
          'delete_sticker_set',
          'set_photo',
          'slow_mode',
          'signatures',
          'discussion_group',
          'create_chat',
        ]),
        chat: chatField,
        title: z.string().min(1).max(128).optional(),
        description: z.string().max(255).optional(),
        permissions: permissionsField,
        independent: z
          .boolean()
          .optional()
          .describe('Permissions per content type (use_independent_chat_permissions).'),
        sticker_set: z.string().optional(),
      }),
      run: settings,
    },
    {
      name: 'chat_members',
      risk: 'write',
      ownerOnly: true,
      summary:
        'Moderate and manage members and admins as the bot (owner only): ban (for_minutes optional; revoke_messages needs confirm), unban, kick (ban + unban), restrict (permissions + for_minutes), promote / edit_admin (rights = the full list of rights the admin should have, groups and channels), demote, admin_title, ban_sender_chat / unban_sender_chat. A bot cannot add people (add_member explains the invite link workaround) and cannot ban or restrict admins; it can only edit admins it promoted itself and only grant rights it holds. Needs the "ban users" / "add new admins" right.',
      schema: z.object({
        action: act([
          'ban',
          'unban',
          'kick',
          'restrict',
          'promote',
          'edit_admin',
          'demote',
          'admin_title',
          'ban_sender_chat',
          'unban_sender_chat',
          'add_member',
        ]),
        chat: chatField,
        user: userField,
        sender_chat: z.coerce
          .number()
          .int()
          .optional()
          .describe('Channel id (negative number) for ban_sender_chat.'),
        for_minutes: z
          .number()
          .min(1)
          .max(525_600)
          .optional()
          .describe('ban / restrict duration; omit for permanent.'),
        revoke_messages: z
          .boolean()
          .optional()
          .describe('ban: also delete everything they wrote (needs confirm).'),
        only_if_banned: z
          .boolean()
          .optional()
          .describe('unban: default true (never removes a current member).'),
        rights: rightsField,
        permissions: permissionsField,
        independent: z.boolean().optional(),
        title: z
          .string()
          .max(16)
          .optional()
          .describe('admin_title: up to 16 characters, no emoji.'),
        confirm: confirmField,
      }),
      run: members,
    },
    {
      name: 'chat_invites',
      risk: 'external',
      ownerOnly: true,
      summary:
        'Invite links of a chat (owner only): export_link (replaces the primary link), create_link (name, expire_minutes, member_limit, or requires_approval true so people ask to join: see telegram_join_requests), edit_link, revoke_link. Bots cannot add people directly: send the link in a chat where the person already talks to the bot. Needs the "invite users" right.',
      schema: z.object({
        action: act(['export_link', 'create_link', 'edit_link', 'revoke_link']),
        chat: chatField,
        link: z.string().optional().describe('edit_link / revoke_link: the invite link.'),
        name: z.string().max(32).optional(),
        expire_minutes: z.number().min(1).optional(),
        member_limit: z.number().int().min(1).max(99_999).optional(),
        requires_approval: z.boolean().optional(),
      }),
      run: invites,
    },
    {
      name: 'bot_profile',
      risk: 'write',
      ownerOnly: true,
      summary:
        "The bot's own profile (owner only, changes it for every chat): set_commands (the / menu), set_description, set_name.",
      schema: z.object({
        action: act(['set_commands', 'set_description', 'set_name']),
        commands: z
          .array(
            z.object({
              command: z.string().min(1).max(33),
              description: z.string().min(1).max(256),
            }),
          )
          .max(100)
          .optional(),
        text: z.string().max(512).optional(),
      }),
      run: profile,
    },
    {
      name: 'chat_destructive',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Irreversible Telegram operations (owner only, each needs confirm: true after asking the person): delete_topic (with all messages), delete_messages (bulk, up to 100 ids), leave_chat (the bot leaves).',
      schema: z.object({
        action: act(['delete_topic', 'delete_messages', 'leave_chat']),
        chat: chatField,
        topic: topicField,
        messages: messagesField,
        confirm: confirmField,
      }),
      run: destructive,
    },
  ] satisfies NativeAction[]
}
