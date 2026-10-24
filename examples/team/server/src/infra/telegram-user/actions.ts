/**
 * The platform layer of a Telegram user account (P41, "two layers of tools"): what MTProto can do
 * that the generic channel tools do not cover. Each action is a deferred tool `telegram_user_<name>`
 * with a static risk; the gateway runs it through the connection's API governor and audits it.
 *
 * Who may (decided in code, never by what a message says):
 *  - members and guests of a chat never get a native tool (`roles.ts`); owners and admins do, by risk;
 *  - `ownerOnly` actions (ban, unban, restrict, promote, demote, delete a member's messages, invite
 *    links, join, leave) are refused unless the person asking is an owner (a web chat is the client: allowed);
 *  - every write, external and destructive action still asks for approval (the permission engine).
 *
 * What it may touch:
 *  - content and member reads (search, get, members), posts (forward, poll, scheduled) and topic or
 *    moderation changes only work on chats CHOSEN for ingest (Channels page or `choose_chat`): never on
 *    a person's direct chat with the account, never on a chat nobody chose;
 *  - metadata reads (`list_dialogs`, `get_chat`) cover every chat of the account;
 *  - posts keep the account's daily send cap and the flood park, and handles in our text are made
 *    harmless (`neutralizeHandles`), like `channel_send`.
 *
 * Telegram publishes few limits; the ban-prone calls get hard caps of our own (research notes in the
 * plan): username lookups 5 per minute and 30 per day, joins 3 per day, scheduled posts at least one
 * minute and at most 365 days ahead, polls 2 to 12 options.
 */
import { z } from 'zod'
import { localTime } from '../channels/header.ts'
import { neutralizeHandles } from '../channels/mentions.ts'
import type { NativeAction } from '../channels/types.ts'
import { ADMIN_EVENT_KINDS, type AdminLogQuery } from './adminlog.ts'
import type { TgAdminRights, TgChat, TgMessage, TgTopic, TgUserClient } from './client.ts'
import { ADMIN_RIGHTS, manageActions } from './manage.ts'
import type { AccountSettings, ChatStore, CounterStore } from './store.ts'

export interface AccountActionDeps {
  connectionId: string
  client: TgUserClient
  chats: ChatStore
  counters: CounterStore
  settings: () => AccountSettings
  selfId: string
  /** The live dialogs (cached briefly; `true` reads Telegram again). */
  dialogs(refresh?: boolean): Promise<TgChat[]>
  /** Park check and error mapping of one call (flood waits become rate limits the governor sees). */
  call<T>(chatId: string | undefined, fn: () => Promise<T>): Promise<T>
  /** A reason to refuse every post (the account is flagged); undefined = fine. */
  blocked(): string | undefined
  /** Titles learned from Telegram (forum topics) go to the gateway. */
  learnTopics(chat: TgChat, list: TgTopic[]): void
  /** The team timezone, for times shown to the model. */
  timezone(): string
  now(): number
  /** Pause between two spaced calls (adding people); default a real timer. */
  sleep?(ms: number): Promise<void>
  /** A library file (image for a chat photo, album files); undefined = no such file. */
  readFile?(path: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  hooks: {
    dialogsSeen?(list: TgChat[]): void
    chooseChat?(chatId: string, days: number): Promise<string>
    backfill?(chatId: string, days: number): Promise<string>
    adminLogRead?(chatId: string, query: AdminLogQuery): Promise<string>
    /** A chat was joined or left by an action: refresh what the Channels page lists. */
    chatsChanged?(): void
    /** A chat was created by an action: choose it so the app reads it and answers when mentioned. */
    chatCreated?(chat: TgChat): Promise<void>
  }
}

/** Appended when a search or a message id finds nothing in a chat the account administers. */
export const DELETED_HINT =
  'If it may have been deleted: admin_log of that chat shows deleted messages with their text (Telegram keeps them about 48 hours).'

/** The admin rights `promote_member` may hand out: everything Telegram offers (the owner decides, approval asks). */
export const PROMOTE_RIGHTS = ADMIN_RIGHTS

const RESOLVE_PER_MINUTE = 5
const RESOLVE_PER_DAY = 30
const JOINS_PER_DAY = 3
const MIN_SCHEDULE_MS = 60_000
const MAX_SCHEDULE_MS = 365 * 86_400_000

const chatField = z
  .string()
  .min(1)
  .describe(
    'The chat id as list_dialogs or channel_describe shows it (e.g. -1001234567890), or its exact title.',
  )
const topicField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Forum topic id (list_forum_topics; leave out or 0 for General / a chat without topics).',
  )
const userField = z
  .string()
  .min(1)
  .max(64)
  .describe('The person: their Telegram user id (preferred) or @username.')
const daysField = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .describe(
    'REQUIRED: how many days back to read the history (0 = none, only from now on). Ask the person when they did not say.',
  )

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function accountActions(d: AccountActionDeps): NativeAction[] {
  const { connectionId, client, chats, counters } = d
  const resolveTimes: number[] = []

  const when = (at: number): string => {
    const t = localTime(at, d.timezone())
    return `${t.date} ${t.clock} ${t.zone}`
  }

  /** A chat of the account by id or exact title, or a sentence saying why not. */
  async function findChat(ref: string): Promise<TgChat | string> {
    const r = ref.trim()
    let list = await d.dialogs()
    let hit = list.find((c) => c.id === r) ?? list.find((c) => c.title === r)
    if (hit === undefined) {
      list = await d.dialogs(true)
      hit = list.find((c) => c.id === r) ?? list.find((c) => c.title === r)
    }
    if (hit === undefined) {
      return `ERROR: "${ref}" is not a chat of this account. list_dialogs shows the chats it is in.`
    }
    return hit
  }

  /** A group or channel chosen for ingest, or a sentence saying why not. */
  async function chosenChat(ref: string): Promise<TgChat | string> {
    const c = await findChat(ref)
    if (typeof c === 'string') return c
    if (c.kind === 'dm') {
      return 'ERROR: that is a direct chat with a person. Platform actions never read or act on direct chats.'
    }
    if (!chats.isSelected(connectionId, c.id)) {
      return `ERROR: "${c.title}" (${c.id}) is not chosen for ingest, so it cannot be read or changed. An owner or admin can choose it (choose_chat, with backfill_days).`
    }
    return c
  }

  function postRefusal(): string | undefined {
    const blocked = d.blocked()
    if (blocked !== undefined) return `ERROR: posting is paused for this account: ${blocked}`
    const max = d.settings().dailyMax
    if (counters.get(connectionId, 'all', d.now()) >= max) {
      return `ERROR: the account reached its daily limit of ${max} messages (it resets at 00:00 UTC).`
    }
    return undefined
  }

  const ownerAdmin = (c: TgChat): string | undefined =>
    c.admin
      ? undefined
      : `ERROR: this account is not an admin of "${c.title}": Telegram refuses this.`

  /** The hint line for an empty result, only where the account can read the admin log. */
  const deletedHint = (c: TgChat): string => (c.admin && c.kind !== 'dm' ? `\n${DELETED_HINT}` : '')

  /** A past moment: `YYYY-MM-DD` (start of day) or `YYYY-MM-DD HH:MM`, in the team timezone. */
  function readPast(text: string, endOfDay: boolean): number | string {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T\s]+(\d{1,2}):(\d{2}))?$/.exec(text.trim())
    if (m === null) return `ERROR: "${text}" is not a time like 2026-10-13 or 2026-10-13 14:30.`
    const day = readAtDay(m[1] as string, d.timezone())
    if (m[2] === undefined) return endOfDay ? day + 86_400_000 - 1 : day
    return day + Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000
  }

  /** A future moment from `at` ("YYYY-MM-DD HH:MM" in the team zone, or ISO with offset). */
  function readAt(text: string): number | string {
    const zone = d.timezone()
    const t = text.trim()
    let at: number | undefined
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(t) && /T|\s/.test(t)) {
      const ms = Date.parse(t.replace(' ', 'T'))
      at = Number.isNaN(ms) ? undefined : ms
    } else {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{2})$/.exec(t)
      if (m !== null) {
        const naive = Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
        )
        // the offset of the zone at that moment (two passes settle a DST edge)
        let guess = naive
        for (let i = 0; i < 3; i++) {
          const p = localTime(guess, zone)
          const shown = Date.parse(`${p.date}T${p.clock}:00Z`)
          const delta = naive - shown
          if (delta === 0) break
          guess += delta
        }
        at = guess
      }
    }
    if (at === undefined)
      return `ERROR: could not read the time "${text}". Use "YYYY-MM-DD HH:MM" in ${zone}.`
    const ahead = at - d.now()
    if (ahead < MIN_SCHEDULE_MS) {
      return `ERROR: ${when(at)} is not at least one minute ahead (now it is ${when(d.now())}).`
    }
    if (ahead > MAX_SCHEDULE_MS) return 'ERROR: Telegram schedules at most 365 days ahead.'
    return at
  }

  const line = (m: TgMessage): string => {
    const who =
      m.sender === undefined
        ? m.chat.title
        : `${m.sender.name} (id ${m.sender.id}${m.sender.username === undefined ? '' : `, @${m.sender.username}`})`
    const files =
      m.attachments.length > 0 ? ` [${m.attachments.map((a) => a.kind).join(', ')}]` : ''
    const reply = m.replyTo === undefined ? '' : ` (reply to ${m.replyTo.id})`
    const topic = m.topicId === undefined ? '' : ` topic ${m.topicId}`
    return `- ${m.id}${topic} ${when(m.at)} ${who}${reply}: ${clip(flat(m.text), 600)}${files}`
  }

  function canResolve(): string | undefined {
    const now = d.now()
    while (resolveTimes.length > 0 && now - (resolveTimes[0] as number) > 60_000)
      resolveTimes.shift()
    if (resolveTimes.length >= RESOLVE_PER_MINUTE) {
      return 'ERROR: too many username lookups this minute (Telegram limits them hard). Use the user id, member_lookup, or wait a minute.'
    }
    if (counters.get(connectionId, 'resolve', now) >= RESOLVE_PER_DAY) {
      return `ERROR: the daily limit of ${RESOLVE_PER_DAY} username lookups is reached (it protects the account). Use user ids or member_lookup.`
    }
    return undefined
  }

  const unavailable = (what: string): string => `ERROR: ${what} is not available for this account.`

  /** Spend one username lookup (the same cap as get_user), or a sentence saying why not. */
  function spendResolve(): string | undefined {
    const refusal = canResolve()
    if (refusal !== undefined) return refusal
    resolveTimes.push(d.now())
    counters.add(connectionId, 'resolve', d.now())
    return undefined
  }

  const base: NativeAction[] = [
    // --- discover --------------------------------------------------------------------------------
    {
      name: 'list_dialogs',
      risk: 'read',
      summary:
        'Every group and channel this Telegram account is a member of, read live from Telegram (also ones joined just now), with whether each is chosen for ingest. Only chosen chats can be read; an owner or admin chooses one with choose_chat.',
      schema: z.object({
        query: z
          .string()
          .max(100)
          .optional()
          .describe('Only titles or usernames containing this text.'),
        kind: z
          .enum(['group', 'channel', 'all'])
          .optional()
          .describe('Default all (people are left out).'),
      }),
      run: async (input) => {
        const list = await d.dialogs(true)
        d.hooks.dialogsSeen?.(list)
        const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
        const kind = input.kind ?? 'all'
        const rows = list
          .filter((c) => c.kind !== 'dm')
          .filter((c) => kind === 'all' || c.kind === kind)
          .filter(
            (c) =>
              q === '' ||
              c.title.toLowerCase().includes(q) ||
              (c.username ?? '').toLowerCase().includes(q),
          )
        if (rows.length === 0) {
          return q === ''
            ? 'This account is in no groups or channels.'
            : `No group or channel of this account matches "${input.query}".`
        }
        const shown = rows.slice(0, 200)
        return [
          `${rows.length} group(s) and channel(s)${rows.length > shown.length ? ` (first ${shown.length})` : ''}:`,
          ...shown.map(
            (c) =>
              `${c.id}  ${c.title}${c.username === undefined ? '' : ` @${c.username}`} (${c.kind}${c.forum ? ', forum' : ''}${c.admin ? ', admin' : ''}${c.members === undefined ? '' : `, ${c.members} members`}) ${chats.isSelected(connectionId, c.id) ? 'CHOSEN' : 'not chosen'}`,
          ),
        ].join('\n')
      },
    },
    {
      name: 'list_chats',
      risk: 'read',
      local: true,
      summary:
        'The chats this account has chosen for ingest (and whether it is an admin there). For every chat the account is in, use list_dialogs.',
      schema: z.object({}),
      run: async () => {
        const list = chats.selected(connectionId)
        if (list.length === 0) return 'No chats are chosen for this account yet.'
        return list
          .map(
            (c) =>
              `${c.chatId}  ${c.title} (${c.kind}${c.admin ? ', admin' : ''}${c.forum ? ', forum' : ''})`,
          )
          .join('\n')
      },
    },
    {
      name: 'get_chat',
      risk: 'read',
      summary:
        'Details of a group or channel of the account read live from Telegram: title, username, type, description, member and admin counts, linked discussion group, whether the account is admin and whether it is chosen.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        const c = await findChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm')
          return 'ERROR: that is a direct chat with a person; use get_user for people.'
        const getInfo = client.getChatInfo
        if (getInfo === undefined) return unavailable('get_chat')
        const info = await d.call(c.id, () => getInfo.call(client, c.id))
        return [
          `${info.title} (${info.id})${info.username === undefined ? '' : ` @${info.username}`}`,
          `Type: ${info.kind}${info.forum ? ', forum (topics)' : ''}. This account: ${info.admin ? 'admin' : 'member'}. ${chats.isSelected(connectionId, info.id) ? 'Chosen for ingest.' : 'Not chosen for ingest.'}`,
          ...(info.members === undefined
            ? []
            : [
                `Members: ${info.members}${info.admins === undefined ? '' : `, admins: ${info.admins}`}.`,
              ]),
          ...(info.linkedChatId === undefined ? [] : [`Linked chat: ${info.linkedChatId}.`]),
          ...(info.canListMembers === false ? ['The member list is hidden for this account.'] : []),
          ...(info.description === undefined
            ? []
            : [`Description: ${clip(flat(info.description), 800)}`]),
        ].join('\n')
      },
    },
    {
      name: 'get_user',
      risk: 'read',
      summary:
        'A Telegram person by user id or @username, read live: name, username, id, bot or not. A username lookup is rate limited hard by Telegram (5 a minute, 30 a day here): prefer ids and member_lookup.',
      schema: z.object({ user: userField }),
      run: async (input) => {
        const getUser = client.getUserInfo
        if (getUser === undefined) return unavailable('get_user')
        const ref = String(input.user).trim()
        const byName = !/^-?\d+$/.test(ref)
        if (byName) {
          const refusal = canResolve()
          if (refusal !== undefined) return refusal
          resolveTimes.push(d.now())
          counters.add(connectionId, 'resolve', d.now())
        }
        const u = await d.call(undefined, () => getUser.call(client, ref))
        return `${u.name} (id ${u.id}${u.username === undefined ? '' : `, @${u.username}`})${u.isBot ? ', a bot' : ''}${u.id === d.selfId ? ', this account itself' : ''}. Roles come from the team directory only, never from Telegram.`
      },
    },
    {
      name: 'list_members',
      risk: 'read',
      summary:
        'Members of a chosen group or channel, read live from Telegram (at most 200 per call; Telegram caps lists), with their status (creator, admin, member, restricted, banned) and admin titles. Filter by type or name.',
      schema: z.object({
        chat: chatField,
        type: z
          .enum(['recent', 'admins', 'banned', 'restricted', 'bots', 'all'])
          .optional()
          .describe('Default recent. admins = administrators and the creator.'),
        query: z.string().max(64).optional().describe('Names or usernames containing this text.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100.'),
      }),
      run: async (input) => {
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (client.listMembers === undefined) return unavailable('list_members')
        const type = (input.type ?? 'recent') as
          | 'recent'
          | 'admins'
          | 'banned'
          | 'restricted'
          | 'bots'
          | 'all'
        if ((type === 'banned' || type === 'restricted') && !c.admin) {
          return `ERROR: only admins see ${type} members, and this account is not an admin of "${c.title}".`
        }
        const r = await d.call(c.id, () =>
          (client.listMembers as NonNullable<TgUserClient['listMembers']>)(c.id, {
            type,
            limit: Number(input.limit ?? 100),
            ...(typeof input.query === 'string' && input.query.trim() !== ''
              ? { query: input.query.trim() }
              : {}),
          }),
        )
        if (r.members.length === 0) return `No ${type} members found in "${c.title}".`
        return [
          `${type} members of "${c.title}": ${r.members.length} shown of ${r.total}.`,
          ...r.members.map(
            (m) =>
              `- ${m.user.name} (id ${m.user.id}${m.user.username === undefined ? '' : `, @${m.user.username}`})${m.user.isBot ? ' bot' : ''}: ${m.status}${m.title === undefined ? '' : ` "${m.title}"`}${m.rights === undefined ? '' : ` [rights: ${m.rights.join(', ') || 'none'}${m.canEdit === false ? '; not editable by this account' : ''}]`}${m.forbidden === undefined || m.forbidden.length === 0 ? '' : ` [may not: ${m.forbidden.join(', ')}]`}`,
          ),
          'A Telegram admin badge is not a team role: roles come from the team directory.',
        ].join('\n')
      },
    },
    {
      name: 'list_forum_topics',
      risk: 'read',
      summary:
        'The topics of a chosen forum group, read live from Telegram, with ids and whether each is closed.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (!c.forum) return `"${c.title}" is not a forum (it has no topics).`
        if (client.forumTopics === undefined) return unavailable('list_forum_topics')
        const list = await d.call(c.id, () =>
          (client.forumTopics as NonNullable<TgUserClient['forumTopics']>)(c.id, { limit: 100 }),
        )
        d.learnTopics(c, list)
        return [
          `Topics of "${c.title}" (${list.length}):`,
          ...list.map((t) => `- ${t.id} "${t.title}"${t.closed ? ' (closed)' : ''}`),
        ].join('\n')
      },
    },
    // --- read content --------------------------------------------------------------------------
    {
      name: 'search_messages',
      risk: 'read',
      summary:
        "Search a chosen chat on Telegram's servers (also history that was never back-filled): by words, by sender, in one topic, in a date range. Newest first.",
      schema: z.object({
        chat: chatField,
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Words to find (empty with `from` = everything that person wrote).'),
        from: userField.optional().describe('Only messages of this person (user id preferred).'),
        topic: topicField,
        since: z.string().max(40).optional().describe('From this day, YYYY-MM-DD (team timezone).'),
        until: z
          .string()
          .max(40)
          .optional()
          .describe('Up to this day, YYYY-MM-DD inclusive (team timezone).'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
      }),
      run: async (input) => {
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (client.searchMessages === undefined) return unavailable('search_messages')
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (query === '' && input.from === undefined)
          return 'ERROR: give query words, from, or both.'
        const day = (text: unknown, end: boolean): number | undefined | string => {
          if (typeof text !== 'string' || text.trim() === '') return undefined
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
          if (m === null) return `ERROR: "${text}" is not a day like 2026-10-13.`
          const at = readAtDay(`${m[1]}-${m[2]}-${m[3]}`, d.timezone())
          return end ? at + 86_400_000 - 1 : at
        }
        const since = day(input.since, false)
        const until = day(input.until, true)
        if (typeof since === 'string') return since
        if (typeof until === 'string') return until
        const list = await d.call(c.id, () =>
          (client.searchMessages as NonNullable<TgUserClient['searchMessages']>)(c.id, {
            query,
            limit: Number(input.limit ?? 30),
            ...(typeof input.from === 'string' ? { fromUser: input.from } : {}),
            ...(typeof input.topic === 'number' && input.topic > 0 ? { topicId: input.topic } : {}),
            ...(since === undefined ? {} : { minDate: since }),
            ...(until === undefined ? {} : { maxDate: until }),
          }),
        )
        const found = list.filter((m) => !m.service)
        if (found.length === 0) return `Nothing found in "${c.title}".${deletedHint(c)}`
        return [
          `${found.length} message(s) in "${c.title}" (newest first, ${d.timezone()}):`,
          ...found.map(line),
        ].join('\n')
      },
    },
    {
      name: 'get_message',
      risk: 'read',
      summary:
        'Messages of a chosen chat by id, read live from Telegram (with sender ids, reply and topic).',
      schema: z.object({
        chat: chatField,
        ids: z.array(z.number().int().positive()).min(1).max(50).describe('Message ids.'),
      }),
      run: async (input) => {
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const ids = (input.ids as number[]) ?? []
        const list = await d.call(c.id, () => client.messagesById(c.id, ids))
        const missing = ids.some((_, i) => list[i] === null || list[i] === undefined)
        return (
          ids
            .map((id, i) => {
              const m = list[i]
              return m === null || m === undefined
                ? `- ${id}: not found (deleted, or not in this chat)`
                : line(m)
            })
            .join('\n') + (missing ? deletedHint(c) : '')
        )
      },
    },
    {
      name: 'admin_log',
      risk: 'read',
      summary:
        'The "Recent actions" of a chat the account administers: deleted messages with their text, edits, bans, promotions. Telegram keeps them only about 48 hours; this reads them from Telegram now and adds what was stored earlier. Filter by kind, words, time or person.',
      schema: z.object({
        chat: chatField,
        kind: z
          .enum(ADMIN_EVENT_KINDS)
          .optional()
          .describe('Only this kind of event (delete, edit, ban, ...).'),
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Words inside the event (e.g. the text of a deleted message).'),
        from_time: z
          .string()
          .max(40)
          .optional()
          .describe('From this time: YYYY-MM-DD or YYYY-MM-DD HH:MM (team timezone).'),
        to_time: z
          .string()
          .max(40)
          .optional()
          .describe('Up to this time (a bare day includes the whole day).'),
        user: z
          .string()
          .max(64)
          .optional()
          .describe(
            'The admin who acted or the person acted on: user id (preferred) or part of the name.',
          ),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      run: async (input) => {
        if (d.hooks.adminLogRead === undefined) return unavailable('admin_log')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'group' && !c.admin) {
          return `ERROR: this account is not an admin of "${c.title}": Telegram only shows the admin log to admins, and only for supergroups and channels.`
        }
        const from =
          typeof input.from_time === 'string' ? readPast(input.from_time, false) : undefined
        const to = typeof input.to_time === 'string' ? readPast(input.to_time, true) : undefined
        if (typeof from === 'string') return from
        if (typeof to === 'string') return to
        if (!c.admin) {
          return `ERROR: this account is not an admin of "${c.title}": Telegram only shows the admin log to admins.`
        }
        const query: AdminLogQuery = {
          limit: Number(input.limit ?? 30),
          ...(typeof input.kind === 'string' ? { kind: input.kind } : {}),
          ...(typeof input.query === 'string' && input.query.trim() !== ''
            ? { query: input.query }
            : {}),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(typeof input.user === 'string' && input.user.trim() !== ''
            ? { user: input.user }
            : {}),
        }
        return d.hooks.adminLogRead(c.id, query)
      },
    },
    // --- ingest ----------------------------------------------------------------------------------
    {
      name: 'choose_chat',
      risk: 'write',
      summary:
        'Choose a group or channel of this account for ingest (observe-only: messages are stored and readable, the agent never wakes or posts there on its own), and read its history back `backfill_days` days. Both the chat and the range are required.',
      schema: z.object({ chat: chatField, backfill_days: daysField }),
      run: async (input) => {
        if (d.hooks.chooseChat === undefined) return unavailable('choosing chats')
        const c = await findChat(String(input.chat))
        if (typeof c === 'string') return c
        return d.hooks.chooseChat(c.id, Number(input.backfill_days))
      },
    },
    {
      name: 'backfill',
      risk: 'write',
      summary:
        'Read the history of a chosen chat back `days` days into the stored log (then readable with channel_read and chat_history). Runs in the background through the rate-limit queue.',
      schema: z.object({
        chat: chatField,
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .describe(
            'REQUIRED: how many days back (1 to 3650). Ask the person when they did not say.',
          ),
      }),
      run: async (input) => {
        if (d.hooks.backfill === undefined) return unavailable('backfill')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        return d.hooks.backfill(c.id, Number(input.days))
      },
    },
    // --- publish ---------------------------------------------------------------------------------
    {
      name: 'forward_message',
      risk: 'external',
      summary:
        'Forward messages from one chosen chat to another chosen chat (or topic), now or scheduled. The people of the target chat see them; never forward from or to a direct chat.',
      schema: z.object({
        from_chat: chatField,
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .max(20)
          .describe('Message ids in from_chat.'),
        to_chat: chatField,
        to_topic: topicField,
        hide_author: z
          .boolean()
          .optional()
          .describe('Send as a copy without the "forwarded from" header.'),
        silent: z.boolean().optional(),
        at: z
          .string()
          .max(40)
          .optional()
          .describe('Schedule: "YYYY-MM-DD HH:MM" in the team timezone (at least 1 minute ahead).'),
      }),
      run: async (input) => {
        if (client.forwardMessages === undefined) return unavailable('forward_message')
        const from = await chosenChat(String(input.from_chat))
        if (typeof from === 'string') return from
        const to = await chosenChat(String(input.to_chat))
        if (typeof to === 'string') return to
        const refusal = postRefusal()
        if (refusal !== undefined) return refusal
        let at: number | undefined
        if (typeof input.at === 'string') {
          const r = readAt(input.at)
          if (typeof r === 'string') return r
          at = r
        }
        const ids = (input.ids as number[]) ?? []
        const sent = await d.call(to.id, () =>
          (client.forwardMessages as NonNullable<TgUserClient['forwardMessages']>)(
            from.id,
            ids,
            to.id,
            {
              ...(typeof input.to_topic === 'number' && input.to_topic > 0
                ? { topicId: input.to_topic }
                : {}),
              ...(input.silent === true ? { silent: true } : {}),
              ...(input.hide_author === true ? { dropAuthor: true } : {}),
              ...(at === undefined ? {} : { at }),
            },
          ),
        )
        counters.add(connectionId, 'all', d.now(), Math.max(1, sent.length))
        return at === undefined
          ? `Forwarded ${sent.length} message(s) from "${from.title}" to "${to.title}" (new ids ${sent.join(', ')}).`
          : `Scheduled ${sent.length} forwarded message(s) to "${to.title}" for ${when(at)} (scheduled ids ${sent.join(', ')}; cancel_scheduled removes them).`
      },
    },
    {
      name: 'send_poll',
      risk: 'external',
      summary:
        'Post a poll (or a quiz with one right answer) in a chosen chat or topic, now or scheduled. 2 to 12 options.',
      schema: z.object({
        chat: chatField,
        topic: topicField,
        question: z.string().min(1).max(255),
        options: z.array(z.string().min(1).max(100)).min(2).max(12),
        multiple: z.boolean().optional().describe('People may pick several options.'),
        public_voters: z
          .boolean()
          .optional()
          .describe('Voters are visible (not possible in channels).'),
        correct_option: z
          .number()
          .int()
          .min(0)
          .max(11)
          .optional()
          .describe('Quiz: index of the right option (0-based).'),
        at: z
          .string()
          .max(40)
          .optional()
          .describe('Schedule: "YYYY-MM-DD HH:MM" in the team timezone (at least 1 minute ahead).'),
      }),
      run: async (input) => {
        if (client.sendPoll === undefined) return unavailable('send_poll')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const refusal = postRefusal()
        if (refusal !== undefined) return refusal
        const options = ((input.options as string[]) ?? []).map((o) => neutralizeHandles(o))
        const correct = typeof input.correct_option === 'number' ? input.correct_option : undefined
        if (correct !== undefined && correct >= options.length)
          return 'ERROR: correct_option is not one of the options.'
        if (correct !== undefined && input.multiple === true)
          return 'ERROR: a quiz has one right answer: leave out multiple.'
        if (input.public_voters === true && c.kind === 'channel')
          return 'ERROR: polls in channels are always anonymous: leave out public_voters.'
        let at: number | undefined
        if (typeof input.at === 'string') {
          const r = readAt(input.at)
          if (typeof r === 'string') return r
          at = r
        }
        const sent = await d.call(c.id, () =>
          (client.sendPoll as NonNullable<TgUserClient['sendPoll']>)(
            c.id,
            {
              question: neutralizeHandles(String(input.question)),
              options,
              ...(input.multiple === true ? { multiple: true } : {}),
              ...(input.public_voters === true ? { publicVoters: true } : {}),
              ...(correct === undefined ? {} : { correct }),
            },
            {
              ...(typeof input.topic === 'number' && input.topic > 0
                ? { topicId: input.topic }
                : {}),
              ...(at === undefined ? {} : { at }),
            },
          ),
        )
        counters.add(connectionId, 'all', d.now())
        return at === undefined
          ? `Poll posted in "${c.title}" (message ${sent.id}).`
          : `Poll scheduled in "${c.title}" for ${when(at)} (scheduled id ${sent.id}).`
      },
    },
    {
      name: 'schedule_message',
      risk: 'external',
      summary:
        "Schedule a text message in a chosen chat or topic with Telegram's own scheduler: Telegram sends it at the time, even when this server is down. At least 1 minute, at most 365 days ahead. For repeating posts use a routine instead.",
      schema: z.object({
        chat: chatField,
        topic: topicField,
        text: z.string().min(1).max(4096),
        at: z.string().max(40).describe('"YYYY-MM-DD HH:MM" in the team timezone.'),
        silent: z.boolean().optional(),
      }),
      run: async (input) => {
        if (client.scheduleText === undefined) return unavailable('schedule_message')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const refusal = postRefusal()
        if (refusal !== undefined) return refusal
        const at = readAt(String(input.at))
        if (typeof at === 'string') return at
        const sent = await d.call(c.id, () =>
          (client.scheduleText as NonNullable<TgUserClient['scheduleText']>)(
            c.id,
            neutralizeHandles(String(input.text)),
            {
              at,
              ...(typeof input.topic === 'number' && input.topic > 0
                ? { topicId: input.topic }
                : {}),
              ...(input.silent === true ? { silent: true } : {}),
            },
          ),
        )
        counters.add(connectionId, 'all', d.now())
        return `Scheduled in "${c.title}" for ${when(at)} (scheduled id ${sent.id}). Telegram sends it then; list_scheduled shows it, cancel_scheduled removes it. Tell the person the exact time.`
      },
    },
    {
      name: 'list_scheduled',
      risk: 'read',
      summary:
        'Messages this account has scheduled in a chosen chat (Telegram scheduler), with their times.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        if (client.listScheduled === undefined) return unavailable('list_scheduled')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const list = await d.call(c.id, () =>
          (client.listScheduled as NonNullable<TgUserClient['listScheduled']>)(c.id),
        )
        if (list.length === 0) return `Nothing is scheduled in "${c.title}".`
        return [
          `Scheduled in "${c.title}" (${list.length}):`,
          ...list
            .sort((a, b) => a.at - b.at)
            .map(
              (s) =>
                `- ${s.id} ${when(s.at)}${s.topicId === undefined ? '' : ` topic ${s.topicId}`}: ${clip(flat(s.text), 200)}`,
            ),
        ].join('\n')
      },
    },
    {
      name: 'cancel_scheduled',
      risk: 'write',
      summary:
        'Remove messages this account scheduled in a chosen chat (ids from list_scheduled) before Telegram sends them.',
      schema: z.object({
        chat: chatField,
        ids: z.array(z.number().int().positive()).min(1).max(100),
      }),
      run: async (input) => {
        if (client.cancelScheduled === undefined) return unavailable('cancel_scheduled')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const ids = (input.ids as number[]) ?? []
        await d.call(c.id, () =>
          (client.cancelScheduled as NonNullable<TgUserClient['cancelScheduled']>)(c.id, ids),
        )
        return `Removed ${ids.length} scheduled message(s) from "${c.title}".`
      },
    },
    // --- forum topics ----------------------------------------------------------------------------
    {
      name: 'create_forum_topic',
      risk: 'write',
      summary:
        'Create a topic in a chosen forum group (the account must be an admin allowed to manage topics).',
      schema: z.object({ chat: chatField, title: z.string().min(1).max(128) }),
      run: async (input) => {
        if (client.createTopic === undefined) return unavailable('create_forum_topic')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (!c.forum) return `ERROR: "${c.title}" is not a forum.`
        const title = String(input.title).trim()
        const r = await d.call(c.id, () =>
          (client.createTopic as NonNullable<TgUserClient['createTopic']>)(c.id, title),
        )
        d.learnTopics(c, [{ id: r.id, title, closed: false }])
        return `Created topic "${title}" (id ${r.id}) in "${c.title}".`
      },
    },
    {
      name: 'edit_forum_topic',
      risk: 'write',
      summary:
        'Rename a topic, or close / reopen it (closed = only admins can post), in a chosen forum group.',
      schema: z.object({
        chat: chatField,
        topic: z.number().int().positive().describe('The topic id (list_forum_topics).'),
        title: z.string().min(1).max(128).optional(),
        closed: z.boolean().optional().describe('true closes the topic, false reopens it.'),
      }),
      run: async (input) => {
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (!c.forum) return `ERROR: "${c.title}" is not a forum.`
        const topic = Number(input.topic)
        const done: string[] = []
        if (typeof input.title === 'string') {
          if (client.editTopic === undefined) return unavailable('renaming topics')
          const title = input.title.trim()
          await d.call(c.id, () =>
            (client.editTopic as NonNullable<TgUserClient['editTopic']>)(c.id, topic, title),
          )
          d.learnTopics(c, [{ id: topic, title, closed: false }])
          done.push(`renamed to "${title}"`)
        }
        if (typeof input.closed === 'boolean') {
          if (client.setTopicClosed === undefined) return unavailable('closing topics')
          const closed = input.closed
          await d.call(c.id, () =>
            (client.setTopicClosed as NonNullable<TgUserClient['setTopicClosed']>)(
              c.id,
              topic,
              closed,
            ),
          )
          done.push(closed ? 'closed' : 'reopened')
        }
        if (done.length === 0) return 'ERROR: give title, closed, or both.'
        return `Topic ${topic} of "${c.title}": ${done.join(', ')}.`
      },
    },
    // --- moderation (owner only) -----------------------------------------------------------------
    {
      name: 'ban_member',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Remove a person from a chosen group or channel and block them from rejoining (optionally for some days). Owner only; the account must be an admin.',
      schema: z.object({
        chat: chatField,
        user: z
          .string()
          .regex(/^\d+$/)
          .describe('The Telegram user id (never a username: ids cannot be confused).'),
        days: z
          .number()
          .int()
          .min(1)
          .max(366)
          .optional()
          .describe('Ban for this many days; leave out = until unbanned.'),
      }),
      run: async (input) => {
        if (client.banMember === undefined) return unavailable('ban_member')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        if (user === d.selfId) return 'ERROR: the account cannot ban itself.'
        const until = typeof input.days === 'number' ? d.now() + input.days * 86_400_000 : undefined
        await d.call(c.id, () =>
          (client.banMember as NonNullable<TgUserClient['banMember']>)(c.id, user, until),
        )
        return `Banned user ${user} from "${c.title}"${until === undefined ? ' until unbanned' : ` until ${when(until)}`}.`
      },
    },
    {
      name: 'unban_member',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Lift a ban or restriction of a person in a chosen group or channel (they may rejoin; they are not added back). Owner only.',
      schema: z.object({
        chat: chatField,
        user: z.string().regex(/^\d+$/).describe('The Telegram user id.'),
      }),
      run: async (input) => {
        if (client.unbanMember === undefined) return unavailable('unban_member')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        await d.call(c.id, () =>
          (client.unbanMember as NonNullable<TgUserClient['unbanMember']>)(c.id, user),
        )
        return `Lifted the ban and restrictions of user ${user} in "${c.title}".`
      },
    },
    {
      name: 'promote_member',
      risk: 'destructive',
      ownerOnly: true,
      summary: `Make a person an admin of a chosen supergroup or channel, or CHANGE an existing admin's rights (the rights you list replace the old ones; use member_info or list_members type admins to see the current rights first). Rights: ${PROMOTE_RIGHTS.join(', ')} (post_messages and edit_messages are channel rights; manage_topics is for forums; add_admins lets them appoint other admins; anonymous hides their name), plus an optional title. Owner only; always asks for approval; the account must be an admin holding those rights, and add_admins itself to appoint admins. Only the creator or the admin who promoted someone can change them.`,
      schema: z.object({
        chat: chatField,
        user: z
          .string()
          .regex(/^\d+$/)
          .describe('The Telegram user id (never a username: ids cannot be confused).'),
        rights: z
          .array(z.string().max(40))
          .min(1)
          .max(PROMOTE_RIGHTS.length)
          .describe(
            `The rights to give, from: ${PROMOTE_RIGHTS.join(', ')}. List only what is needed.`,
          ),
        title: z
          .string()
          .min(1)
          .max(16)
          .optional()
          .describe('Admin badge, at most 16 characters, no emoji.'),
      }),
      run: async (input) => {
        if (client.promoteMember === undefined) return unavailable('promote_member')
        const asked = [
          ...new Set(((input.rights as string[]) ?? []).map((r) => r.trim().toLowerCase())),
        ]
        const allowed = new Set<string>(PROMOTE_RIGHTS)
        const bad = asked.filter((r) => !allowed.has(r))
        if (bad.length > 0) {
          return `ERROR: ${bad.join(', ')} is not an admin right. The rights are: ${PROMOTE_RIGHTS.join(', ')}.`
        }
        const has = (r: string): boolean => asked.includes(r)
        const rights: TgAdminRights = {
          ...(has('change_info') ? { changeInfo: true } : {}),
          ...(has('delete_messages') ? { deleteMessages: true } : {}),
          ...(has('ban_users') ? { banUsers: true } : {}),
          ...(has('invite_users') ? { inviteUsers: true } : {}),
          ...(has('pin_messages') ? { pinMessages: true } : {}),
          ...(has('manage_topics') ? { manageTopics: true } : {}),
          ...(has('manage_video_chats') ? { manageCall: true } : {}),
          ...(has('add_admins') ? { addAdmins: true } : {}),
          ...(has('anonymous') ? { anonymous: true } : {}),
          ...(has('post_messages') ? { postMessages: true } : {}),
          ...(has('edit_messages') ? { editMessages: true } : {}),
        }
        if (Object.keys(rights).length === 0) return 'ERROR: list at least one right to give.'
        if (typeof input.title === 'string' && /\p{Extended_Pictographic}/u.test(input.title)) {
          return 'ERROR: the admin title may not contain emoji.'
        }
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm') return 'ERROR: that is a direct chat.'
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        if (user === d.selfId) return 'ERROR: the account cannot change its own admin rights.'
        const notes: string[] = []
        if ((has('post_messages') || has('edit_messages')) && c.kind !== 'channel')
          notes.push('post_messages and edit_messages only matter in channels')
        if (has('manage_topics') && !c.forum) notes.push('manage_topics only matters in forums')
        const title = typeof input.title === 'string' ? input.title.trim() : undefined
        await d.call(c.id, () =>
          (client.promoteMember as NonNullable<TgUserClient['promoteMember']>)(
            c.id,
            user,
            rights,
            title === '' ? undefined : title,
          ),
        )
        return `Made user ${user} an admin of "${c.title}" with: ${asked.join(', ')}${title === undefined || title === '' ? '' : ` (title "${title}")`}. These rights replace any they had. Only the creator, or this account (who promoted them), can change or remove them later.${notes.length > 0 ? ` Note: ${notes.join('; ')}.` : ''}`
      },
    },
    {
      name: 'demote_member',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Remove all admin rights of a person in a chosen supergroup or channel (they stay a member). An admin can only demote admins it promoted itself, unless it is the creator. Owner only; always asks for approval.',
      schema: z.object({
        chat: chatField,
        user: z.string().regex(/^\d+$/).describe('The Telegram user id.'),
      }),
      run: async (input) => {
        if (client.demoteMember === undefined) return unavailable('demote_member')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm') return 'ERROR: that is a direct chat.'
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        if (user === d.selfId) return 'ERROR: the account cannot remove its own admin rights.'
        await d.call(c.id, () =>
          (client.demoteMember as NonNullable<TgUserClient['demoteMember']>)(c.id, user),
        )
        return `Removed the admin rights of user ${user} in "${c.title}". (An admin can only demote admins it promoted itself, unless it is the creator: a refusal means someone else promoted them.)`
      },
    },
    {
      name: 'restrict_member',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Restrict what a person may do in a chosen group (true = NOT allowed): send messages, media, polls, stickers, links, invite, pin, change info; optionally for some days. Owner only.',
      schema: z.object({
        chat: chatField,
        user: z.string().regex(/^\d+$/).describe('The Telegram user id.'),
        send_messages: z.boolean().optional(),
        send_media: z.boolean().optional(),
        send_polls: z.boolean().optional(),
        send_stickers: z.boolean().optional(),
        embed_links: z.boolean().optional(),
        invite_users: z.boolean().optional(),
        pin_messages: z.boolean().optional(),
        change_info: z.boolean().optional(),
        days: z
          .number()
          .int()
          .min(1)
          .max(366)
          .optional()
          .describe('For this many days; leave out = until lifted.'),
      }),
      run: async (input) => {
        if (client.restrictMember === undefined) return unavailable('restrict_member')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'channel')
          return 'ERROR: restrictions apply to groups; in a channel only admins post.'
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        if (user === d.selfId) return 'ERROR: the account cannot restrict itself.'
        const r = {
          ...(input.send_messages === true ? { sendMessages: true } : {}),
          ...(input.send_media === true ? { sendMedia: true } : {}),
          ...(input.send_polls === true ? { sendPolls: true } : {}),
          ...(input.send_stickers === true ? { sendOther: true } : {}),
          ...(input.embed_links === true ? { embedLinks: true } : {}),
          ...(input.invite_users === true ? { inviteUsers: true } : {}),
          ...(input.pin_messages === true ? { pinMessages: true } : {}),
          ...(input.change_info === true ? { changeInfo: true } : {}),
        }
        if (Object.keys(r).length === 0)
          return 'ERROR: name at least one thing to restrict (or use unban_member to lift all).'
        const until = typeof input.days === 'number' ? d.now() + input.days * 86_400_000 : undefined
        await d.call(c.id, () =>
          (client.restrictMember as NonNullable<TgUserClient['restrictMember']>)(
            c.id,
            user,
            r,
            until,
          ),
        )
        return `Restricted user ${user} in "${c.title}" (${Object.keys(r).join(', ')})${until === undefined ? ' until lifted' : ` until ${when(until)}`}.`
      },
    },
    {
      name: 'delete_member_messages',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Delete EVERY message a person wrote in a chosen supergroup (spam clean-up; cannot be undone). Owner only; the account must be an admin.',
      schema: z.object({
        chat: chatField,
        user: z.string().regex(/^\d+$/).describe('The Telegram user id.'),
      }),
      run: async (input) => {
        if (client.deleteMemberMessages === undefined) return unavailable('delete_member_messages')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const user = String(input.user)
        if (user === d.selfId)
          return "ERROR: use channel_manage to delete this account's own messages."
        await d.call(c.id, () =>
          (client.deleteMemberMessages as NonNullable<TgUserClient['deleteMemberMessages']>)(
            c.id,
            user,
          ),
        )
        return `Deleted all messages of user ${user} in "${c.title}".`
      },
    },
    {
      name: 'create_invite_link',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Create an invite link to a chosen group or channel (with an expiry, a usage limit, or admin approval of joins). Owner only: whoever gets the link can join.',
      schema: z.object({
        chat: chatField,
        expires_days: z.number().int().min(1).max(365).optional(),
        usage_limit: z.number().int().min(1).max(99_999).optional(),
        with_approval: z.boolean().optional().describe('Joins wait for an admin to approve them.'),
        title: z.string().max(32).optional().describe('A note only admins see.'),
      }),
      run: async (input) => {
        if (client.createInviteLink === undefined) return unavailable('create_invite_link')
        const c = await chosenChat(String(input.chat))
        if (typeof c === 'string') return c
        const notAdmin = ownerAdmin(c)
        if (notAdmin !== undefined) return notAdmin
        const l = await d.call(c.id, () =>
          (client.createInviteLink as NonNullable<TgUserClient['createInviteLink']>)(c.id, {
            ...(typeof input.expires_days === 'number'
              ? { expiresAt: d.now() + input.expires_days * 86_400_000 }
              : {}),
            ...(typeof input.usage_limit === 'number' ? { usageLimit: input.usage_limit } : {}),
            ...(input.with_approval === true ? { withApproval: true } : {}),
            ...(typeof input.title === 'string' && input.title.trim() !== ''
              ? { title: input.title.trim() }
              : {}),
          }),
        )
        return `Invite link for "${c.title}": ${l.link}. Share it only with the person who asked, never in a group chat.`
      },
    },
    // --- membership (owner only) -----------------------------------------------------------------
    {
      name: 'join_chat',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Join a group or channel with this account by invite link (t.me/+...), t.me link or @username. Owner only, at most 3 joins a day (mass joining gets accounts banned). The chat is NOT chosen for ingest by this: use choose_chat after.',
      schema: z.object({
        link: z.string().min(2).max(200).describe('Invite link, t.me link or @username.'),
      }),
      run: async (input) => {
        if (client.joinChat === undefined) return unavailable('join_chat')
        if (counters.get(connectionId, 'join', d.now()) >= JOINS_PER_DAY) {
          return `ERROR: this account joined ${JOINS_PER_DAY} chats today already: the daily cap protects it from a spam ban. Try again tomorrow.`
        }
        const link = String(input.link).trim()
        counters.add(connectionId, 'join', d.now())
        const r = await d.call(undefined, () =>
          (client.joinChat as NonNullable<TgUserClient['joinChat']>)(link),
        )
        d.hooks.chatsChanged?.()
        if (r.status === 'requested')
          return 'Asked to join: the chat approves joins, an admin there has to accept the request.'
        return `Joined "${r.chat.title}" (${r.chat.id}, ${r.chat.kind}). It is not chosen for ingest yet: use choose_chat with backfill_days when the person wants it read.`
      },
    },
    {
      name: 'leave_chat',
      risk: 'destructive',
      ownerOnly: true,
      summary: 'Leave a group or channel with this account (it stops being ingested). Owner only.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        if (client.leaveChat === undefined) return unavailable('leave_chat')
        const c = await findChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm')
          return 'ERROR: that is a direct chat with a person, not a group or channel.'
        await d.call(c.id, () => (client.leaveChat as NonNullable<TgUserClient['leaveChat']>)(c.id))
        if (chats.isSelected(connectionId, c.id))
          chats.setSelected(connectionId, c.id, false, d.now())
        d.hooks.chatsChanged?.()
        return `Left "${c.title}" (${c.id}); it is no longer ingested.`
      },
    },
  ]
  // managing chats: create, add people, settings, invite links, join requests, contacts, ...
  return [
    ...base,
    ...manageActions(d, { findChat, chosenChat, ownerAdmin, when, postRefusal, spendResolve }),
  ]
}

/** Local midnight of a day in a zone (epoch ms). */
function readAtDay(day: string, zone: string): number {
  const [y, m, dd] = day.split('-').map(Number) as [number, number, number]
  const naive = Date.UTC(y, m - 1, dd, 0, 0)
  let guess = naive
  for (let i = 0; i < 3; i++) {
    const p = localTime(guess, zone)
    const delta = naive - Date.parse(`${p.date}T${p.clock}:00Z`)
    if (delta === 0) break
    guess += delta
  }
  return guess
}
