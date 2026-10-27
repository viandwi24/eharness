/**
 * Channel policy: the configuration of a connection, the settings that inherit down the node tree
 * and the pure rules built on them (resolution, wake decision, text splitting, the bot loop
 * guard). No I/O.
 *
 * Settings (agent binding, wake rule, delivery, observe, retention, session scope, redaction)
 * resolve the same way everywhere: the node itself, then its ancestors up to the root, then the
 * connection's defaults, then the product's. There are no per-chat or per-topic override tables:
 * a topic of an allowed forum is allowed because it inherits, and says so only to differ.
 */
import { z } from 'zod'
import type { NodeRow } from './model.ts'
import { RolePoliciesSchema, RoleSchema } from './roles.ts'
import type { Identity, InboundSignals } from './types.ts'

const wake = z.enum(['mention', 'always', 'never'])
const delivery = z.enum(['final_text', 'message_tool'])

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 hours')

/**
 * What the agent may post here without being asked (a routine, the heartbeat, a program): nothing
 * unless `allowed`. Posts are held in quiet hours and while a digest collects them, then sent as
 * one message; `maxMentions` caps the pings of one message. Reminders people asked for are not
 * proactive: they ignore quiet hours but obey `maxMentions`.
 */
export const ProactivePolicySchema = z.object({
  allowed: z.boolean().optional(),
  /** `HH:MM` in the team timezone; a window that wraps midnight is fine. */
  quietHours: z.object({ from: clock, to: clock }).optional(),
  /** Collect proactive posts into one message per `digestMinutes` (default on). */
  digest: z.boolean().optional(),
  digestMinutes: z.number().int().min(5).max(1440).optional(),
  maxMentions: z.number().int().min(0).max(20).optional(),
})
export type ProactivePolicy = z.infer<typeof ProactivePolicySchema>

export const DEFAULT_PROACTIVE: Required<Omit<ProactivePolicy, 'quietHours'>> & {
  quietHours: ProactivePolicy['quietHours']
} = { allowed: false, quietHours: undefined, digest: true, digestMinutes: 60, maxMentions: 3 }

/** One level of the inheritance: a node, or the connection's defaults. All fields optional. */
export const ScopePolicySchema = z.object({
  /** `false` takes the scope out of the allowlist, `true` puts it in. */
  enabled: z.boolean().optional(),
  /** The agent that answers here (a room or topic may route to another agent). */
  agentId: z.string().min(1).optional(),
  wake: wake.optional(),
  /** Implicit wakes under `wake: 'mention'`. All default to true. */
  implicit: z
    .object({
      reply: z.boolean().optional(),
      alias: z.boolean().optional(),
      ownTopic: z.boolean().optional(),
    })
    .optional(),
  /** Case-insensitive words that count as a mention (`alias` wake). */
  aliases: z.array(z.string().min(1)).optional(),
  /** Do not wake on a message that mentions others and not the agent (default true). */
  ignoreWhenOthersMentioned: z.boolean().optional(),
  delivery: delivery.optional(),
  /** `final_text` quotes the trigger: `first` (default in groups) or `off` (default in DMs). */
  quote: z.enum(['first', 'off']).optional(),
  /** Ack reaction on an addressed group message; `false` = none. */
  ack: z.union([z.string().min(1), z.literal(false)]).optional(),
  /** Days the message store keeps the messages of this scope. */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  /** A name for the thread list when the platform gives none. Not inherited. */
  label: z.string().max(80).optional(),
  /** Store the full log of an allowed node, also the messages that do not address the agent (default true). */
  observe: z.boolean().optional(),
  /** `node` (default): the node has its own session. `room`: a thread shares the session of its room. */
  sessionScope: z.enum(['node', 'room']).optional(),
  /** Drop the content of a message when it is deleted on the platform (default: keep it for audit until retention). */
  redactOnDelete: z.boolean().optional(),
  /** What the agent may post here unasked (L6). */
  proactive: ProactivePolicySchema.optional(),
  /**
   * The role of somebody here who is neither in the directory nor linked to a team member
   * (`guest` or `member`). `member` is the "trusted internal group" switch. Inherited; the
   * connection's `people.defaultRole` is the fallback.
   */
  defaultRole: z.enum(['guest', 'member']).optional(),
  /** How long the agent's replies are in a group when its persona says nothing: the medium context's default. */
  replyStyle: z.enum(['brief', 'normal', 'detailed']).optional(),
  /** Tone, language and length of this place, for the persona (P42, layer 5). Inherited; never widens tools or rules. */
  personaOverlay: z.string().max(1000).optional(),
  /**
   * A feed for its agent: every message (also what the connected account posts itself) is input
   * to process, nobody is being answered. The agent wakes on each message, its final text is never
   * posted (it acts through tools), and tools run on the agent's own permissions, not the role of
   * whoever posted. For routers and processors (copy signals, file posts, sort requests).
   */
  feed: z.boolean().optional(),
  /** Copies an agent makes from this chat are only recorded, not sent (try a router first). */
  copyTrial: z.boolean().optional(),
})
export type ScopePolicy = z.infer<typeof ScopePolicySchema>

/** Keys that apply to the node itself and are never inherited. */
export const OWN_KEYS = ['label'] as const satisfies ReadonlyArray<keyof ScopePolicy>

const BucketOverrideSchema = z.object({
  /** Calls that may go out at once. */
  burst: z.number().int().min(1).optional(),
  /** Refill speed: calls per minute. */
  perMinute: z.number().min(1).optional(),
})

/**
 * Overrides of the API governor (`governor.ts`): token buckets per call class and a bucket over
 * the whole connection. Absent = the defaults of the account kind (a user account is stricter
 * than a bot).
 */
export const GovernorOverridesSchema = z.object({
  /** Platform reads: history, members, chat info, downloads. */
  read: BucketOverrideSchema.optional(),
  /** Edit, delete, pin, react. */
  edit: BucketOverrideSchema.optional(),
  /** Administration and moderation (native actions that change a chat or a member). */
  admin: BucketOverrideSchema.optional(),
  /** Every call of the connection, sends included. */
  global: BucketOverrideSchema.optional(),
  /** Longest a tool call waits for a park or a bucket before it answers "rate limited". */
  parkWaitMs: z.number().int().min(0).optional(),
  /** Flood waits within the window that open the circuit breaker. */
  floodStorm: z
    .object({
      count: z.number().int().min(1).optional(),
      windowMs: z.number().int().min(1).optional(),
    })
    .optional(),
})
export type GovernorOverrides = z.infer<typeof GovernorOverridesSchema>

export const RateLimitsSchema = z.object({
  /** Smallest gap between two messages to one conversation (ms). */
  chatMinIntervalMs: z.number().int().min(0).default(1000),
  /** Messages per window to one group or channel. */
  groupMax: z.number().int().min(1).default(20),
  groupWindowMs: z.number().int().min(1).default(60_000),
  /** Messages per window over the whole connection. */
  connectionMax: z.number().int().min(1).default(25),
  connectionWindowMs: z.number().int().min(1).default(1000),
  /** Longest an operation may wait in the queue before it is refused. */
  maxWaitMs: z.number().int().min(1).default(120_000),
  /** Attempts for one operation (rate limits and transient errors). */
  maxAttempts: z.number().int().min(1).default(5),
  /** Failures in a row that open the breaker (a `fatal` error opens it at once). */
  breakerFailures: z.number().int().min(1).default(5),
  breakerCooldownMs: z.number().int().min(1).default(300_000),
  /** Limits of the API governor for everything that is not a plain send (see `governor.ts`). */
  governor: GovernorOverridesSchema.optional(),
})
export type RateLimits = z.infer<typeof RateLimitsSchema>

export const ConnectionConfigSchema = z.object({
  connectionId: z.string().min(1).max(80),
  /**
   * The agent that owns this identity: it answers DMs and mentions. Empty (`NO_OWNER`) = no owner:
   * the connection still runs and stores what it sees (observe-only), and the agents allowed on the
   * connection (Connectors page: "all agents" or selected ones) use its tools.
   */
  agentId: z.string(),
  /** `allowlist` (default): only nodes switched on (`enabled`). `open`: every group the identity is in. */
  groupPolicy: z.enum(['allowlist', 'open']).default('allowlist'),
  /** The connection's level of the inheritance: defaults of every node. */
  defaults: ScopePolicySchema.default({}),
  /** `pairing` (default): only linked team members reach the agent by DM (the name is kept for stored configs). */
  dm: z.enum(['pairing', 'disabled']).default('pairing'),
  allowBots: z.boolean().default(false),
  /**
   * Answer a direct message from somebody who is not linked with one short neutral line. Off by
   * default: strangers get silence (they are only recorded under "Not linked yet").
   */
  replyToUnknown: z.boolean().default(false),
  /**
   * Messages that addressed the agent while the server was down (found by the start-up gap fill of
   * a user account) are answered when they are at most `missedWindowMinutes` old. Default on.
   */
  replyMissed: z.boolean().default(true),
  missedWindowMinutes: z.number().int().min(1).max(720).default(30),
  botLoopGuard: z
    .object({
      maxEvents: z.number().int().min(1).default(20),
      windowMs: z.number().int().min(1).default(300_000),
      cooldownMs: z.number().int().min(1).default(600_000),
    })
    .default({ maxEvents: 20, windowMs: 300_000, cooldownMs: 600_000 }),
  /**
   * Team members (the member ids pairing links accounts to) who may answer any approval of this
   * connection from a chat, besides the member who triggered the turn. The team example has one
   * principal, `owner`.
   */
  admins: z.array(z.string().min(1)).default(['owner']),
  /**
   * The people directory (L6): the role of somebody who is neither in the directory nor linked to
   * a team member (default `guest`), and per-role tool policy overrides (deny wins).
   */
  people: z
    .object({
      defaultRole: RoleSchema.default('guest'),
      policy: RolePoliciesSchema,
    })
    .default({ defaultRole: 'guest', policy: {} }),
  /** An approval announced in a chat that nobody answers is declined after this long (default 24 h). */
  approvalTtlMs: z.number().int().min(60_000).default(86_400_000),
  /**
   * A post an owner or admin just asked for in this chat (same chat, people named in their message)
   * runs without a second "ya" (`gateway.directInstruction`). Default on; destructive actions and
   * anything the model chose on its own still ask.
   */
  directInstructions: z.boolean().default(true),
  /** Observed messages injected into the next wake (default 50). */
  historyLimit: z.number().int().min(1).max(200).default(50),
  rate: RateLimitsSchema.default(RateLimitsSchema.parse({})),
})
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>
export type ConnectionConfigInput = z.input<typeof ConnectionConfigSchema>

export const DEFAULT_RETENTION_DAYS = 30
export const NO_REPLY = 'NO_REPLY'

/** Where a resolved value came from. */
export interface ScopeOrigin {
  from: 'node' | 'ancestor' | 'connection' | 'default'
  /** The node that set it (`node` and `ancestor`). */
  nodeId?: string
}

/** The resolved settings of one node. */
export interface ResolvedScope {
  allowed: boolean
  agentId: string
  wake: 'mention' | 'always' | 'never'
  implicit: { reply: boolean; alias: boolean; ownTopic: boolean }
  aliases: string[]
  ignoreWhenOthersMentioned: boolean
  delivery: 'final_text' | 'message_tool'
  quote: 'first' | 'off'
  ack: string | false
  retentionDays: number
  label: string | undefined
  observe: boolean
  sessionScope: 'node' | 'room'
  redactOnDelete: boolean
  proactive: Required<Omit<ProactivePolicy, 'quietHours'>> & {
    quietHours: ProactivePolicy['quietHours']
  }
  /** The role of an unknown person here (`undefined` = the connection's default). */
  defaultRole: 'guest' | 'member' | undefined
  replyStyle: 'brief' | 'normal' | 'detailed' | undefined
  /** The channel overlay of the persona (tone, language, length), inherited. */
  personaOverlay: string | undefined
  /** A feed for its agent (wake always, tool delivery, the agent's own permissions). */
  feed: boolean
  /** Copies from here are only recorded. */
  copyTrial: boolean
  /** The node is a thread that has its own agent entry (an "own topic" wake). */
  ownTopic: boolean
  /** Per setting, which level decided it (for the Channels page). */
  origin: Partial<Record<keyof ScopePolicy, ScopeOrigin>>
}

/** A node with the settings stored on it. */
export interface ScopeNode {
  node: Pick<NodeRow, 'id' | 'kind'>
  settings: ScopePolicy
}

/**
 * Fold the settings of a node and its ancestors (given root first, the node last), the
 * connection's defaults and the product's defaults into one policy. The node beats its parent
 * beats the connection beats the defaults.
 */
export function resolveScope(config: ConnectionConfig, chain: readonly ScopeNode[]): ResolvedScope {
  const leaf = chain.at(-1)
  const isDirect = leaf?.node.kind === 'direct'
  const origin: ResolvedScope['origin'] = {}
  const pick = <K extends keyof ScopePolicy>(key: K): ScopePolicy[K] | undefined => {
    const own = (OWN_KEYS as readonly string[]).includes(key)
    for (let i = chain.length - 1; i >= 0; i--) {
      const level = chain[i] as ScopeNode
      if (own && i !== chain.length - 1) break
      const v = level.settings[key]
      if (v !== undefined) {
        origin[key] = {
          from: i === chain.length - 1 ? 'node' : 'ancestor',
          nodeId: level.node.id,
        }
        return v
      }
    }
    if (own) return undefined
    const d = config.defaults[key]
    if (d !== undefined) {
      origin[key] = { from: 'connection' }
      return d
    }
    return undefined
  }
  const fallback = <T>(key: keyof ScopePolicy, value: T): T => {
    if (origin[key] === undefined) origin[key] = { from: 'default' }
    return value
  }
  const explicit = pick('enabled')
  const allowed =
    explicit !== undefined
      ? explicit
      : isDirect
        ? config.dm !== 'disabled'
        : config.groupPolicy === 'open'
  fallback('enabled', allowed)
  const implicit = pick('implicit')
  const own = leaf?.settings
  const feed = pick('feed') ?? fallback('feed', false)
  return {
    allowed,
    agentId: pick('agentId') ?? fallback('agentId', config.agentId),
    // a feed wakes on every message and never posts its final text
    wake: feed ? 'always' : (pick('wake') ?? fallback('wake', 'mention' as const)),
    implicit: {
      reply: implicit?.reply ?? true,
      alias: implicit?.alias ?? true,
      ownTopic: implicit?.ownTopic ?? true,
    },
    aliases: pick('aliases') ?? [],
    ignoreWhenOthersMentioned:
      pick('ignoreWhenOthersMentioned') ?? fallback('ignoreWhenOthersMentioned', true),
    delivery: feed
      ? 'message_tool'
      : (pick('delivery') ?? fallback('delivery', 'final_text' as const)),
    quote: pick('quote') ?? fallback('quote', isDirect ? ('off' as const) : ('first' as const)),
    ack: feed ? false : (pick('ack') ?? fallback('ack', '👀')),
    retentionDays: pick('retentionDays') ?? fallback('retentionDays', DEFAULT_RETENTION_DAYS),
    label: pick('label'),
    observe: pick('observe') ?? fallback('observe', true),
    sessionScope: pick('sessionScope') ?? fallback('sessionScope', 'node' as const),
    redactOnDelete: pick('redactOnDelete') ?? fallback('redactOnDelete', false),
    proactive: { ...DEFAULT_PROACTIVE, ...(pick('proactive') ?? fallback('proactive', {})) },
    defaultRole: pick('defaultRole'),
    replyStyle: pick('replyStyle'),
    personaOverlay: pick('personaOverlay'),
    feed,
    copyTrial: pick('copyTrial') ?? fallback('copyTrial', false),
    ownTopic: leaf?.node.kind === 'thread' && own?.agentId !== undefined,
    origin,
  }
}

/** Text with no letter and no digit (emoji, punctuation): a reaction typed as a message. */
export const isOnlyEmoji = (text: string): boolean =>
  text.trim() !== '' && !/[\p{L}\p{N}]/u.test(text)
/** Emoji that answer an approval ("ya" / "tidak"): never ignored. */
const ANSWER_EMOJI = /^(👍|✅|👌|❌|👎|🚫)$/u

export type WakeDecision =
  | { action: 'wake'; reason: string }
  | { action: 'observe'; reason: string }

/** What `decideWake` looks at of a message. */
export interface Addressable {
  text: string
  signals: InboundSignals
}

/**
 * What a message in an allowed group or channel does: wake the agent, or only be observed.
 * DMs are decided by the gateway (pairing) before this runs.
 */
export function decideWake(event: Addressable, scope: ResolvedScope, self: Identity): WakeDecision {
  if (scope.wake === 'never') return { action: 'observe', reason: 'wake is never here' }
  if (scope.wake === 'always') return { action: 'wake', reason: 'wake is always here' }
  const s = event.signals
  // a laugh or a sticker-like emoji in reply to the agent is a reaction, not a request (the
  // approval emojis stay: they answer a pending request)
  if (
    s.replyToSelf &&
    !s.mentionedSelf &&
    isOnlyEmoji(event.text) &&
    !ANSWER_EMOJI.test(event.text.trim())
  ) {
    return { action: 'observe', reason: 'a reply with only an emoji' }
  }
  if (s.replyToSelf && scope.implicit.reply) return { action: 'wake', reason: 'reply to the agent' }
  const othersOnly = s.mentionedOthers === true && !s.mentionedSelf
  if (othersOnly && scope.ignoreWhenOthersMentioned) {
    return { action: 'observe', reason: 'mentions someone else' }
  }
  if (s.mentionedSelf) return { action: 'wake', reason: 'mentioned' }
  if (s.command !== undefined) return { action: 'wake', reason: 'command' }
  if (scope.implicit.alias && matchesAlias(event.text, scope.aliases, self)) {
    return { action: 'wake', reason: 'alias' }
  }
  if (scope.implicit.ownTopic && scope.ownTopic) return { action: 'wake', reason: 'own topic' }
  return { action: 'observe', reason: 'not addressed' }
}

/** Whole-word, case-insensitive match of an alias (or the identity's own name). */
export function matchesAlias(text: string, aliases: readonly string[], self: Identity): boolean {
  const words = [...aliases, ...(self.username === undefined ? [] : [`@${self.username}`])]
  const lower = text.toLowerCase()
  for (const word of words) {
    const w = word.toLowerCase()
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^\\p{L}\\p{N}_@])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(lower)) {
      return true
    }
  }
  return false
}

/** The tool name of a native action: `<platform>_<action>` (the same rule everywhere). */
export const nativeToolName = (platform: string, action: string): string => {
  const safe = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return `${safe(platform)}_${safe(action)}`
}

/**
 * Split `text` into messages of at most `max` characters, breaking at the last newline (then the
 * last space) inside the limit, hard-cutting only a line with no break at all.
 */
export function splitText(text: string, max: number): string[] {
  const limit = Math.max(1, max)
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n')
    if (cut < limit / 4) {
      const space = window.lastIndexOf(' ')
      if (space > cut) cut = space
    }
    if (cut < limit / 4) cut = limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
    if (cut === limit) rest = rest.replace(/^ +/, '')
  }
  if (rest.trim() !== '' || out.length === 0) out.push(rest)
  return out.filter((chunk) => chunk !== '')
}

/** The sender label of a user turn: `[Ana Putri @ana]`; a mapped employee is marked. */
export function senderLabel(sender: Identity, member?: string): string {
  const name = sender.name ?? sender.username ?? sender.id
  const handle =
    sender.username !== undefined && sender.username !== name ? ` @${sender.username}` : ''
  const bot = sender.isBot === true ? ' (bot)' : ''
  const mapped = member === undefined ? '' : ' (team member)'
  return `${name}${handle}${bot}${mapped}`
}

/** Tags a message could use to break out of the frame it is shown in. */
export const neutralize = (text: string): string => text.replace(/</g, '&lt;')

/**
 * Bot loop guard: more than `maxEvents` events from bots in one conversation inside `windowMs`
 * puts the conversation in a cooldown of `cooldownMs` during which bot events are dropped.
 */
export function createLoopGuard(options: {
  maxEvents: number
  windowMs: number
  cooldownMs: number
  now?: () => number
}): { admit(key: string): boolean; coolingDown(key: string): boolean } {
  const now = options.now ?? Date.now
  const seen = new Map<string, number[]>()
  const until = new Map<string, number>()
  return {
    coolingDown(key) {
      const t = until.get(key)
      return t !== undefined && t > now()
    },
    admit(key) {
      const at = now()
      const cool = until.get(key)
      if (cool !== undefined) {
        if (cool > at) return false
        until.delete(key)
        seen.delete(key)
      }
      const times = (seen.get(key) ?? []).filter((t) => t > at - options.windowMs)
      times.push(at)
      seen.set(key, times)
      if (times.length > options.maxEvents) {
        until.set(key, at + options.cooldownMs)
        return false
      }
      return true
    },
  }
}

const SECRET_KEY =
  /(token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|bearer|private)/i
/** Shapes of credentials that may sit in a value: bot tokens, `sk-` keys, bearer headers, JWTs. */
const SECRET_VALUE =
  /(\b\d{6,}:[A-Za-z0-9_-]{25,}\b|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g
/** Fields that say what is done and where, in the order they read best. */
const PRIORITY_KEYS = [
  'action',
  'connection',
  'conversation',
  'chat_id',
  'chatId',
  'topic',
  'member',
  'to',
  'path',
  'url',
  'command',
  'name',
  'title',
  'subject',
  'text',
  'message',
  'body',
  'content',
  'query',
]

const scalarText = (value: unknown, max: number): string | undefined => {
  if (typeof value === 'string') {
    const flat = value.replace(SECRET_VALUE, '[hidden]').replace(/\s+/g, ' ').trim()
    return flat === '' ? undefined : clipText(flat, max)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  return undefined
}

const clipText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * A short human summary of a tool call's input for an approval request in a chat: a few
 * `key: value` lines (what and where first), long values clipped, anything that looks like a secret
 * hidden. Plain text; the adapter escapes it for its platform. Empty when there is nothing to say.
 */
export function summarizeToolInput(input: unknown, options: { maxFields?: number } = {}): string {
  const maxFields = options.maxFields ?? 5
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object' || Array.isArray(input)) {
    const text = scalarText(input, 160)
    return text === undefined ? '' : text
  }
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  const ordered = [
    ...PRIORITY_KEYS.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PRIORITY_KEYS.includes(k)),
  ]
  const lines: string[] = []
  let hidden = 0
  for (const key of ordered) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (SECRET_KEY.test(key)) {
      hidden++
      continue
    }
    const text = scalarText(value, 160)
    if (text === undefined) {
      if (typeof value === 'object') lines.push(`${key}: (details in the web app)`)
      continue
    }
    if (lines.length >= maxFields) {
      hidden++
      continue
    }
    lines.push(`${key}: ${text}`)
  }
  if (hidden > 0) lines.push(`(+${hidden} more field${hidden === 1 ? '' : 's'} not shown)`)
  return lines.join('\n')
}

/** `agentId` of a connection that runs without an owning agent. */
export const NO_OWNER = ''
