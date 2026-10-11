/**
 * Channel policy: the configuration of a connection and the pure rules built on it (scope
 * resolution, wake decision, text splitting, session ids, the bot loop guard). No I/O.
 */
import { z } from 'zod'
import type { ConversationRef, Identity, InboundEvent } from './types.ts'

const wake = z.enum(['mention', 'always', 'never'])
const delivery = z.enum(['final_text', 'message_tool'])

/** One scope of a connection: the defaults, a group, or a topic of a group. All fields optional. */
export const ScopePolicySchema = z.object({
  /** `false` takes the scope out of the allowlist. */
  enabled: z.boolean().optional(),
  /** The agent that answers here (a group or topic may route to another agent). */
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
  /** Days the channel log keeps the messages of this scope. */
  retentionDays: z.number().int().min(1).max(3650).optional(),
  /** A name for the thread list when the platform gives none. */
  label: z.string().max(80).optional(),
})
export type ScopePolicy = z.infer<typeof ScopePolicySchema>

export const GroupPolicySchema = ScopePolicySchema.extend({
  topics: z.record(z.string(), ScopePolicySchema).optional(),
})
export type GroupPolicy = z.infer<typeof GroupPolicySchema>

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
})
export type RateLimits = z.infer<typeof RateLimitsSchema>

export const ConnectionConfigSchema = z.object({
  connectionId: z.string().min(1).max(80),
  /** The agent this identity belongs to. */
  agentId: z.string().min(1),
  /** `allowlist` (default): only the groups listed. `open`: every group the identity is in. */
  groupPolicy: z.enum(['allowlist', 'open']).default('allowlist'),
  /** Keyed by the container id of the group or channel; `*` is the default of an open policy. */
  groups: z.record(z.string(), GroupPolicySchema).default({}),
  /** Defaults of every scope. */
  defaults: ScopePolicySchema.default({}),
  /** `pairing` (default): only mapped employees reach the agent by DM. */
  dm: z.enum(['pairing', 'disabled']).default('pairing'),
  allowBots: z.boolean().default(false),
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
  /** Observed messages injected into the next wake (default 50). */
  historyLimit: z.number().int().min(1).max(200).default(50),
  rate: RateLimitsSchema.default(RateLimitsSchema.parse({})),
})
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>
export type ConnectionConfigInput = z.input<typeof ConnectionConfigSchema>

export const DEFAULT_RETENTION_DAYS = 30
export const NO_REPLY = 'NO_REPLY'

/** The resolved policy of one conversation. */
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
  /** The topic has its own entry that routes it to an agent (an "own topic" wake). */
  ownTopic: boolean
}

const pick = <K extends keyof ScopePolicy>(
  key: K,
  ...scopes: Array<ScopePolicy | undefined>
): ScopePolicy[K] | undefined => {
  for (const scope of scopes) if (scope?.[key] !== undefined) return scope[key]
  return undefined
}

/** Group, topic and defaults folded into one policy; topic beats group beats defaults. */
export function resolveScope(config: ConnectionConfig, ref: ConversationRef): ResolvedScope {
  const group = config.groups[ref.container] ?? config.groups['*']
  const topic = ref.topic === undefined ? undefined : group?.topics?.[ref.topic]
  const d = config.defaults
  const chain = [topic, group, d]
  const isDm = ref.kind === 'dm'
  const listed = group !== undefined && group.enabled !== false
  const allowed =
    topic?.enabled === false
      ? false
      : isDm
        ? config.dm !== 'disabled'
        : config.groupPolicy === 'open'
          ? group?.enabled !== false
          : listed
  const implicit = pick('implicit', ...chain)
  return {
    allowed,
    agentId: pick('agentId', ...chain) ?? config.agentId,
    wake: pick('wake', ...chain) ?? 'mention',
    implicit: {
      reply: implicit?.reply ?? true,
      alias: implicit?.alias ?? true,
      ownTopic: implicit?.ownTopic ?? true,
    },
    aliases: pick('aliases', ...chain) ?? [],
    ignoreWhenOthersMentioned: pick('ignoreWhenOthersMentioned', ...chain) ?? true,
    delivery: pick('delivery', ...chain) ?? 'final_text',
    quote: pick('quote', ...chain) ?? (isDm ? 'off' : 'first'),
    ack: pick('ack', ...chain) ?? '👀',
    retentionDays: pick('retentionDays', ...chain) ?? DEFAULT_RETENTION_DAYS,
    label: pick('label', ...chain),
    ownTopic: topic?.agentId !== undefined,
  }
}

export type WakeDecision =
  | { action: 'wake'; reason: string }
  | { action: 'observe'; reason: string }

type Addressable = Extract<InboundEvent, { type: 'message' }>

/**
 * What a message in an allowed group or channel does: wake the agent, or only be observed.
 * DMs are decided by the gateway (pairing) before this runs.
 */
export function decideWake(event: Addressable, scope: ResolvedScope, self: Identity): WakeDecision {
  if (scope.wake === 'never') return { action: 'observe', reason: 'wake is never here' }
  if (scope.wake === 'always') return { action: 'wake', reason: 'wake is always here' }
  const s = event.signals
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

/**
 * `channel:<connectionId>:<conversation id>`: one session per conversation and agent. When the
 * agent of a conversation changes, the new agent gets the next generation (`...#2`): it never
 * continues the session of the agent before it.
 */
export const channelSessionId = (
  connectionId: string,
  conversationId: string,
  generation = 0,
): string =>
  `channel:${connectionId}:${conversationId}${generation > 0 ? `#${generation + 1}` : ''}`

/** The tool name of a native action: `<platform>_<action>` (the same rule everywhere). */
export const nativeToolName = (platform: string, action: string): string => {
  const safe = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return `${safe(platform)}_${safe(action)}`
}

export const isChannelSession = (sessionId: string): boolean => sessionId.startsWith('channel:')

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
