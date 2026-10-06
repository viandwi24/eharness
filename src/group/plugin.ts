/**
 * The `groupChat()` plugin and `routeGroupMessage()` (spec 16): should-respond gating for a
 * multi-party chat, a pending history of gated-out messages, speaker metadata and a bot-to-bot
 * anti-loop derived from stored history.
 *
 * Built only with the public core API (ADR-0008). No plugin state: everything is derived from the
 * stored messages, so several instances sharing storage agree (spec 16 §5).
 *
 * @see docs/specs/16-group-plugin.md
 * @see docs/decisions/0031-group-chat-helper-outside-the-turn.md
 */
import type { FileUIPart, UIMessage } from 'ai'
import { z } from 'zod/v4'
import {
  neutralizeTags as coreNeutralizeTags,
  defineMessageKind,
  definePlugin,
  type HarnessPlugin,
  type HarnessRun,
  type HarnessUIMessage,
  type InjectOptions,
  isKindMessage,
  type SendOptions,
  uuidv7,
} from '../index.ts'
import { GROUP_HISTORY_PREAMBLE, GROUP_SPEAKER_PREFIX } from './texts.ts'

/** Who wrote a group message. */
export interface GroupAuthor {
  id: string
  name?: string
  isBot?: boolean
}

/** One incoming message of the chat, as the channel adapter reports it. */
export interface GroupMessage {
  text: string
  files?: FileUIPart[]
  author: GroupAuthor
  /** Channel-level fact: the message mentions the bot (Telegram entity, Slack `<@U…>`). */
  mentionsBot?: boolean
  /** Channel-level fact: the message replies to one of the bot's messages. */
  replyToBot?: boolean
  chatId?: string
  messageId?: string
  /** Epoch ms of the message in the channel. */
  at?: number
}

/** Verdict of a `shouldRespond` hook. */
export type GroupDecision = 'respond' | 'ignore' | 'default'

/** Why a message did not get an answer. */
export type GroupIgnoreReason = 'not-mentioned' | 'bot' | 'loop-limit' | 'ignored'

/** Options of {@link groupChat}. */
export interface GroupChatOptions {
  /** The bot's own author id in this chat; its own messages are never stored or answered. */
  botId: string
  /** Display name; `@name` (case-insensitive) is a default mention pattern. */
  botName?: string
  /** Answer only when mentioned (or replied to). Default `true`. */
  requireMention?: boolean
  /** Text fallbacks for a mention (flags `g`/`y` are ignored). */
  mentionPatterns?: RegExp[]
  /** A reply to the bot counts as a mention. Default `true`. */
  replyCountsAsMention?: boolean
  /** Newest gated-out messages handed to the next answer. Default 20; 0 = none. */
  historyLimit?: number
  /** Bot-to-bot loop limit: at most `count` bot-triggered turns per `windowMs`. Default 3 / 60 000. */
  maxBotTurns?: { count: number; windowMs: number }
  /** Messages from bots never trigger unless `true` or listed by author id. Default `false`. */
  allowBots?: boolean | string[]
  /** Custom gate; `'respond'` / `'ignore'` are final, `'default'` continues with the rules. */
  shouldRespond?: (
    message: GroupMessage,
    event: { mentioned: boolean; session: GroupSession },
  ) => GroupDecision | Promise<GroupDecision>
  /** Name shown to the model for an author. Default `name ?? id`. */
  formatSpeaker?: (author: GroupAuthor) => string
}

/** Result of {@link routeGroupMessage}. */
export type GroupRouteResult =
  | { responded: false; reason: GroupIgnoreReason; messageId: string | undefined }
  | { responded: true; run: HarnessRun }

/** Data of the `group.message` kind (a gated-out message; file contents are never stored). */
export interface GroupMessageData {
  author: GroupAuthor
  text: string
  files?: Array<{ mediaType: string; filename?: string }>
  chatId?: string
  messageId?: string
  at?: number
}

/** The part of a session the plugin uses (any `HarnessSession` fits). */
export interface GroupSession {
  send(input: UIMessage, options?: SendOptions): HarnessRun
  messages(q?: { limit?: number }): Promise<HarnessUIMessage[]>
  inject(kind: string, data: unknown, options?: InjectOptions): Promise<{ message: { id: string } }>
}

/** The plugin value, with its `route` method. */
export type GroupChatPlugin = HarnessPlugin<'group'> & {
  /** Route one incoming message: store it as context or answer it. */
  route(
    session: GroupSession,
    message: GroupMessage,
    options?: SendOptions,
  ): Promise<GroupRouteResult>
}

const authorSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  isBot: z.boolean().optional(),
})

const groupMessageKind = defineMessageKind({
  role: 'user',
  schema: z.object({
    author: authorSchema,
    text: z.string(),
    files: z.array(z.object({ mediaType: z.string(), filename: z.string().optional() })).optional(),
    chatId: z.string().optional(),
    messageId: z.string().optional(),
    at: z.number().optional(),
  }),
  model: 'omit',
})

/** Newest stored messages scanned for history and the anti-loop. */
const SCAN_LIMIT = 200
const DEFAULT_HISTORY_LIMIT = 20
const DEFAULT_MAX_BOT_TURNS = { count: 3, windowMs: 60_000 }

/**
 * Neutralise the tags that frame group text (`<group-message>`, `<system-reminder>`, opening or
 * closing, any case/whitespace) inside stored text: `<` → `&lt;`.
 * @internal exported for tests
 */
export function neutralizeTags(text: string): string {
  return coreNeutralizeTags(text, ['group-message', 'system-reminder'])
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\s+/g, ' ')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function groupDataOf(message: HarnessUIMessage): GroupMessageData | undefined {
  if (!isKindMessage(message, 'group.message')) return undefined
  const part = message.parts[0] as { data?: GroupMessageData } | undefined
  return part?.data
}

function groupMetaOf(
  message: HarnessUIMessage,
): { author?: GroupAuthor; consumed?: unknown } | undefined {
  const meta = (message.metadata as { group?: unknown } | undefined)?.group
  return typeof meta === 'object' && meta !== null
    ? (meta as { author?: GroupAuthor; consumed?: unknown })
    : undefined
}

/**
 * Neutralise a speaker line the sender typed (`[group] Alice: …` at the start of a line), so a
 * message cannot pose as another speaker: `[group] ` → `[ group] `.
 * @internal exported for tests
 */
export function neutralizeSpeakerLines(text: string): string {
  return text.replace(/(^|\n)([ \t]*)\[group\] /g, '$1$2[ group] ')
}

/** Create the group-chat plugin (spec 16). */
export function groupChat(options: GroupChatOptions): GroupChatPlugin {
  const requireMention = options.requireMention ?? true
  const replyCounts = options.replyCountsAsMention ?? true
  const historyLimit = Math.max(0, options.historyLimit ?? DEFAULT_HISTORY_LIMIT)
  const maxBotTurns = options.maxBotTurns ?? DEFAULT_MAX_BOT_TURNS
  const speaker = options.formatSpeaker ?? ((a: GroupAuthor) => a.name ?? a.id)
  const patterns = [
    ...(options.mentionPatterns ?? []),
    ...(options.botName === undefined
      ? []
      : [new RegExp(`(?<![\\w])@${escapeRegExp(options.botName)}(?![\\w])`, 'i')]),
  ].map((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, '')))

  const botAllowed = (author: GroupAuthor): boolean =>
    options.allowBots === true ||
    (Array.isArray(options.allowBots) && options.allowBots.includes(author.id))

  const isMentioned = (m: GroupMessage): boolean =>
    m.mentionsBot === true ||
    (replyCounts && m.replyToBot === true) ||
    patterns.some((p) => p.test(m.text))

  async function decide(
    session: GroupSession,
    m: GroupMessage,
  ): Promise<'respond' | GroupIgnoreReason> {
    if (m.author.isBot === true && !botAllowed(m.author)) return 'bot'
    const mentioned = isMentioned(m)
    const custom = await options.shouldRespond?.(m, { mentioned, session })
    if (custom === 'respond') return 'respond'
    if (custom === 'ignore') return 'ignored'
    if (mentioned) return 'respond'
    return requireMention ? 'not-mentioned' : 'respond'
  }

  /** Bot-triggered turns inside the window, from the stored history (spec 16 §4). */
  function botTurns(history: HarnessUIMessage[], now: number): number {
    let count = 0
    for (const message of history) {
      if (message.role !== 'user' || isKindMessage(message)) continue
      if (groupMetaOf(message)?.author?.isBot !== true) continue
      const at = message.metadata?.eharness?.createdAt
      if (typeof at === 'number' && now - at <= maxBotTurns.windowMs) count += 1
    }
    return count
  }

  /**
   * Gated-out messages the model has not seen, oldest first (all of them; the caller limits).
   * With speaker metadata kept (`acceptClientMetadata`), "seen" = listed in the `consumed` ids of
   * an answering user message; without it, the gated messages after the newest real message.
   */
  function unseen(history: HarnessUIMessage[]): Array<{ id: string; data: GroupMessageData }> {
    const consumed = new Set<string>()
    let tracked = false
    for (const message of history) {
      if (message.role !== 'user' || isKindMessage(message)) continue
      const meta = groupMetaOf(message)
      if (meta === undefined) continue
      tracked = true
      if (Array.isArray(meta.consumed)) {
        for (const id of meta.consumed) if (typeof id === 'string') consumed.add(id)
      }
    }
    const out: Array<{ id: string; data: GroupMessageData }> = []
    if (tracked) {
      for (const message of history) {
        const data = groupDataOf(message)
        if (data !== undefined && !consumed.has(message.id)) out.push({ id: message.id, data })
      }
      return out
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i] as HarnessUIMessage
      const data = groupDataOf(message)
      if (data !== undefined) out.push({ id: message.id, data })
      else if (!isKindMessage(message)) break
    }
    return out.reverse()
  }

  /** Ids a routed message already claimed, until its turn ended: one history block per burst. */
  const claimed = new WeakMap<GroupSession, Set<string>>()

  function renderHistory(items: GroupMessageData[]): string {
    const blocks = items.map((d) => {
      const files = (d.files ?? []).map((f) => ` [attached: ${f.filename ?? f.mediaType}]`).join('')
      return `<group-message author="${escapeAttribute(speaker(d.author))}">${neutralizeTags(neutralizeSpeakerLines(d.text))}${files}</group-message>`
    })
    return `${GROUP_HISTORY_PREAMBLE}\n${blocks.join('\n')}`
  }

  const store = async (session: GroupSession, m: GroupMessage): Promise<string> => {
    const data: GroupMessageData = {
      author: m.author,
      text: m.text,
      ...(m.files === undefined || m.files.length === 0
        ? {}
        : {
            files: m.files.map((f) => ({
              mediaType: f.mediaType,
              ...(f.filename === undefined ? {} : { filename: f.filename }),
            })),
          }),
      ...(m.chatId === undefined ? {} : { chatId: m.chatId }),
      ...(m.messageId === undefined ? {} : { messageId: m.messageId }),
      ...(m.at === undefined ? {} : { at: m.at }),
    }
    return (await session.inject('group.message', data)).message.id
  }

  async function route(
    session: GroupSession,
    m: GroupMessage,
    sendOptions: SendOptions = {},
  ): Promise<GroupRouteResult> {
    // the bot's own messages are already in the conversation as assistant text
    if (m.author.id === options.botId) {
      return { responded: false, reason: 'ignored', messageId: undefined }
    }
    const decision = await decide(session, m)
    if (decision !== 'respond') {
      return { responded: false, reason: decision, messageId: await store(session, m) }
    }
    const history = await session.messages({ limit: SCAN_LIMIT })
    if (
      m.author.isBot === true &&
      botTurns(history, Date.now()) >= Math.max(0, maxBotTurns.count)
    ) {
      return { responded: false, reason: 'loop-limit', messageId: await store(session, m) }
    }

    const taken = claimed.get(session) ?? new Set<string>()
    const fresh = unseen(history).filter((x) => !taken.has(x.id))
    const shown = historyLimit === 0 ? [] : fresh.slice(-historyLimit)
    for (const x of fresh) taken.add(x.id)
    claimed.set(session, taken)
    const line = `${GROUP_SPEAKER_PREFIX}${speaker(m.author).replace(/\s+/g, ' ')}:`
    const text = `${shown.length > 0 ? `${renderHistory(shown.map((x) => x.data))}\n\n` : ''}${line} ${neutralizeSpeakerLines(m.text)}`
    const input: UIMessage = {
      id: m.messageId ?? uuidv7(),
      role: 'user',
      metadata: {
        group: {
          author: m.author,
          ...(m.chatId === undefined ? {} : { chatId: m.chatId }),
          ...(m.messageId === undefined ? {} : { messageId: m.messageId }),
          consumed: fresh.map((x) => x.id),
        },
      },
      parts: [{ type: 'text', text }, ...(m.files ?? [])],
    }
    const run = session.send(input, { ifBusy: 'collect', ...sendOptions })
    // after the turn ended the stored `consumed` ids decide; a failed turn offers them again
    void run.result.then(() => {
      for (const x of fresh) taken.delete(x.id)
    })
    return { responded: true, run }
  }

  let warned = false
  const plugin = definePlugin({
    name: 'group',
    messageKinds: { message: groupMessageKind },
    setup: () => ({
      hooks: {
        'input.submit': (ctx, e) => {
          // client metadata is dropped without `acceptClientMetadata`: the anti-loop cannot see bots
          const first = e.message.parts[0]
          const text = first?.type === 'text' ? first.text : ''
          const grouped = /(^|\n)\[group\] /.test(text)
          if (
            !warned &&
            grouped &&
            options.allowBots !== undefined &&
            options.allowBots !== false &&
            groupMetaOf(e.message) === undefined
          ) {
            warned = true
            ctx.log.warn(
              'eharness/group: speaker metadata was dropped; set acceptClientMetadata: true so the bot-to-bot loop limit can work.',
            )
          }
        },
      },
    }),
  })
  return Object.freeze({ ...plugin, route })
}

/** Route one incoming message through a {@link groupChat} plugin (spec 16 §2). */
export function routeGroupMessage(
  group: GroupChatPlugin,
  session: GroupSession,
  message: GroupMessage,
  options?: SendOptions,
): Promise<GroupRouteResult> {
  return group.route(session, message, options)
}
