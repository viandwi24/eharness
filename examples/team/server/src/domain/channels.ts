/**
 * Channels admin views (docs/plans/P41-team-channels.md, phase L3): what the Channels page shows
 * and edits. Plain data; nothing here holds a secret (the bot token never leaves the connection).
 */

export type ChannelPlatform = 'telegram'

export type ChannelRuntimeState =
  | 'unbound'
  | 'disabled'
  | 'starting'
  | 'running'
  | 'needs-auth'
  | 'webhook'
  | 'error'
  | 'stopped'
  /** A user account whose session another process holds (one live client per session). */
  | 'lease'

export interface ChannelPolicy {
  /** `false` takes the chat out of the allowlist. */
  enabled: boolean
  agentId?: string
  wake?: 'mention' | 'always' | 'never'
  delivery?: 'final_text' | 'message_tool'
  retentionDays?: number
}

export interface ChannelBinding {
  agentId: string
  groupPolicy: 'allowlist' | 'open'
  dm: 'pairing' | 'disabled'
  allowBots: boolean
  admins: string[]
  historyLimit: number
  defaults: Pick<ChannelPolicy, 'wake' | 'delivery' | 'retentionDays'>
}

/** What the Channels page shows about a Telegram user account (P41 L4). Never a session or a full phone number. */
export interface ChannelAccountView {
  accountId?: string
  username?: string
  /** Masked: `+62••••1234`. */
  phone?: string
  limits: {
    dmDailyMax: number
    dailyMax: number
    adminLogEveryMs: number
    chatMinIntervalMs: number
    groupMax: number
    groupWindowMs: number
    connectionMax: number
    connectionWindowMs: number
  }
  today: { dm: number; all: number }
  floods: { lastAt?: number; parkedChats: number }
  /** Jobs (backfill) are paused by a flood storm until this time. */
  pausedUntil?: number
  /** The big-data source id of this account's observe-only chats (`ingest_source`). */
  source: string
  events: { live: number; lastEventAt?: number; unresolvedDeletes: number }
  warnings: string[]
}

export interface ChannelAccountChatState {
  /** Chosen for ingest (the account reads and stores this chat). */
  selected: boolean
  admin: boolean
  backfill: {
    days: number | null
    /** `idle` | `queued` | `running` | `parked` | `done` | `error` */
    state: string
    oldestAt?: number
    count: number
    error?: string
    parkedUntil?: number
  }
  adminLog: {
    enabled: boolean
    lastAt?: number
    count: number
    error?: string
  }
}

export interface ChannelConnectionView {
  /** `bot` (Bot API) or `user` (a Telegram user account over MTProto). */
  transport?: 'bot' | 'user'
  account?: ChannelAccountView
  /** The connector connection id. */
  id: string
  platform: ChannelPlatform
  label: string
  accountLabel?: string
  /** Status of the connector connection (`connected`, `needs-auth`, ...). */
  connectionStatus: string
  statusMessage?: string
  enabled: boolean
  runtime: { state: ChannelRuntimeState; message?: string; since: number }
  bot?: {
    id: number
    username: string
    name: string
    canReadAllGroupMessages: boolean
    guidance: string
  }
  webhookUrl?: string
  binding: ChannelBinding | null
  counts: { chats: number; linked: number; outboxPending: number; outboxFailed: number }
  breaker?: { open: boolean; until: number; reason: string }
}

export interface ChannelTopicView {
  id: string
  name: string
  policy: ChannelPolicy | null
}

export interface ChannelChatView {
  chatId: string
  kind: 'dm' | 'group' | 'channel'
  title: string
  username?: string
  forum: boolean
  topics: ChannelTopicView[]
  /** What the bot is in the chat (`member`, `administrator`, `left`, `kicked`, ...). */
  botStatus?: string
  /** User accounts: selection, backfill and admin-log state. */
  account?: ChannelAccountChatState
  canPost?: boolean
  firstSeen: number
  lastSeen: number
  /** The chat's own entry; null = not in the allowlist (or the open policy's defaults). */
  policy: ChannelPolicy | null
  /** What applies right now (the connection's defaults filled in). */
  effective: {
    allowed: boolean
    wake: 'mention' | 'always' | 'never'
    delivery: 'final_text' | 'message_tool'
    retentionDays: number
  }
}

export interface ChannelLinkView {
  peerId: string
  memberId: string
  name?: string
  linkedAt: number
}

export interface ChannelPairingIssued {
  memberId: string
  /** The deep link to open in Telegram; shown once. */
  link: string
  command: string
  expiresAt: number
}

export interface ChannelBindInput {
  agentId: string
  groupPolicy?: 'allowlist' | 'open'
  dm?: 'pairing' | 'disabled'
  allowBots?: boolean
  admins?: string[]
  historyLimit?: number
  defaults?: Pick<ChannelPolicy, 'wake' | 'delivery' | 'retentionDays'>
}

export interface ChannelPolicyInput {
  enabled?: boolean
  /** `null` clears the override (back to the connection's agent). */
  agentId?: string | null
  wake?: 'mention' | 'always' | 'never' | null
  delivery?: 'final_text' | 'message_tool' | null
  retentionDays?: number | null
}

export interface ChannelLimitsInput {
  dmDailyMax?: number
  dailyMax?: number
  adminLogEveryMs?: number
  chatMinIntervalMs?: number
  groupMax?: number
  groupWindowMs?: number
  connectionMax?: number
  connectionWindowMs?: number
}
