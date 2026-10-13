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

/** What is set on one node itself; everything else is inherited from its parent, the connection or the defaults. */
export interface ChannelPolicy {
  /** `false` takes the node out of the allowlist, `true` puts it in. */
  enabled: boolean
  agentId?: string
  wake?: 'mention' | 'always' | 'never'
  delivery?: 'final_text' | 'message_tool'
  retentionDays?: number
  /** Store the full log of the node (default on). */
  observe?: boolean
  /** `node` (default): own session. `room`: a thread shares the session of its room. */
  sessionScope?: 'node' | 'room'
  /** Drop a message's content when it is deleted on the platform. */
  redactOnDelete?: boolean
  /** What the agent may post here unasked (routines, heartbeat). */
  proactive?: ChannelProactive
  /** Role of an unknown person here (`member` = a trusted internal group). Inherited. */
  defaultRole?: 'guest' | 'member'
  /** Reply length in a group when the persona says nothing. Inherited. */
  replyStyle?: 'brief' | 'normal' | 'detailed'
  /** Tone, language and length of this place for the persona (max 1000 characters). Inherited. */
  personaOverlay?: string
}

export interface ChannelProactive {
  allowed?: boolean
  quietHours?: { from: string; to: string }
  digest?: boolean
  digestMinutes?: number
  maxMentions?: number
}

export type ChannelRole = 'owner' | 'admin' | 'member' | 'guest'

/** One person of the directory (People tab). */
export interface ChannelPersonView {
  peerId: string
  name?: string
  username?: string
  kind: string
  isBot: boolean
  role: ChannelRole
  roleSource: string
  explicit: boolean
  divisions: Array<{ nodeId: string; title: string }>
  memberId?: string
  platformAdmin: Array<{
    nodeId: string
    title: string
    role: 'owner' | 'admin'
    customTitle?: string
  }>
  suggestion?: { role: ChannelRole; reason: string }
  /** What the person asked to be called or how they like answers (a stated preference). */
  note?: string
  firstSeen: number
  lastSeen: number
  /** Hidden from "Not linked yet" (an unlinked person the team chose to ignore). */
  ignored?: boolean
  /** Direct messages this person sent while not linked (a count, never a text). */
  directMessages?: number
}

export interface ChannelReminderView {
  id: string
  connectionId: string
  agentId: string
  nodeId: string
  chatTitle: string
  /** `<chat>/<topic>` (or the chat alone): where it posts, for the Routines page badge. */
  place: string
  /** A reminder made in a web chat thread: the thread (session) it is delivered into. */
  sessionId?: string
  /** The next fire of an active one-time reminder (epoch ms). */
  nextAt?: number
  text: string
  whenText: string
  status: 'active' | 'done' | 'cancelled'
  mentions: string[]
  createdByName?: string
  createdByRole?: string
  createdAt: number
  lastFiredAt?: number
  fireCount: number
  lastError?: string
}

export interface ChannelPeopleSettings {
  defaultRole: ChannelRole
  approvalTtlHours: number
  /** A post an owner or admin just asked for in the chat runs without a second "ya". */
  directInstructions: boolean
}

export interface ChannelBinding {
  agentId: string
  groupPolicy: 'allowlist' | 'open'
  dm: 'pairing' | 'disabled'
  allowBots: boolean
  /** Answer an unlinked person's DM with one neutral line (default off: silence). */
  replyToUnknown: boolean
  admins: string[]
  historyLimit: number
  defaults: Pick<
    ChannelPolicy,
    'wake' | 'delivery' | 'retentionDays' | 'observe' | 'sessionScope' | 'redactOnDelete'
  >
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
  /** What a new account starts with, per limit (the card says "default N"). */
  limitDefaults: ChannelAccountView['limits']
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
  counts: {
    chats: number
    linked: number
    unlinked: number
    outboxPending: number
    outboxFailed: number
  }
  breaker?: { open: boolean; until: number; reason: string }
}

export type ChannelSettingKey =
  | 'enabled'
  | 'agentId'
  | 'wake'
  | 'delivery'
  | 'retentionDays'
  | 'observe'
  | 'sessionScope'
  | 'redactOnDelete'
  | 'proactive'
  | 'defaultRole'
  | 'replyStyle'
  | 'personaOverlay'

/** Where an effective setting comes from. */
export interface ChannelSettingOrigin {
  from: 'node' | 'ancestor' | 'connection' | 'default'
  /** The node that set it (`node` and `ancestor`). */
  nodeId?: string
}

/** A place of a connection (a chat, a channel, a forum topic) with its inherited settings. */
export interface ChannelNodeView {
  /** The node id. */
  id: string
  parentId?: string
  /** The platform's id (opaque). */
  nativeId: string
  kind: 'space' | 'room' | 'thread' | 'direct'
  /** Display badge: a person, a group or a broadcast channel. */
  chatKind: 'dm' | 'group' | 'channel'
  platformType: string
  title: string
  username?: string
  state: 'active' | 'closed' | 'archived' | 'deleted' | 'left'
  /** Has child nodes (a forum). */
  container: boolean
  /** How many topics a forum has (only set on a forum). */
  topics?: number
  /** Messages can be sent and stored here (a forum parent holds none). */
  postable: boolean
  /** What the connection is in the node (`member`, `admin`, `owner`, `none`, `unknown`). */
  member?: string
  canPost?: boolean
  /** User accounts: selection, backfill and admin-log state. */
  account?: ChannelAccountChatState
  firstSeen: number
  lastSeen: number
  /** What is set on this node itself; null = nothing (everything is inherited). */
  policy: ChannelPolicy | null
  /** What applies right now (inherited values filled in). */
  effective: {
    allowed: boolean
    agentId: string
    wake: 'mention' | 'always' | 'never'
    delivery: 'final_text' | 'message_tool'
    retentionDays: number
    observe: boolean
    sessionScope: 'node' | 'room'
    redactOnDelete: boolean
    proactive: Required<Omit<ChannelProactive, 'quietHours'>> & {
      quietHours?: { from: string; to: string }
    }
    /** Role of an unknown person here; absent = the connection's default. */
    defaultRole?: 'guest' | 'member'
    replyStyle?: 'brief' | 'normal' | 'detailed'
    personaOverlay?: string
  }
  /** Where each effective setting comes from. */
  inherited: Partial<Record<ChannelSettingKey, ChannelSettingOrigin>>
}

export interface ChannelLinkView {
  peerId: string
  memberId: string
  name?: string
  linkedAt: number
}

export interface ChannelBindInput {
  agentId: string
  groupPolicy?: 'allowlist' | 'open'
  dm?: 'pairing' | 'disabled'
  allowBots?: boolean
  replyToUnknown?: boolean
  admins?: string[]
  historyLimit?: number
  defaults?: Pick<
    ChannelPolicy,
    'wake' | 'delivery' | 'retentionDays' | 'observe' | 'sessionScope' | 'redactOnDelete'
  >
}

export interface ChannelPolicyInput {
  enabled?: boolean | null
  /** `null` clears the setting (inherit again). */
  agentId?: string | null
  wake?: 'mention' | 'always' | 'never' | null
  delivery?: 'final_text' | 'message_tool' | null
  retentionDays?: number | null
  observe?: boolean | null
  sessionScope?: 'node' | 'room' | null
  redactOnDelete?: boolean | null
  proactive?: ChannelProactive | null
  defaultRole?: 'guest' | 'member' | null
  replyStyle?: 'brief' | 'normal' | 'detailed' | null
  personaOverlay?: string | null
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

/** Somebody who wrote to the connection and is not linked yet (who and how often, never what). */
export interface ChannelUnlinkedView {
  peerId: string
  name?: string
  username?: string
  firstSeen: number
  lastSeen: number
  messageCount: number
  ignored: boolean
}

/** A team member an account can be linked to. */
export interface ChannelMemberView {
  id: string
  name: string
}

export interface ChannelInboxConversationView {
  /** The node id. */
  conversationId: string
  kind: 'dm' | 'group' | 'channel'
  title: string
  container: string
  topic?: string
  parentId?: string
  parentTitle?: string
  agentId: string
  allowed: boolean
  woke: number
  observed: number
  dropped: number
  firstAt: number
  lastAt: number
  preview?: { text: string; at: number; self: boolean; sender?: string }
  sessionId?: string
  threadId?: string
}

export interface ChannelInboxPage {
  items: ChannelInboxConversationView[]
  next?: string
}

export interface ChannelLogMessageView {
  id: string
  platformId: string
  at: number
  self: boolean
  senderId?: string
  senderName?: string
  text: string
  attachments: Array<{ name?: string; mediaType?: string; size?: number }>
  replyTo?: { messageId: string; senderName?: string; text?: string }
  editedAt?: number
  deletedAt?: number
  edits?: Array<{ at: number; text: string }>
  disposition?: 'woke' | 'observed'
  approval?: {
    kind: 'approval' | 'question'
    toolName: string
    status: 'open' | 'answered'
    outcome?: string
    answeredBy?: string
    answeredAt?: number
  }
}

export interface ChannelConversationLog {
  conversation: ChannelInboxConversationView
  /** Oldest first. */
  items: ChannelLogMessageView[]
  next?: string
}

export type ChannelEventKind =
  | 'woke'
  | 'observed'
  | 'dropped'
  | 'reply-queued'
  | 'reply-sent'
  | 'reply-retried'
  | 'reply-failed'
  | 'approval-posted'
  | 'approval-answered'
  | 'breaker-opened'
  | 'needs-auth'
  | 'action'
  | 'read'
  | 'parked'

export interface ChannelActivityView {
  id: string
  at: number
  type: ChannelEventKind
  direction?: 'in' | 'out' | 'system'
  action?: string
  reason?: string
  conversationId?: string
  conversationTitle?: string
  peerId?: string
  peerName?: string
  platformId?: string
  detail?: Record<string, string | number | boolean>
}

export interface ChannelActivityPage {
  items: ChannelActivityView[]
  next?: string
}

export interface ChannelActivityQuery {
  type?: ChannelEventKind
  direction?: 'in' | 'out'
  action?: string
  conversationId?: string
  before?: string
  limit: number
}

// --- server-side tables (P40 channels UI) -----------------------------------------------------------

/** What every table endpoint takes: a search text, a sort, a page. */
export interface TableQuery {
  q?: string
  sort?: string
  order?: 'asc' | 'desc'
  /** 1-based. */
  page: number
  limit: number
}

/** What every table endpoint returns: one page and the number of rows that match the filters. */
export interface TablePage<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export interface ChannelChatsQuery extends TableQuery {
  /** `chat` (default): chats and channels; `topic`: forum topics; `all`: both. */
  level?: 'chat' | 'topic' | 'all'
  /** Only the topics of this chat. */
  parentId?: string
  kind?: 'group' | 'channel'
  state?: 'active' | 'closed' | 'archived' | 'left'
  /** The agent may be used here (the allowlist), or not. */
  allowed?: boolean
  /** The connection is an admin of the chat. */
  admin?: boolean
  /** Accounts: a history window is set. */
  history?: boolean
  /** Accounts: the admin log is read. */
  adminLog?: boolean
}

export interface ChannelPeopleQuery extends TableQuery {
  /** The role the team set in the directory. */
  role?: ChannelRole
  /** Linked to a team member. */
  linked?: boolean
  kind?: string
  ignored?: boolean
}

export interface ChannelInboxTableQuery extends TableQuery {
  kind?: 'dm' | 'group' | 'channel' | 'topic'
}

export interface ChannelActivityTableQuery extends TableQuery {
  type?: ChannelEventKind
  direction?: 'in' | 'out'
  action?: string
  conversationId?: string
  peerId?: string
}

export interface ChannelRemindersQuery extends TableQuery {
  status?: 'active' | 'done' | 'cancelled'
  nodeId?: string
}
