/**
 * Managing chats with a Telegram user account: what an owner can do in the Telegram app beyond
 * reading and posting. Same rules as `actions.ts` (and merged into its list):
 *
 *  - owners and admins of the team may ask for these (the permission engine decides by risk; a
 *    member or a guest never gets a native tool); `ownerOnly` ones are refused in code unless an owner
 *    asks (the web owner counts as the owner); every non-read action still asks for approval where
 *    the app's mode requires it;
 *  - destructive ones (delete a chat, clear history for everyone, delete a topic, kick, hand over
 *    ownership) are owner only and need `confirm: true` where they cannot be undone;
 *  - settings and member changes work on a group or channel the account ADMINISTERS (not on direct
 *    chats); message level tools only on chats chosen for ingest, like the reads and posts;
 *  - people are added only where Telegram allows it; a privacy refusal falls back to an invite link,
 *    sent by direct message ONLY when the account already has a conversation with that person
 *    (never a cold message), otherwise handed back to be shared by somebody who can reach them;
 *  - the 2FA password never touches this app: ownership transfer is explained, not performed.
 *
 * Failures are answered as readable text (never thrown); a refusal calls `reportRefusal`, so the
 * activity log records it as refused.
 */
import { z } from 'zod'
import { reportRefusal } from '../channels/governor.ts'
import { neutralizeHandles } from '../channels/mentions.ts'
import type { NativeAction } from '../channels/types.ts'
import type { AccountActionDeps } from './actions.ts'
import type { TgChat, TgInviteLink, TgMember, TgUserClient } from './client.ts'
import { classifyError, describeError } from './errors.ts'

export interface ManageHelpers {
  findChat(ref: string): Promise<TgChat | string>
  chosenChat(ref: string): Promise<TgChat | string>
  ownerAdmin(c: TgChat): string | undefined
  when(at: number): string
  postRefusal(): string | undefined
  /** Spend one username lookup (Telegram limits them hard): a sentence when none is left. */
  spendResolve(): string | undefined
}

/** People added to a chat in one call, and in one day, and the pause between two adds. */
export const ADD_MEMBERS_PER_CALL = 20
export const ADDS_PER_DAY = 60
export const CREATES_PER_DAY = 5
const ADD_GAP_MS = 2_500
const DAY_MS = 86_400_000
const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const MAX_ALBUM = 10
const MAX_ALBUM_BYTES = 25 * 1024 * 1024

/** Rights `promote_member` may hand out; the full set of Telegram (ADR: owner decides, approval asks). */
export const ADMIN_RIGHTS = [
  'change_info',
  'post_messages',
  'edit_messages',
  'delete_messages',
  'ban_users',
  'invite_users',
  'pin_messages',
  'manage_topics',
  'manage_video_chats',
  'add_admins',
  'anonymous',
] as const

const PRIVACY_CODES = ['USER_PRIVACY_RESTRICTED', 'USER_NOT_MUTUAL_CONTACT']
const STOP_KINDS = new Set(['flood', 'peer-flood', 'auth-lost', 'duplicated'])
const TTL_SECONDS: Record<string, number> = { off: 0, '1d': 86_400, '1w': 604_800, '1m': 2_678_400 }
const SLOW_MODES = [0, 10, 30, 60, 300, 900, 3600] as const

const chatField = z
  .string()
  .min(1)
  .describe('The chat id as list_dialogs shows it (e.g. -1001234567890), or its exact title.')
const userIdField = z
  .string()
  .regex(/^\d+$/)
  .describe('The Telegram user id (never a username: ids cannot be confused).')
const personField = z
  .string()
  .min(1)
  .max(64)
  .describe('A Telegram user id (preferred) or @username.')
const linkField = z
  .string()
  .min(8)
  .max(200)
  .describe('The invite link, as list_invite_links shows it.')
const confirmField = z
  .boolean()
  .optional()
  .describe('Must be true: the call is refused without it. Ask the person to confirm first.')

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const unavailable = (what: string): string => `ERROR: ${what} is not available for this account.`

/** A refusal of the request itself (not an error of Telegram): audited as refused. */
function deny(text: string): string {
  reportRefusal(text)
  return text
}

const nameOf = (u: { id: string; name: string; username?: string }): string =>
  `${u.name} (id ${u.id}${u.username === undefined ? '' : `, @${u.username}`})`

const PUBLIC_NAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/

export function manageActions(d: AccountActionDeps, h: ManageHelpers): NativeAction[] {
  const { connectionId, client, chats, counters } = d
  const sleep = d.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))

  /** A group or channel the account administers (never a direct chat), or a sentence saying why not. */
  async function managed(ref: string): Promise<TgChat | string> {
    const c = await h.findChat(ref)
    if (typeof c === 'string') return c
    if (c.kind === 'dm') {
      return deny(
        'ERROR: that is a direct chat with a person. This changes groups and channels only.',
      )
    }
    const notAdmin = h.ownerAdmin(c)
    if (notAdmin !== undefined) return deny(notAdmin)
    return c
  }

  /** A chosen chat (message level tools), refusals audited. */
  async function chosen(ref: string): Promise<TgChat | string> {
    const c = await h.chosenChat(ref)
    if (typeof c === 'string' && /not chosen|direct chat/.test(c)) return deny(c)
    return c
  }

  type Attempt<T> =
    | { ok: true; value: T }
    | { ok: false; code: string; sentence: string; stop: boolean }

  /**
   * One Telegram call whose failure stays readable and per item: the code, a sentence, and whether the
   * whole batch must stop (a flood wait, a flagged or logged out account).
   */
  async function attempt<T>(chatId: string | undefined, fn: () => Promise<T>): Promise<Attempt<T>> {
    let raw: unknown
    try {
      const value = await d.call(chatId, async () => {
        try {
          return await fn()
        } catch (error) {
          raw = error
          throw error
        }
      })
      return { ok: true, value }
    } catch (error) {
      if (raw === undefined) {
        // refused before the call: parked, paused, limited
        return {
          ok: false,
          code: 'HELD',
          sentence: error instanceof Error ? error.message : String(error),
          stop: true,
        }
      }
      const k = classifyError(raw)
      return {
        ok: false,
        code: k.text.split(/\W/)[0] ?? k.text,
        sentence: describeError(k),
        stop: STOP_KINDS.has(k.kind),
      }
    }
  }

  /** Run one call and answer its error as text (single call tools). */
  async function once<T>(
    chatId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
    const r = await attempt(chatId, fn)
    return r.ok ? r : { ok: false, text: `ERROR: ${r.sentence}` }
  }

  const days = (n: number): number => d.now() + n * DAY_MS

  const linkLine = (l: TgInviteLink): string =>
    [
      `- ${l.link}`,
      l.title === undefined ? '' : ` "${l.title}"`,
      l.primary ? ' (primary)' : '',
      l.revoked ? ' (REVOKED)' : '',
      ` joined ${l.usage}${l.usageLimit === undefined ? '' : `/${l.usageLimit}`}`,
      l.expiresAt === undefined ? ', no expiry' : `, expires ${h.when(l.expiresAt)}`,
      l.withApproval ? `, needs approval (${l.pendingRequests} waiting)` : '',
    ].join('')

  // --- adding people ---------------------------------------------------------------------------

  const hasConversation = async (id: string): Promise<boolean> => {
    if (!/^\d+$/.test(id)) return false
    if ((await d.dialogs()).some((c) => c.kind === 'dm' && c.id === id)) return true
    return (await d.dialogs(true)).some((c) => c.kind === 'dm' && c.id === id)
  }

  async function inviteLinkOf(chat: TgChat): Promise<{ link: string } | { error: string }> {
    const primary = client.primaryInviteLink
    const create = client.createInviteLink
    if (primary === undefined && create === undefined)
      return { error: 'invite links are not available' }
    const r = await attempt(chat.id, () =>
      primary !== undefined
        ? primary.call(client, chat.id)
        : (create as NonNullable<typeof create>).call(client, chat.id, {}),
    )
    return r.ok ? r.value : { error: r.sentence }
  }

  /** Add each person to a chat; privacy refusals fall back to a link (DM only inside an existing conversation). */
  async function addPeople(
    chat: TgChat,
    refs: string[],
    sendLinkTo: 'dm' | 'none',
  ): Promise<{ lines: string[]; added: number }> {
    const lines: string[] = []
    let added = 0
    const privacy: Array<{ label: string; id: string }> = []
    const addMember = client.addMember
    if (addMember === undefined) return { lines: [unavailable('add_members')], added: 0 }
    const left = Math.max(0, ADDS_PER_DAY - counters.get(connectionId, 'invite', d.now()))
    let stopped: string | undefined
    for (const [i, ref] of refs.entries()) {
      if (stopped !== undefined) {
        lines.push(`- ${ref}: not attempted (${stopped})`)
        continue
      }
      if (i >= left) {
        lines.push(
          `- ${ref}: not attempted (the daily cap of ${ADDS_PER_DAY} added people is reached: adding in bulk gets accounts banned; try tomorrow)`,
        )
        continue
      }
      let id = ref.trim().replace(/^@/, '')
      let label = ref
      if (!/^\d+$/.test(id)) {
        const refusal = h.spendResolve()
        if (refusal !== undefined) {
          lines.push(`- ${ref}: skipped (${refusal.replace(/^ERROR: /, '')})`)
          continue
        }
        if (client.getUserInfo !== undefined) {
          const u = await attempt(undefined, () =>
            (client.getUserInfo as NonNullable<TgUserClient['getUserInfo']>)(id),
          )
          if (!u.ok) {
            lines.push(`- ${ref}: ${u.sentence}`)
            if (u.stop) stopped = u.sentence
            continue
          }
          id = u.value.id
          label = nameOf(u.value)
        }
      }
      if (i > 0) await sleep(ADD_GAP_MS)
      const r = await attempt(chat.id, () => addMember.call(client, chat.id, id))
      counters.add(connectionId, 'invite', d.now())
      if (r.ok && r.value.added) {
        added++
        lines.push(`- ${label}: added`)
      } else if (r.ok || PRIVACY_CODES.includes(r.code)) {
        privacy.push({ label, id })
        lines.push(
          `- ${label}: NOT added: their privacy settings (or no mutual contact) keep this account from adding them`,
        )
      } else if (r.code === 'USER_ALREADY_PARTICIPANT') {
        lines.push(`- ${label}: already in the chat`)
      } else {
        lines.push(`- ${label}: NOT added: ${r.sentence}`)
        if (r.stop) stopped = r.sentence
      }
    }
    if (privacy.length > 0) {
      const l = await inviteLinkOf(chat)
      if ('error' in l) {
        lines.push(`No invite link could be made for the people above: ${l.error}`)
      } else {
        let sent = 0
        const share: string[] = []
        for (const p of privacy) {
          const refusal = h.postRefusal()
          const dmCap = d.settings().dmDailyMax
          if (
            sendLinkTo === 'dm' &&
            refusal === undefined &&
            counters.get(connectionId, 'dm', d.now()) < dmCap &&
            (await hasConversation(p.id))
          ) {
            const r = await attempt(p.id, () =>
              client.sendText(
                p.id,
                `You are invited to join "${chat.title}" on Telegram: ${l.link}`,
                { key: `invite:${chat.id}:${p.id}:${d.now()}` },
              ),
            )
            if (r.ok) {
              counters.add(connectionId, 'dm', d.now())
              counters.add(connectionId, 'all', d.now())
              sent++
              lines.push(`- ${p.label}: invite link sent by direct message (a conversation exists)`)
              continue
            }
            lines.push(`- ${p.label}: the link could not be sent by direct message: ${r.sentence}`)
          }
          share.push(p.label)
        }
        if (share.length > 0) {
          lines.push(
            `Invite link for ${share.join(', ')}: ${l.link}. This account has no conversation with ${share.length === 1 ? 'them' : 'them'} (or was not asked to message them) and never starts one, so it must be shared by somebody who can message them.`,
          )
        }
        if (sent > 0) lines.push(`${sent} invite(s) delivered by direct message.`)
      }
    }
    return { lines, added }
  }

  const peopleField = z
    .array(personField)
    .min(1)
    .max(ADD_MEMBERS_PER_CALL)
    .describe(`Up to ${ADD_MEMBERS_PER_CALL} people: Telegram user ids (preferred) or @usernames.`)

  const cleanTitle = (t: unknown): string => String(t).trim()

  /** After a chat was made: choose it (wake on mention) so the app reads and answers in it. */
  async function adopt(chat: TgChat): Promise<void> {
    try {
      await d.hooks.chatCreated?.(chat)
    } catch {
      // the chat exists on Telegram either way; list_dialogs + choose_chat can pick it up
    }
    d.hooks.chatsChanged?.()
  }

  function createRefusal(): string | undefined {
    const n = counters.get(connectionId, 'create', d.now())
    return n >= CREATES_PER_DAY
      ? deny(
          `ERROR: this account created ${CREATES_PER_DAY} chats today already: Telegram flags accounts that create chats in bulk. Try tomorrow.`,
        )
      : undefined
  }

  const actions: NativeAction[] = [
    // --- create ----------------------------------------------------------------------------------
    {
      name: 'create_group',
      risk: 'external',
      summary:
        'Create a new supergroup owned by this account, optionally a forum (topics) and with first members, and choose it so the agent can read and answer in it (it wakes on mention). Returns the chat id and an invite link. People whose privacy blocks adding get the link (by DM only when a conversation exists, never a cold message). Owner or admin.',
      schema: z.object({
        title: z.string().min(1).max(128),
        description: z.string().max(255).optional(),
        members: peopleField.optional(),
        forum: z.boolean().optional().describe('Create it as a forum with topics.'),
        send_link_to: z
          .enum(['dm', 'none'])
          .optional()
          .describe(
            'Privacy-restricted people: dm = send the link by DM where a conversation exists. Default none.',
          ),
      }),
      run: async (input) => {
        if (client.createSupergroup === undefined) return unavailable('create_group')
        const refusal = createRefusal()
        if (refusal !== undefined) return refusal
        counters.add(connectionId, 'create', d.now())
        const title = cleanTitle(input.title)
        const r = await once(undefined, () =>
          (client.createSupergroup as NonNullable<TgUserClient['createSupergroup']>)({
            title,
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
            ...(input.forum === true ? { forum: true } : {}),
          }),
        )
        if (!r.ok) return r.text
        const chat = r.value
        await adopt(chat)
        const out = [
          `Created ${input.forum === true ? 'forum ' : ''}group "${chat.title}" (${chat.id}). It is chosen: the agent reads it and answers when mentioned.`,
        ]
        const refs = Array.isArray(input.members) ? (input.members as string[]) : []
        let link: string | undefined
        if (refs.length > 0) {
          const res = await addPeople(
            chat,
            [...new Set(refs)],
            input.send_link_to === 'dm' ? 'dm' : 'none',
          )
          out.push(`Members (${res.added} added of ${refs.length}):`, ...res.lines)
        }
        const l = await inviteLinkOf(chat)
        if ('link' in l) link = l.link
        out.push(
          link === undefined
            ? 'No invite link could be made yet: use create_invite_link.'
            : `Invite link: ${link}`,
        )
        return out.join('\n')
      },
    },
    {
      name: 'create_channel',
      risk: 'external',
      summary:
        'Create a new broadcast channel owned by this account (optionally with a public username) and choose it. Returns the chat id and its link. Owner or admin.',
      schema: z.object({
        title: z.string().min(1).max(128),
        description: z.string().max(255).optional(),
        username: z
          .string()
          .max(40)
          .optional()
          .describe('Make it public at t.me/<username> (5 to 32 letters, digits, underscore).'),
      }),
      run: async (input) => {
        if (client.createChannel === undefined) return unavailable('create_channel')
        let username: string | undefined
        if (typeof input.username === 'string' && input.username.trim() !== '') {
          username = input.username
            .trim()
            .replace(/^@/, '')
            .replace(/^(?:https?:\/\/)?t\.me\//i, '')
          if (!PUBLIC_NAME.test(username)) {
            return deny(
              `ERROR: "${input.username}" is not a valid public username: 5 to 32 letters, digits or underscores, starting with a letter.`,
            )
          }
        }
        const refusal = createRefusal()
        if (refusal !== undefined) return refusal
        counters.add(connectionId, 'create', d.now())
        const title = cleanTitle(input.title)
        const r = await once(undefined, () =>
          (client.createChannel as NonNullable<TgUserClient['createChannel']>)({
            title,
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
          }),
        )
        if (!r.ok) return r.text
        const chat = r.value
        await adopt(chat)
        const out = [
          `Created channel "${chat.title}" (${chat.id}). It is chosen; posts go through channel_send.`,
        ]
        if (username !== undefined && client.setChatUsername !== undefined) {
          const u = await once(chat.id, () =>
            (client.setChatUsername as NonNullable<TgUserClient['setChatUsername']>)(
              chat.id,
              username,
            ),
          )
          out.push(
            u.ok
              ? `Public link: https://t.me/${username}`
              : `${u.text} The channel stays private for now; set_chat_visibility retries.`,
          )
          if (u.ok) return out.join('\n')
        }
        const l = await inviteLinkOf(chat)
        out.push(
          'link' in l
            ? `Invite link: ${l.link}`
            : 'No invite link could be made yet: use create_invite_link.',
        )
        return out.join('\n')
      },
    },
    {
      name: 'add_members',
      risk: 'external',
      summary: `Add people to a group or channel the account administers (at most ${ADD_MEMBERS_PER_CALL} per call, ${ADDS_PER_DAY} a day, spaced out: bulk adding gets accounts banned). Each person gets their own result. If their privacy blocks it, the answer includes an invite link; send_link_to dm sends it by DM ONLY where this account already has a conversation with the person. It never messages anybody cold: otherwise somebody who can reach them must share the link. Owner or admin.`,
      schema: z.object({
        chat: chatField,
        users: peopleField,
        send_link_to: z
          .enum(['dm', 'none'])
          .optional()
          .describe('Default none (only return the link).'),
      }),
      run: async (input) => {
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const refs = [...new Set(((input.users as string[]) ?? []).map((u) => u.trim()))]
        const res = await addPeople(c, refs, input.send_link_to === 'dm' ? 'dm' : 'none')
        d.hooks.chatsChanged?.()
        return [
          `Adding to "${c.title}" (${res.added} added of ${refs.length}):`,
          ...res.lines,
        ].join('\n')
      },
    },
    // --- chat info and visibility ----------------------------------------------------------------
    {
      name: 'set_chat_info',
      risk: 'external',
      summary:
        'Change the title, description and photo (a library image path) of a group or channel the account administers; for a channel also post signatures on/off. Each field optional. Owner or admin.',
      schema: z.object({
        chat: chatField,
        title: z.string().min(1).max(128).optional(),
        description: z.string().max(255).optional().describe('Empty text clears it.'),
        photo: z
          .string()
          .max(300)
          .optional()
          .describe('A library image path (jpeg, png or webp, up to 10 MB).'),
        post_signatures: z
          .boolean()
          .optional()
          .describe('Channels: sign posts with the admin name.'),
      }),
      run: async (input) => {
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const done: string[] = []
        const fail = (text: string): string =>
          `${done.length > 0 ? `Done so far: ${done.join(', ')}. ` : ''}${text}`
        if (typeof input.title === 'string') {
          if (client.setChatTitle === undefined) return unavailable('changing titles')
          const title = input.title.trim()
          const r = await once(c.id, () =>
            (client.setChatTitle as NonNullable<TgUserClient['setChatTitle']>)(c.id, title),
          )
          if (!r.ok) return fail(r.text)
          done.push(`title "${title}"`)
        }
        if (typeof input.description === 'string') {
          if (client.setChatDescription === undefined) return unavailable('changing descriptions')
          const about = input.description
          const r = await once(c.id, () =>
            (client.setChatDescription as NonNullable<TgUserClient['setChatDescription']>)(
              c.id,
              about,
            ),
          )
          if (!r.ok) return fail(r.text)
          done.push(about === '' ? 'description cleared' : 'description')
        }
        if (typeof input.photo === 'string') {
          if (client.setChatPhoto === undefined || d.readFile === undefined)
            return unavailable('changing photos')
          const file = await d.readFile(input.photo)
          if (file === undefined) return fail(`ERROR: no such file: ${input.photo}`)
          if (!file.mediaType.startsWith('image/'))
            return fail(deny(`ERROR: ${input.photo} is not an image (${file.mediaType}).`))
          if (file.bytes.byteLength > MAX_PHOTO_BYTES)
            return fail(deny('ERROR: the image is larger than 10 MB.'))
          const name = input.photo.split('/').pop() ?? 'photo'
          const r = await once(c.id, () =>
            (client.setChatPhoto as NonNullable<TgUserClient['setChatPhoto']>)(c.id, {
              name,
              mediaType: file.mediaType,
              bytes: file.bytes,
            }),
          )
          if (!r.ok) return fail(r.text)
          done.push('photo')
        }
        if (typeof input.post_signatures === 'boolean') {
          if (c.kind !== 'channel')
            return fail(deny('ERROR: post signatures exist in channels only.'))
          if (client.setChannelSignatures === undefined) return unavailable('post signatures')
          const on = input.post_signatures
          const r = await once(c.id, () =>
            (client.setChannelSignatures as NonNullable<TgUserClient['setChannelSignatures']>)(
              c.id,
              on,
            ),
          )
          if (!r.ok) return fail(r.text)
          done.push(`signatures ${on ? 'on' : 'off'}`)
        }
        if (done.length === 0)
          return 'ERROR: give at least one of title, description, photo, post_signatures.'
        d.hooks.chatsChanged?.()
        return `Updated "${c.title}": ${done.join(', ')}.`
      },
    },
    {
      name: 'set_chat_visibility',
      risk: 'external',
      summary:
        'Make a supergroup or channel public (a username: t.me/<name>, anybody can find and join) or private (removes the username; the old link stops working), and turn "approval needed to join" on or off. Owner or admin; tell the person what going public means first.',
      schema: z.object({
        chat: chatField,
        visibility: z.enum(['public', 'private']).optional(),
        username: z
          .string()
          .max(60)
          .optional()
          .describe(
            'For public: the username or t.me link (5 to 32 letters, digits, underscore; starts with a letter).',
          ),
        join_requests: z
          .boolean()
          .optional()
          .describe(
            'true = joining needs an admin to approve (the account can then list and answer requests).',
          ),
      }),
      run: async (input) => {
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        if (input.visibility === undefined && typeof input.join_requests !== 'boolean')
          return 'ERROR: give visibility, join_requests, or both.'
        const done: string[] = []
        if (input.visibility === 'public') {
          if (typeof input.username !== 'string')
            return deny('ERROR: public needs a username (the t.me/<name> part).')
          const name = input.username
            .trim()
            .replace(/^@/, '')
            .replace(/^(?:https?:\/\/)?t\.me\//i, '')
          if (!PUBLIC_NAME.test(name)) {
            return deny(
              `ERROR: "${input.username}" is not a valid username: 5 to 32 letters, digits or underscores, starting with a letter.`,
            )
          }
          if (client.setChatUsername === undefined) return unavailable('changing visibility')
          const r = await once(c.id, () =>
            (client.setChatUsername as NonNullable<TgUserClient['setChatUsername']>)(c.id, name),
          )
          if (!r.ok) return r.text
          done.push(`public at https://t.me/${name}`)
        } else if (input.visibility === 'private') {
          if (client.setChatUsername === undefined) return unavailable('changing visibility')
          const r = await once(c.id, () =>
            (client.setChatUsername as NonNullable<TgUserClient['setChatUsername']>)(c.id, null),
          )
          if (!r.ok) return r.text
          done.push(
            `private (the public username${c.username === undefined ? '' : ` @${c.username}`} was removed: its link no longer works; create_invite_link makes a private one)`,
          )
        }
        if (typeof input.join_requests === 'boolean') {
          if (client.setJoinRequests === undefined) return unavailable('join requests')
          const on = input.join_requests
          const r = await once(c.id, () =>
            (client.setJoinRequests as NonNullable<TgUserClient['setJoinRequests']>)(c.id, on),
          )
          if (!r.ok) return `${done.length > 0 ? `Done so far: ${done.join('; ')}. ` : ''}${r.text}`
          done.push(on ? 'joining needs approval' : 'joining needs no approval')
        }
        d.hooks.chatsChanged?.()
        return `"${c.title}": ${done.join('; ')}.`
      },
    },
    {
      name: 'set_default_permissions',
      risk: 'external',
      summary:
        'What ordinary members of a group may do (true allows, false forbids; leave out = unchanged): send messages, media, stickers and gifs, polls, links, invite users, pin, change info, manage topics. Also slow_mode_seconds (0 off, 10, 30, 60, 300, 900, 3600) and forum on/off (owner of the group only). Groups only. Owner or admin.',
      schema: z.object({
        chat: chatField,
        send_messages: z.boolean().optional(),
        send_media: z.boolean().optional(),
        send_stickers_gifs: z.boolean().optional(),
        send_polls: z.boolean().optional(),
        embed_links: z.boolean().optional(),
        invite_users: z.boolean().optional(),
        pin_messages: z.boolean().optional(),
        change_info: z.boolean().optional(),
        manage_topics: z.boolean().optional(),
        slow_mode_seconds: z.number().int().min(0).max(3600).optional(),
        forum: z
          .boolean()
          .optional()
          .describe('true makes the group a forum with topics, false turns topics off.'),
      }),
      run: async (input) => {
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'channel')
          return deny(
            'ERROR: channels have no member permissions: only admins post. Use promote_member for admins.',
          )
        const change = {
          ...(typeof input.send_messages === 'boolean'
            ? { sendMessages: input.send_messages }
            : {}),
          ...(typeof input.send_media === 'boolean' ? { sendMedia: input.send_media } : {}),
          ...(typeof input.send_stickers_gifs === 'boolean'
            ? { sendStickers: input.send_stickers_gifs }
            : {}),
          ...(typeof input.send_polls === 'boolean' ? { sendPolls: input.send_polls } : {}),
          ...(typeof input.embed_links === 'boolean' ? { embedLinks: input.embed_links } : {}),
          ...(typeof input.invite_users === 'boolean' ? { inviteUsers: input.invite_users } : {}),
          ...(typeof input.pin_messages === 'boolean' ? { pinMessages: input.pin_messages } : {}),
          ...(typeof input.change_info === 'boolean' ? { changeInfo: input.change_info } : {}),
          ...(typeof input.manage_topics === 'boolean'
            ? { manageTopics: input.manage_topics }
            : {}),
        }
        const done: string[] = []
        if (Object.keys(change).length > 0) {
          if (client.setDefaultPermissions === undefined) return unavailable('member permissions')
          const r = await once(c.id, () =>
            (client.setDefaultPermissions as NonNullable<TgUserClient['setDefaultPermissions']>)(
              c.id,
              change,
            ),
          )
          if (!r.ok) return r.text
          done.push(
            `members may now (changed): ${Object.entries(change)
              .map(
                ([k, v]) =>
                  `${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}=${v ? 'yes' : 'no'}`,
              )
              .join(', ')}`,
          )
        }
        if (typeof input.slow_mode_seconds === 'number') {
          const s = input.slow_mode_seconds
          if (!(SLOW_MODES as readonly number[]).includes(s))
            return deny(`ERROR: slow mode is one of ${SLOW_MODES.join(', ')} seconds.`)
          if (client.setSlowMode === undefined) return unavailable('slow mode')
          const r = await once(c.id, () =>
            (client.setSlowMode as NonNullable<TgUserClient['setSlowMode']>)(c.id, s),
          )
          if (!r.ok) return `${done.length > 0 ? `Done so far: ${done.join('; ')}. ` : ''}${r.text}`
          done.push(s === 0 ? 'slow mode off' : `slow mode ${s} s`)
        }
        if (typeof input.forum === 'boolean') {
          if (client.setForum === undefined) return unavailable('forum mode')
          const on = input.forum
          const r = await once(c.id, () =>
            (client.setForum as NonNullable<TgUserClient['setForum']>)(c.id, on),
          )
          if (!r.ok) return `${done.length > 0 ? `Done so far: ${done.join('; ')}. ` : ''}${r.text}`
          done.push(on ? 'topics (forum) on' : 'topics (forum) off')
        }
        if (done.length === 0)
          return 'ERROR: name at least one permission, slow_mode_seconds or forum.'
        d.hooks.chatsChanged?.()
        return `"${c.title}": ${done.join('; ')}.`
      },
    },
    {
      name: 'manage_chat_settings',
      risk: 'external',
      summary:
        'One chat setting by action: auto_delete (period off|1d|1w|1m), protected_content (no saving or forwarding), hide_members (supergroups), history_visible (new members see old messages; supergroups), reactions (mode all|none|some with emojis), signatures (channels), link_discussion (channel + group: comments), unlink_discussion, default_send_as (a channel to post as). Owner or admin.',
      schema: z.object({
        chat: chatField,
        action: z.enum([
          'auto_delete',
          'protected_content',
          'hide_members',
          'history_visible',
          'reactions',
          'signatures',
          'link_discussion',
          'unlink_discussion',
          'default_send_as',
        ]),
        enabled: z
          .boolean()
          .optional()
          .describe('For protected_content, hide_members, history_visible, signatures.'),
        period: z.enum(['off', '1d', '1w', '1m']).optional().describe('For auto_delete.'),
        mode: z.enum(['all', 'none', 'some']).optional().describe('For reactions.'),
        emojis: z
          .array(z.string().min(1).max(16))
          .max(100)
          .optional()
          .describe('For reactions mode some.'),
        group: chatField
          .optional()
          .describe('For link_discussion: the supergroup that holds the comments.'),
        send_as: chatField
          .optional()
          .describe('For default_send_as: a channel this account administers.'),
      }),
      run: async (input) => {
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const action = String(input.action)
        const need = (name: string, fn: unknown): string | undefined =>
          fn === undefined ? unavailable(name) : undefined
        const flag = typeof input.enabled === 'boolean' ? input.enabled : undefined
        switch (action) {
          case 'auto_delete': {
            const un = need('auto-delete', client.setChatTtl)
            if (un !== undefined) return un
            const p = typeof input.period === 'string' ? input.period : undefined
            if (p === undefined) return deny('ERROR: auto_delete needs period: off, 1d, 1w or 1m.')
            const secs = TTL_SECONDS[p] as number
            const r = await once(c.id, () =>
              (client.setChatTtl as NonNullable<TgUserClient['setChatTtl']>)(c.id, secs),
            )
            if (!r.ok) return r.text
            return p === 'off'
              ? `Auto-delete is off in "${c.title}".`
              : `New messages in "${c.title}" disappear after ${p === '1d' ? 'a day' : p === '1w' ? 'a week' : 'a month'}.`
          }
          case 'protected_content': {
            const un = need('content protection', client.setContentProtection)
            if (un !== undefined) return un
            if (flag === undefined)
              return deny('ERROR: protected_content needs enabled true or false.')
            const r = await once(c.id, () =>
              (client.setContentProtection as NonNullable<TgUserClient['setContentProtection']>)(
                c.id,
                flag,
              ),
            )
            return r.ok
              ? `Saving and forwarding messages from "${c.title}" is ${flag ? 'blocked' : 'allowed'} now.`
              : r.text
          }
          case 'hide_members': {
            const un = need('hiding members', client.setMembersHidden)
            if (un !== undefined) return un
            if (c.kind !== 'group')
              return deny('ERROR: only supergroups can hide their member list.')
            if (flag === undefined) return deny('ERROR: hide_members needs enabled true or false.')
            const r = await once(c.id, () =>
              (client.setMembersHidden as NonNullable<TgUserClient['setMembersHidden']>)(
                c.id,
                flag,
              ),
            )
            return r.ok
              ? `The member list of "${c.title}" is ${flag ? 'hidden from members' : 'visible'}.`
              : r.text
          }
          case 'history_visible': {
            const un = need('history visibility', client.setHistoryVisible)
            if (un !== undefined) return un
            if (c.kind !== 'group') return deny('ERROR: only supergroups have a history setting.')
            if (flag === undefined)
              return deny('ERROR: history_visible needs enabled true or false.')
            const r = await once(c.id, () =>
              (client.setHistoryVisible as NonNullable<TgUserClient['setHistoryVisible']>)(
                c.id,
                flag,
              ),
            )
            return r.ok
              ? `New members of "${c.title}" ${flag ? 'see the earlier messages' : 'only see messages from when they joined'}.`
              : r.text
          }
          case 'reactions': {
            const un = need('reactions', client.setReactions)
            if (un !== undefined) return un
            const mode = input.mode
            if (mode !== 'all' && mode !== 'none' && mode !== 'some')
              return deny('ERROR: reactions needs mode: all, none or some.')
            const emojis = Array.isArray(input.emojis) ? (input.emojis as string[]) : []
            if (mode === 'some' && emojis.length === 0)
              return deny('ERROR: mode some needs emojis (the allowed reactions).')
            const r = await once(c.id, () =>
              (client.setReactions as NonNullable<TgUserClient['setReactions']>)(c.id, {
                mode,
                ...(mode === 'some' ? { emojis } : {}),
              }),
            )
            return r.ok
              ? `Reactions in "${c.title}": ${mode === 'some' ? emojis.join(' ') : mode === 'all' ? 'all allowed' : 'none'}.`
              : r.text
          }
          case 'signatures': {
            const un = need('post signatures', client.setChannelSignatures)
            if (un !== undefined) return un
            if (c.kind !== 'channel') return deny('ERROR: signatures exist in channels only.')
            if (flag === undefined) return deny('ERROR: signatures needs enabled true or false.')
            const r = await once(c.id, () =>
              (client.setChannelSignatures as NonNullable<TgUserClient['setChannelSignatures']>)(
                c.id,
                flag,
              ),
            )
            return r.ok
              ? `Posts of "${c.title}" are ${flag ? 'signed with the admin name' : 'unsigned'}.`
              : r.text
          }
          case 'link_discussion': {
            const un = need('linking discussion groups', client.linkDiscussionGroup)
            if (un !== undefined) return un
            if (c.kind !== 'channel')
              return deny(
                'ERROR: chat must be the broadcast channel; group is the discussion supergroup.',
              )
            if (typeof input.group !== 'string') return deny('ERROR: link_discussion needs group.')
            const g = await managed(input.group)
            if (typeof g === 'string') return g
            if (g.kind !== 'group') return deny(`ERROR: "${g.title}" is not a supergroup.`)
            const r = await once(c.id, () =>
              (client.linkDiscussionGroup as NonNullable<TgUserClient['linkDiscussionGroup']>)(
                c.id,
                g.id,
              ),
            )
            d.hooks.chatsChanged?.()
            return r.ok
              ? `"${g.title}" is now the discussion group of "${c.title}": posts get a comments thread there (comment_on_post writes into it).`
              : r.text
          }
          case 'unlink_discussion': {
            const un = need('linking discussion groups', client.linkDiscussionGroup)
            if (un !== undefined) return un
            if (c.kind !== 'channel') return deny('ERROR: chat must be the broadcast channel.')
            const r = await once(c.id, () =>
              (client.linkDiscussionGroup as NonNullable<TgUserClient['linkDiscussionGroup']>)(
                c.id,
                null,
              ),
            )
            d.hooks.chatsChanged?.()
            return r.ok ? `"${c.title}" has no discussion group any more.` : r.text
          }
          default: {
            const un = need('send-as', client.setDefaultSendAs)
            if (un !== undefined) return un
            if (typeof input.send_as !== 'string')
              return deny('ERROR: default_send_as needs send_as (a channel of the account).')
            const as = await managed(input.send_as)
            if (typeof as === 'string') return as
            const r = await once(c.id, () =>
              (client.setDefaultSendAs as NonNullable<TgUserClient['setDefaultSendAs']>)(
                c.id,
                as.id,
              ),
            )
            return r.ok
              ? `In "${c.title}" this account now posts as "${as.title}" by default.`
              : r.text
          }
        }
      },
    },
    // --- join requests and invite links ----------------------------------------------------------
    {
      name: 'list_join_requests',
      risk: 'read',
      summary:
        'People waiting for an admin to let them into a group or channel the account administers (join requests of links or public chats that need approval), newest first.',
      schema: z.object({
        chat: chatField,
        link: linkField.optional().describe('Only the requests that came through this link.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      }),
      run: async (input) => {
        if (client.listJoinRequests === undefined) return unavailable('join requests')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const r = await once(c.id, () =>
          (client.listJoinRequests as NonNullable<TgUserClient['listJoinRequests']>)(c.id, {
            limit: Number(input.limit ?? 50),
            ...(typeof input.link === 'string' ? { link: input.link } : {}),
          }),
        )
        if (!r.ok) {
          // Telegram could not be asked: the requests the events announced are still saved
          const saved = d.joinRequests?.list(c.id) ?? []
          if (saved.length === 0) return r.text
          return [
            `${r.text}`,
            `${saved.length} waiting to join "${c.title}" according to the saved list (Telegram was not asked, so this may be out of date):`,
            ...saved
              .slice(0, 30)
              .map(
                (q) =>
                  `- ${nameOf({ id: q.userId, name: q.name, ...(q.username === undefined ? {} : { username: q.username }) })} asked ${h.when(q.at)}${q.bio === undefined ? '' : `, bio: ${clip(flat(q.bio), 120)}`}`,
              ),
            ...(saved.length > 30 ? [`...and ${saved.length - 30} more.`] : []),
          ].join('\n')
        }
        // what Telegram says now is the truth: keep the saved list in step with it
        for (const q of r.value) {
          if (typeof input.link === 'string') break
          d.joinRequests?.note({
            chatId: c.id,
            chatTitle: c.title,
            userId: q.user.id,
            name: q.user.name,
            ...(q.user.username === undefined ? {} : { username: q.user.username }),
            ...(q.bio === undefined ? {} : { bio: q.bio }),
            at: q.at,
          })
        }
        if (r.value.length === 0) return `Nobody is waiting to join "${c.title}".`
        return [
          `${r.value.length} waiting to join "${c.title}":`,
          ...r.value.map(
            (q) =>
              `- ${nameOf(q.user)} asked ${h.when(q.at)}${q.bio === undefined ? '' : `, bio: ${clip(flat(q.bio), 120)}`}`,
          ),
        ].join('\n')
      },
    },
    {
      name: 'answer_join_request',
      risk: 'external',
      summary:
        "Approve or decline one person's join request (user id) or all waiting requests (all: true, optionally of one link). Approved people join the chat. Owner or admin.",
      schema: z.object({
        chat: chatField,
        action: z.enum(['approve', 'decline']),
        user: userIdField.optional(),
        all: z.boolean().optional().describe('Answer every waiting request (needs confirm).'),
        link: linkField.optional().describe('With all: only this link.'),
        confirm: confirmField,
      }),
      run: async (input) => {
        if (client.answerJoinRequests === undefined) return unavailable('join requests')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const action = input.action === 'decline' ? 'decline' : 'approve'
        const all = input.all === true
        if (!all && typeof input.user !== 'string') return deny('ERROR: give user, or all: true.')
        if (all && input.confirm !== true)
          return deny(
            `ERROR: ${action === 'approve' ? 'approving' : 'declining'} everybody needs confirm: true. Ask the person first.`,
          )
        const r = await once(c.id, () =>
          (client.answerJoinRequests as NonNullable<TgUserClient['answerJoinRequests']>)(c.id, {
            action,
            ...(all ? { all: true } : { userId: String(input.user) }),
            ...(typeof input.link === 'string' ? { link: input.link } : {}),
          }),
        )
        if (!r.ok) return r.text
        d.joinAnswered?.({
          chatId: c.id,
          resolution: action === 'approve' ? 'approved' : 'declined',
          ...(all ? {} : { users: [String(input.user)] }),
          ...(typeof input.link === 'string' ? { link: input.link } : {}),
        })
        return `${action === 'approve' ? 'Approved' : 'Declined'} ${all ? 'all waiting requests' : `the request of user ${input.user}`} for "${c.title}".`
      },
    },
    {
      name: 'list_invite_links',
      risk: 'read',
      summary:
        'Invite links this account made for a chat it administers: link, title, people who joined and the limit, expiry, whether admin approval is needed, revoked ones on request.',
      schema: z.object({
        chat: chatField,
        revoked: z.boolean().optional().describe('List revoked links instead.'),
      }),
      run: async (input) => {
        if (client.listInviteLinks === undefined) return unavailable('invite links')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const r = await once(c.id, () =>
          (client.listInviteLinks as NonNullable<TgUserClient['listInviteLinks']>)(c.id, {
            revoked: input.revoked === true,
            limit: 100,
          }),
        )
        if (!r.ok) return r.text
        if (r.value.length === 0)
          return `No ${input.revoked === true ? 'revoked ' : ''}invite links of this account in "${c.title}".`
        return [`${r.value.length} invite link(s) of "${c.title}":`, ...r.value.map(linkLine)].join(
          '\n',
        )
      },
    },
    {
      name: 'edit_invite_link',
      risk: 'external',
      summary:
        'Change an invite link (not the primary one): expiry in days (0 = none), usage limit (0 = none), whether joins need admin approval, a title only admins see. Only the fields you give change. Owner or admin.',
      schema: z.object({
        chat: chatField,
        link: linkField,
        expires_days: z.number().int().min(0).max(365).optional(),
        usage_limit: z.number().int().min(0).max(99_999).optional(),
        with_approval: z.boolean().optional(),
        title: z.string().max(32).optional(),
      }),
      run: async (input) => {
        if (client.editInviteLink === undefined) return unavailable('editing invite links')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const o = {
          ...(typeof input.expires_days === 'number'
            ? { expiresAt: input.expires_days === 0 ? 0 : days(input.expires_days) }
            : {}),
          ...(typeof input.usage_limit === 'number' ? { usageLimit: input.usage_limit } : {}),
          ...(typeof input.with_approval === 'boolean'
            ? { withApproval: input.with_approval }
            : {}),
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
        }
        if (Object.keys(o).length === 0)
          return 'ERROR: give at least one of expires_days, usage_limit, with_approval, title.'
        const link = String(input.link)
        const r = await once(c.id, () =>
          (client.editInviteLink as NonNullable<TgUserClient['editInviteLink']>)(c.id, link, o),
        )
        return r.ok ? `Updated:\n${linkLine(r.value)}` : r.text
      },
    },
    {
      name: 'revoke_invite_link',
      risk: 'external',
      summary:
        'Revoke an invite link so nobody can join with it any more (people already in stay). Revoking the primary link makes Telegram issue a new one. Owner or admin.',
      schema: z.object({ chat: chatField, link: linkField }),
      run: async (input) => {
        if (client.revokeInviteLink === undefined) return unavailable('revoking invite links')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const link = String(input.link)
        const r = await once(c.id, () =>
          (client.revokeInviteLink as NonNullable<TgUserClient['revokeInviteLink']>)(c.id, link),
        )
        return r.ok ? `Revoked ${link} in "${c.title}".` : r.text
      },
    },
    // --- delete and hand over ---------------------------------------------------------------------
    {
      name: 'delete_chat',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Delete a group or channel for EVERYBODY (messages and members are gone; cannot be undone). Only a chat this account created. Owner only, and confirm: true is required: ask the person to confirm the exact chat first.',
      schema: z.object({ chat: chatField, confirm: confirmField }),
      run: async (input) => {
        if (client.deleteChat === undefined) return unavailable('delete_chat')
        const c = await h.findChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm')
          return deny('ERROR: that is a direct chat with a person, not a group or channel.')
        if (input.confirm !== true) {
          return deny(
            `ERROR: deleting "${c.title}" (${c.id}) removes it for everybody and cannot be undone. Ask the person to confirm, then call again with confirm: true.`,
          )
        }
        const r = await once(c.id, () =>
          (client.deleteChat as NonNullable<TgUserClient['deleteChat']>)(c.id),
        )
        if (!r.ok) return r.text
        if (chats.isSelected(connectionId, c.id))
          chats.setSelected(connectionId, c.id, false, d.now())
        d.hooks.chatsChanged?.()
        return `Deleted "${c.title}" (${c.id}) for everybody.`
      },
    },
    {
      name: 'transfer_ownership',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Hand a chat this account created over to another person. This app never handles the two-step verification password, so it cannot do it: the call only explains how the person does it in Telegram. Owner only.',
      schema: z.object({ chat: chatField, user: personField.optional() }),
      run: async (input) => {
        const c = await h.findChat(String(input.chat))
        const title = typeof c === 'string' ? String(input.chat) : c.title
        return deny(
          `Not done: transferring ownership of "${title}" needs the account's two-step verification password, and this app never sees or handles that password. Ask the person who controls the Telegram account to do it in the Telegram app: open the chat, Edit, Administrators, pick the new owner and choose "Transfer ownership" (the new owner has to be an admin first; promote_member can make them one). Do not ask for the password.`,
        )
      },
    },
    // --- contacts ---------------------------------------------------------------------------------
    {
      name: 'add_contact',
      risk: 'external',
      summary:
        "Add a person to this account's Telegram contacts (first name, optional last name, a user id, @username or +phone, and whether to share this account's own phone number: default no). Being in the other person's contacts too (mutual) is what lifts some privacy limits, like adding them to groups: adding them here alone does not. Owner or admin.",
      schema: z.object({
        user: z.string().min(1).max(64).describe('Telegram user id, @username or +phone number.'),
        first_name: z.string().min(1).max(64),
        last_name: z.string().max(64).optional(),
        phone: z.string().max(24).optional(),
        share_phone: z
          .boolean()
          .optional()
          .describe("Share this account's phone number with them (default false)."),
      }),
      run: async (input) => {
        if (client.addContact === undefined) return unavailable('add_contact')
        const ref = String(input.user).trim()
        if (!/^\d+$/.test(ref) && !ref.startsWith('+')) {
          const refusal = h.spendResolve()
          if (refusal !== undefined) return deny(refusal)
        }
        const r = await once(undefined, () =>
          (client.addContact as NonNullable<TgUserClient['addContact']>)({
            user: ref,
            firstName: String(input.first_name).trim(),
            ...(typeof input.last_name === 'string' && input.last_name.trim() !== ''
              ? { lastName: input.last_name.trim() }
              : {}),
            ...(typeof input.phone === 'string' ? { phone: input.phone.trim() } : {}),
            sharePhone: input.share_phone === true,
          }),
        )
        if (!r.ok) return r.text
        return `Added ${nameOf(r.value)} to the contacts${input.share_phone === true ? " and shared this account's phone number" : " (this account's phone number was not shared)"}. A contact on this side alone does not lift their privacy limits: it helps only if they also have this account in their contacts.`
      },
    },
    {
      name: 'list_contacts',
      risk: 'read',
      summary:
        'The contacts of this Telegram account (names, ids, usernames, whether the contact is mutual). Phone numbers are never listed.',
      schema: z.object({
        query: z.string().max(64).optional().describe('Names or usernames containing this text.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100.'),
      }),
      run: async (input) => {
        if (client.listContacts === undefined) return unavailable('list_contacts')
        const r = await once(undefined, () =>
          (client.listContacts as NonNullable<TgUserClient['listContacts']>)(),
        )
        if (!r.ok) return r.text
        const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
        const rows = r.value.filter(
          (u) =>
            q === '' ||
            u.name.toLowerCase().includes(q) ||
            (u.username ?? '').toLowerCase().includes(q),
        )
        if (rows.length === 0)
          return q === '' ? 'This account has no contacts.' : `No contact matches "${input.query}".`
        const shown = rows.slice(0, Number(input.limit ?? 100))
        return [
          `${rows.length} contact(s)${rows.length > shown.length ? ` (first ${shown.length})` : ''}:`,
          ...shown.map(
            (u) => `- ${nameOf(u)}${u.mutual === true ? ', mutual' : ''}${u.isBot ? ', bot' : ''}`,
          ),
        ].join('\n')
      },
    },
    // --- topics -----------------------------------------------------------------------------------
    {
      name: 'manage_topic',
      risk: 'write',
      summary:
        'Pin or unpin a topic of a forum group, or hide / show the General topic (the account needs the manage topics right). Closing, reopening and renaming are edit_forum_topic.',
      schema: z.object({
        chat: chatField,
        action: z.enum(['pin', 'unpin', 'hide_general', 'show_general']),
        topic: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('The topic id (list_forum_topics) for pin and unpin.'),
      }),
      run: async (input) => {
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        if (!c.forum) return deny(`ERROR: "${c.title}" is not a forum.`)
        const action = String(input.action)
        if (action === 'pin' || action === 'unpin') {
          if (client.setTopicPinned === undefined) return unavailable('pinning topics')
          if (typeof input.topic !== 'number') return deny('ERROR: pin and unpin need topic.')
          const topic = input.topic
          const r = await once(c.id, () =>
            (client.setTopicPinned as NonNullable<TgUserClient['setTopicPinned']>)(
              c.id,
              topic,
              action === 'pin',
            ),
          )
          return r.ok
            ? `Topic ${topic} of "${c.title}" ${action === 'pin' ? 'pinned' : 'unpinned'}.`
            : r.text
        }
        if (client.setGeneralHidden === undefined) return unavailable('hiding the General topic')
        const r = await once(c.id, () =>
          (client.setGeneralHidden as NonNullable<TgUserClient['setGeneralHidden']>)(
            c.id,
            action === 'hide_general',
          ),
        )
        return r.ok
          ? `The General topic of "${c.title}" is ${action === 'hide_general' ? 'hidden' : 'shown'}.`
          : r.text
      },
    },
    {
      name: 'delete_forum_topic',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Delete a topic of a forum group with ALL its messages (cannot be undone). Owner only; confirm: true is required.',
      schema: z.object({
        chat: chatField,
        topic: z.number().int().positive().describe('The topic id (list_forum_topics).'),
        confirm: confirmField,
      }),
      run: async (input) => {
        if (client.deleteTopic === undefined) return unavailable('deleting topics')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        if (!c.forum) return deny(`ERROR: "${c.title}" is not a forum.`)
        const topic = Number(input.topic)
        if (input.confirm !== true)
          return deny(
            `ERROR: deleting topic ${topic} of "${c.title}" removes every message in it for good. Ask the person to confirm, then call again with confirm: true.`,
          )
        const r = await once(c.id, () =>
          (client.deleteTopic as NonNullable<TgUserClient['deleteTopic']>)(c.id, topic),
        )
        return r.ok ? `Deleted topic ${topic} of "${c.title}" with all its messages.` : r.text
      },
    },
    // --- members ----------------------------------------------------------------------------------
    {
      name: 'member_info',
      risk: 'read',
      summary:
        "One person's standing in a chosen chat: member, admin (with the exact rights, title and who promoted them), restricted or banned (with what they may not do), or not in the chat.",
      schema: z.object({ chat: chatField, user: userIdField }),
      run: async (input) => {
        if (client.getMember === undefined) return unavailable('member_info')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const user = String(input.user)
        const r = await once(c.id, () =>
          (client.getMember as NonNullable<TgUserClient['getMember']>)(c.id, user),
        )
        if (!r.ok) return r.text
        if (r.value === null) return `User ${user} is not in "${c.title}".`
        return memberLines(r.value, c.title)
      },
    },
    {
      name: 'kick_member',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Remove a person from a chosen group now; unlike ban_member they may join again (by link or request). Owner only; the account must be an admin.',
      schema: z.object({ chat: chatField, user: userIdField }),
      run: async (input) => {
        if (client.kickMember === undefined) return unavailable('kick_member')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const notAdmin = h.ownerAdmin(c)
        if (notAdmin !== undefined) return deny(notAdmin)
        const user = String(input.user)
        if (user === d.selfId)
          return deny('ERROR: the account cannot remove itself: use leave_chat.')
        const r = await once(c.id, () =>
          (client.kickMember as NonNullable<TgUserClient['kickMember']>)(c.id, user),
        )
        return r.ok ? `Removed user ${user} from "${c.title}"; they can join again.` : r.text
      },
    },
    // --- messages ---------------------------------------------------------------------------------
    {
      name: 'mark_read',
      risk: 'write',
      summary:
        'Mark a chosen chat as read in the account (the people there may see the read receipt in small chats). Nothing else changes.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        if (client.markRead === undefined) return unavailable('mark_read')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const r = await once(c.id, () =>
          (client.markRead as NonNullable<TgUserClient['markRead']>)(c.id),
        )
        return r.ok ? `Marked "${c.title}" as read.` : r.text
      },
    },
    {
      name: 'clear_history',
      risk: 'destructive',
      ownerOnly: true,
      summary:
        'Delete the message history of a chosen chat: for this account only (me) or for everybody where Telegram allows (everyone; cannot be undone). Owner only; confirm: true is required.',
      schema: z.object({
        chat: chatField,
        for: z.enum(['me', 'everyone']),
        confirm: confirmField,
      }),
      run: async (input) => {
        if (client.clearHistory === undefined) return unavailable('clear_history')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const everyone = input.for === 'everyone'
        if (input.confirm !== true)
          return deny(
            `ERROR: clearing the history of "${c.title}" ${everyone ? 'for everybody' : 'on this account'} cannot be undone. Ask the person to confirm, then call again with confirm: true.`,
          )
        if (everyone && !c.admin)
          return deny(h.ownerAdmin(c) ?? 'ERROR: only admins clear history for everybody.')
        const r = await once(c.id, () =>
          (client.clearHistory as NonNullable<TgUserClient['clearHistory']>)(
            c.id,
            everyone ? 'revoke' : 'clear',
          ),
        )
        return r.ok
          ? `Cleared the history of "${c.title}" ${everyone ? 'for everybody' : 'for this account'}.`
          : r.text
      },
    },
    {
      name: 'pin_message',
      risk: 'write',
      summary:
        'Pin a message of a chosen chat (notify true tells the members, default silent), unpin it, or unpin everything (optionally one topic). The account needs the pin right.',
      schema: z.object({
        chat: chatField,
        action: z.enum(['pin', 'unpin', 'unpin_all']),
        id: z.number().int().positive().optional().describe('The message id for pin and unpin.'),
        notify: z.boolean().optional(),
        topic: z.number().int().positive().optional().describe('With unpin_all: only this topic.'),
      }),
      run: async (input) => {
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const action = String(input.action)
        if (action === 'unpin_all') {
          if (client.unpinAll === undefined) return unavailable('unpinning all')
          const topic = typeof input.topic === 'number' ? input.topic : undefined
          const r = await once(c.id, () =>
            (client.unpinAll as NonNullable<TgUserClient['unpinAll']>)(c.id, topic),
          )
          return r.ok
            ? `Unpinned every message in "${c.title}"${topic === undefined ? '' : ` (topic ${topic})`}.`
            : r.text
        }
        if (typeof input.id !== 'number') return deny('ERROR: pin and unpin need id.')
        const id = input.id
        if (action === 'unpin') {
          const r = await once(c.id, () => client.pin(c.id, id, false))
          return r.ok ? `Unpinned message ${id} in "${c.title}".` : r.text
        }
        const notify = input.notify === true
        const r = await once(c.id, () =>
          client.pinWithOptions !== undefined
            ? client.pinWithOptions(c.id, id, { notify })
            : client.pin(c.id, id, true),
        )
        return r.ok
          ? `Pinned message ${id} in "${c.title}"${notify ? ' and notified the members' : ' silently'}.`
          : r.text
      },
    },
    {
      name: 'poll_results',
      risk: 'read',
      summary:
        'The current results of a poll in a chosen chat (message id): votes per option, whether it is closed, the right answer of a quiz, and the recent voters where the poll is public or the account created it.',
      schema: z.object({
        chat: chatField,
        id: z.number().int().positive().describe('The message id of the poll.'),
      }),
      run: async (input) => {
        if (client.getPoll === undefined) return unavailable('poll_results')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const id = Number(input.id)
        const r = await once(c.id, () =>
          (client.getPoll as NonNullable<TgUserClient['getPoll']>)(c.id, id),
        )
        if (!r.ok) return r.text
        const p = r.value
        return [
          `${p.quiz ? 'Quiz' : 'Poll'} "${clip(flat(p.question), 200)}": ${p.totalVoters} voter(s), ${p.closed ? 'closed' : 'open'}${p.multiple ? ', several answers allowed' : ''}${p.public ? ', public' : ', anonymous'}.`,
          ...p.options.map(
            (o, i) =>
              `${i}. ${clip(flat(o.text), 100)}: ${o.voters}${o.correct === true ? ' (right answer)' : ''}${o.recentVoters.length > 0 ? `; recent voters: ${o.recentVoters.map((v) => `${v.name} (${v.id})`).join(', ')}` : ''}`,
          ),
        ].join('\n')
      },
    },
    {
      name: 'stop_poll',
      risk: 'write',
      summary:
        'Close a poll this account posted in a chosen chat (nobody can vote after; it cannot be reopened).',
      schema: z.object({
        chat: chatField,
        id: z.number().int().positive().describe('The message id of the poll.'),
      }),
      run: async (input) => {
        if (client.stopPoll === undefined) return unavailable('stop_poll')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const id = Number(input.id)
        const r = await once(c.id, () =>
          (client.stopPoll as NonNullable<TgUserClient['stopPoll']>)(c.id, id),
        )
        return r.ok ? `Closed poll ${id} in "${c.title}".` : r.text
      },
    },
    {
      name: 'copy_message',
      risk: 'external',
      summary:
        'Copy messages from one chosen chat to another WITHOUT the "forwarded from" header (the text and media are sent as new messages of this account). Never copy to or from a direct chat.',
      schema: z.object({
        from_chat: chatField,
        ids: z.array(z.number().int().positive()).min(1).max(20),
        to_chat: chatField,
        to_topic: z.number().int().min(0).optional(),
        silent: z.boolean().optional(),
      }),
      run: async (input) => {
        if (client.copyMessage === undefined) return unavailable('copy_message')
        const from = await chosen(String(input.from_chat))
        if (typeof from === 'string') return from
        const to = await chosen(String(input.to_chat))
        if (typeof to === 'string') return to
        const refusal = h.postRefusal()
        if (refusal !== undefined) return deny(refusal)
        const sent: number[] = []
        for (const id of (input.ids as number[]) ?? []) {
          const r = await attempt(to.id, () =>
            (client.copyMessage as NonNullable<TgUserClient['copyMessage']>)(from.id, id, to.id, {
              ...(typeof input.to_topic === 'number' && input.to_topic > 0
                ? { topicId: input.to_topic }
                : {}),
              ...(input.silent === true ? { silent: true } : {}),
            }),
          )
          if (!r.ok) {
            return `Copied ${sent.length} of ${(input.ids as number[]).length}; stopped at message ${id}: ${r.sentence}`
          }
          sent.push(r.value.id)
          counters.add(connectionId, 'all', d.now())
        }
        return `Copied ${sent.length} message(s) from "${from.title}" to "${to.title}" (new ids ${sent.join(', ')}).`
      },
    },
    {
      name: 'post_stats',
      risk: 'read',
      summary:
        'Views, forwards, replies (comments) and reactions of messages in a chosen channel or group, by message id.',
      schema: z.object({
        chat: chatField,
        ids: z.array(z.number().int().positive()).min(1).max(30),
      }),
      run: async (input) => {
        if (client.messageStats === undefined) return unavailable('post_stats')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const ids = (input.ids as number[]) ?? []
        const r = await once(c.id, () =>
          (client.messageStats as NonNullable<TgUserClient['messageStats']>)(c.id, ids),
        )
        if (!r.ok) return r.text
        if (r.value.length === 0) return `None of those messages exist in "${c.title}".`
        return [
          `Stats in "${c.title}":`,
          ...r.value.map(
            (m) =>
              `- ${m.id}: ${m.views === undefined ? 'views n/a' : `${m.views} views`}, ${m.forwards ?? 0} forwards, ${m.replies ?? 0} replies${m.hasComments === true ? ' (comments open)' : ''}${m.reactions.length > 0 ? `, reactions ${m.reactions.map((x) => `${x.emoji} ${x.count}`).join(' ')}` : ''}`,
          ),
        ].join('\n')
      },
    },
    {
      name: 'comment_on_post',
      risk: 'external',
      summary:
        "Write a comment under a channel post, in the post's discussion thread (the channel needs a linked discussion group). In a normal group it is a plain reply. The account's daily cap applies.",
      schema: z.object({
        chat: chatField,
        post: z.number().int().positive().describe('The message id of the channel post.'),
        text: z.string().min(1).max(4096),
      }),
      run: async (input) => {
        if (client.commentOnPost === undefined) return unavailable('comment_on_post')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const refusal = h.postRefusal()
        if (refusal !== undefined) return deny(refusal)
        const post = Number(input.post)
        const text = neutralizeHandles(String(input.text))
        const r = await once(c.id, () =>
          (client.commentOnPost as NonNullable<TgUserClient['commentOnPost']>)(c.id, post, text),
        )
        if (!r.ok) return r.text
        counters.add(connectionId, 'all', d.now())
        return `Commented under post ${post} of "${c.title}" (comment ${r.value.id}).`
      },
    },
    {
      name: 'send_album',
      risk: 'external',
      summary: `Send 2 to ${MAX_ALBUM} library files (images, videos, documents) as one album message to a chosen chat or topic, with an optional caption on the first.`,
      schema: z.object({
        chat: chatField,
        files: z
          .array(z.string().min(1).max(300))
          .min(2)
          .max(MAX_ALBUM)
          .describe('Library file paths.'),
        caption: z.string().max(1024).optional(),
        topic: z.number().int().min(0).optional(),
      }),
      run: async (input) => {
        if (d.readFile === undefined) return unavailable('send_album')
        const c = await chosen(String(input.chat))
        if (typeof c === 'string') return c
        const refusal = h.postRefusal()
        if (refusal !== undefined) return deny(refusal)
        const files: Array<{ name: string; mediaType: string; bytes: Uint8Array }> = []
        let total = 0
        for (const path of (input.files as string[]) ?? []) {
          const f = await d.readFile(path)
          if (f === undefined) return `ERROR: no such file: ${path}`
          total += f.bytes.byteLength
          if (total > MAX_ALBUM_BYTES)
            return deny(
              `ERROR: the files together are larger than ${MAX_ALBUM_BYTES / (1024 * 1024)} MB.`,
            )
          files.push({
            name: path.split('/').pop() ?? 'file',
            mediaType: f.mediaType,
            bytes: f.bytes,
          })
        }
        const caption = typeof input.caption === 'string' ? neutralizeHandles(input.caption) : ''
        const r = await once(c.id, () =>
          client.sendFiles(c.id, files, caption, {
            ...(typeof input.topic === 'number' && input.topic > 0 ? { topicId: input.topic } : {}),
          }),
        )
        if (!r.ok) return r.text
        counters.add(connectionId, 'all', d.now(), files.length)
        return `Sent an album of ${files.length} files to "${c.title}" (message ${r.value.id}).`
      },
    },
    // --- discovery --------------------------------------------------------------------------------
    {
      name: 'resolve_chat',
      risk: 'read',
      summary:
        'Look up a public @username or t.me link: what chat or person it is (title, type, members, description), without joining. A username lookup is rate limited hard (5 a minute, 30 a day here).',
      schema: z.object({
        ref: z.string().min(2).max(200).describe('@username, username or t.me/<name> link.'),
      }),
      run: async (input) => {
        if (client.resolveChat === undefined) return unavailable('resolve_chat')
        const refusal = h.spendResolve()
        if (refusal !== undefined) return deny(refusal)
        const ref = String(input.ref)
        if (/t\.me\/(?:\+|joinchat\/)/i.test(ref))
          return deny('ERROR: that is a private invite link: use check_invite_link.')
        const r = await once(undefined, () =>
          (client.resolveChat as NonNullable<TgUserClient['resolveChat']>)(ref),
        )
        if (!r.ok) return r.text
        const p = r.value
        return [
          `${p.title}${p.username === undefined ? '' : ` @${p.username}`}${p.id === undefined ? '' : ` (${p.id})`}: ${p.kind}${p.members === undefined ? '' : `, ${p.members} members`}${p.joined === true ? ', this account is in it' : ''}.`,
          ...(p.description === undefined
            ? []
            : [`Description: ${clip(flat(p.description), 600)}`]),
        ].join('\n')
      },
    },
    {
      name: 'check_invite_link',
      risk: 'read',
      summary:
        'Look at a private invite link (t.me/+...) before joining: the chat title, type, member count and whether joining needs admin approval. Nothing is joined.',
      schema: z.object({ link: z.string().min(8).max(200) }),
      run: async (input) => {
        if (client.checkInviteLink === undefined) return unavailable('check_invite_link')
        const link = String(input.link).trim()
        const r = await once(undefined, () =>
          (client.checkInviteLink as NonNullable<TgUserClient['checkInviteLink']>)(link),
        )
        if (!r.ok) return r.text
        const p = r.value
        if (p.joined === true) return 'This account is in that chat already.'
        return `Invite to "${p.title}" (${p.kind}${p.members === undefined ? '' : `, ${p.members} members`}): ${p.withApproval === true ? 'joining needs an admin to approve the request' : 'joining is direct'}. join_chat joins (owner only, 3 a day).`
      },
    },
    {
      name: 'chat_stats',
      risk: 'read',
      summary:
        'Statistics of a channel or supergroup the account administers (followers or members, views, shares, reactions, activity: current period against the one before). Telegram offers them only to admins of larger chats, otherwise this says so.',
      schema: z.object({ chat: chatField }),
      run: async (input) => {
        if (client.chatStats === undefined) return unavailable('chat_stats')
        const c = await managed(String(input.chat))
        if (typeof c === 'string') return c
        const r = await attempt(c.id, () =>
          (client.chatStats as NonNullable<TgUserClient['chatStats']>)(c.id),
        )
        if (!r.ok) {
          return `ERROR: statistics of "${c.title}" are not available to this account: ${r.sentence} (Telegram gives statistics to admins of channels and supergroups with enough members.)`
        }
        return [
          `${r.value.kind === 'channel' ? 'Channel' : 'Group'} statistics of "${c.title}":`,
          ...r.value.lines.map((l) => `- ${l}`),
        ].join('\n')
      },
    },
    // --- the chat list ----------------------------------------------------------------------------
    {
      name: 'manage_dialog',
      risk: 'write',
      summary:
        "The account's own chat list: mute (for some days, default for good) or unmute notifications of a group or channel, archive or unarchive it, pin or unpin it at the top.",
      schema: z.object({
        chat: chatField,
        action: z.enum(['mute', 'unmute', 'archive', 'unarchive', 'pin', 'unpin']),
        mute_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('With mute: for this many days; leave out = for good.'),
      }),
      run: async (input) => {
        const c = await h.findChat(String(input.chat))
        if (typeof c === 'string') return c
        if (c.kind === 'dm')
          return deny(
            'ERROR: that is a direct chat with a person. This changes groups and channels only.',
          )
        const action = String(input.action)
        if (action === 'mute' || action === 'unmute') {
          if (client.muteChat === undefined) return unavailable('muting')
          const until =
            action === 'unmute'
              ? null
              : typeof input.mute_days === 'number'
                ? days(input.mute_days)
                : Number.POSITIVE_INFINITY
          const r = await once(c.id, () =>
            (client.muteChat as NonNullable<TgUserClient['muteChat']>)(c.id, until),
          )
          return r.ok
            ? action === 'unmute'
              ? `Notifications of "${c.title}" are on.`
              : `Notifications of "${c.title}" are muted${typeof input.mute_days === 'number' ? ` for ${input.mute_days} day(s)` : ' for good'}.`
            : r.text
        }
        if (action === 'archive' || action === 'unarchive') {
          if (client.archiveChat === undefined) return unavailable('archiving')
          const r = await once(c.id, () =>
            (client.archiveChat as NonNullable<TgUserClient['archiveChat']>)(
              c.id,
              action === 'archive',
            ),
          )
          return r.ok
            ? `"${c.title}" is ${action === 'archive' ? 'archived' : 'back in the main list'}.`
            : r.text
        }
        if (client.pinDialog === undefined) return unavailable('pinning chats')
        const r = await once(c.id, () =>
          (client.pinDialog as NonNullable<TgUserClient['pinDialog']>)(c.id, action === 'pin'),
        )
        return r.ok
          ? `"${c.title}" is ${action === 'pin' ? 'pinned to the top of the list' : 'unpinned'}.`
          : r.text
      },
    },
  ]
  return actions
}

/** A member as text: status, exact admin rights, limits, who promoted them. */
export function memberLines(m: TgMember, chatTitle: string): string {
  const head = `${nameOf(m.user)} in "${chatTitle}": ${m.status}${m.title === undefined ? '' : ` "${m.title}"`}`
  const lines = [head]
  if (m.status === 'admin' || m.status === 'creator') {
    lines.push(
      m.status === 'creator'
        ? 'Creator: holds every right and cannot be changed.'
        : `Admin rights: ${m.rights === undefined || m.rights.length === 0 ? 'none' : m.rights.join(', ')}.`,
    )
    if (m.promotedBy !== undefined)
      lines.push(`Promoted by ${m.promotedBy.name} (${m.promotedBy.id}).`)
    if (m.status === 'admin' && m.canEdit !== undefined)
      lines.push(
        m.canEdit
          ? 'This account can change or remove their rights.'
          : 'This account cannot change them (somebody else promoted them: only the creator or that admin can).',
      )
  }
  if (m.forbidden !== undefined && m.forbidden.length > 0)
    lines.push(`May NOT: ${m.forbidden.join(', ')}.`)
  return lines.join('\n')
}
