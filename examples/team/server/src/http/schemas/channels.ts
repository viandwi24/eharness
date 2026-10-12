import { z } from '@hono/zod-openapi'

const state = z.enum([
  'unbound',
  'disabled',
  'starting',
  'running',
  'needs-auth',
  'webhook',
  'error',
  'stopped',
  'lease',
])
const wake = z.enum(['mention', 'always', 'never'])
const delivery = z.enum(['final_text', 'message_tool'])

export const ChannelPolicySchema = z
  .object({
    enabled: z.boolean().openapi({ description: '`false` takes the chat out of the allowlist.' }),
    agentId: z.string().optional(),
    wake: wake.optional(),
    delivery: delivery.optional(),
    retentionDays: z.number().int().optional(),
  })
  .openapi('ChannelPolicy')

export const ChannelBindingSchema = z
  .object({
    agentId: z.string(),
    groupPolicy: z.enum(['allowlist', 'open']),
    dm: z.enum(['pairing', 'disabled']),
    allowBots: z.boolean(),
    replyToUnknown: z.boolean().openapi({
      description:
        'Answer a direct message from somebody who is not linked with one short neutral line. Off (default): strangers get silence.',
    }),
    admins: z.array(z.string()),
    historyLimit: z.number().int(),
    defaults: z.object({
      wake: wake.optional(),
      delivery: delivery.optional(),
      retentionDays: z.number().int().optional(),
    }),
  })
  .openapi('ChannelBinding')

export const ChannelAccountSchema = z
  .object({
    accountId: z.string().optional(),
    username: z.string().optional(),
    phone: z.string().optional().openapi({ description: 'Masked, never the full number.' }),
    limits: z.object({
      dmDailyMax: z.number().int(),
      dailyMax: z.number().int(),
      adminLogEveryMs: z.number().int(),
      chatMinIntervalMs: z.number().int(),
      groupMax: z.number().int(),
      groupWindowMs: z.number().int(),
      connectionMax: z.number().int(),
      connectionWindowMs: z.number().int(),
    }),
    today: z.object({ dm: z.number().int(), all: z.number().int() }),
    floods: z.object({ lastAt: z.number().int().optional(), parkedChats: z.number().int() }),
    pausedUntil: z.number().int().optional(),
    source: z
      .string()
      .openapi({ description: 'The big-data source id of the observe-only chats.' }),
    events: z.object({
      live: z.number().int(),
      lastEventAt: z.number().int().optional(),
      unresolvedDeletes: z.number().int(),
    }),
    warnings: z.array(z.string()),
  })
  .openapi('ChannelAccount')

export const ChannelAccountChatSchema = z
  .object({
    selected: z.boolean(),
    admin: z.boolean(),
    backfill: z.object({
      days: z.number().int().nullable(),
      state: z.string(),
      oldestAt: z.number().int().optional(),
      count: z.number().int(),
      error: z.string().optional(),
      parkedUntil: z.number().int().optional(),
    }),
    adminLog: z.object({
      enabled: z.boolean(),
      lastAt: z.number().int().optional(),
      count: z.number().int(),
      error: z.string().optional(),
    }),
  })
  .openapi('ChannelAccountChat')

export const ChannelConnectionSchema = z
  .object({
    transport: z.enum(['bot', 'user']).optional(),
    account: ChannelAccountSchema.optional(),
    id: z.string().openapi({ description: 'The connector connection id.' }),
    platform: z.enum(['telegram']),
    label: z.string(),
    accountLabel: z.string().optional(),
    connectionStatus: z.string(),
    statusMessage: z.string().optional(),
    enabled: z.boolean(),
    runtime: z.object({
      state,
      message: z.string().optional(),
      since: z.number().int(),
    }),
    bot: z
      .object({
        id: z.number().int(),
        username: z.string(),
        name: z.string(),
        canReadAllGroupMessages: z.boolean(),
        guidance: z.string().openapi({ description: 'What privacy mode means for this bot.' }),
      })
      .optional(),
    webhookUrl: z.string().optional(),
    binding: ChannelBindingSchema.nullable(),
    counts: z.object({
      chats: z.number().int(),
      linked: z.number().int(),
      unlinked: z.number().int().openapi({
        description: 'People who wrote and are not linked yet (ignored ones excluded).',
      }),
      outboxPending: z.number().int(),
      outboxFailed: z.number().int(),
    }),
    breaker: z
      .object({ open: z.boolean(), until: z.number().int(), reason: z.string() })
      .optional(),
  })
  .openapi('ChannelConnection')

export const ChannelConnectionListSchema = z
  .object({ items: z.array(ChannelConnectionSchema) })
  .openapi('ChannelConnectionList')

export const ChannelChatSchema = z
  .object({
    chatId: z.string(),
    kind: z.enum(['dm', 'group', 'channel']),
    title: z.string(),
    username: z.string().optional(),
    forum: z.boolean(),
    topics: z.array(
      z.object({ id: z.string(), name: z.string(), policy: ChannelPolicySchema.nullable() }),
    ),
    botStatus: z.string().optional(),
    account: ChannelAccountChatSchema.optional(),
    canPost: z.boolean().optional(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    policy: ChannelPolicySchema.nullable(),
    effective: z.object({
      allowed: z.boolean(),
      wake,
      delivery,
      retentionDays: z.number().int(),
    }),
  })
  .openapi('ChannelChat')

export const ChannelChatListSchema = z
  .object({ items: z.array(ChannelChatSchema) })
  .openapi('ChannelChatList')

export const ChannelLinkSchema = z
  .object({
    peerId: z.string(),
    memberId: z.string(),
    name: z.string().optional(),
    linkedAt: z.number().int(),
  })
  .openapi('ChannelLink')

export const ChannelLinkListSchema = z
  .object({ items: z.array(ChannelLinkSchema) })
  .openapi('ChannelLinkList')

export const ChannelBindBodySchema = z
  .object({
    agentId: z.string().min(1),
    groupPolicy: z.enum(['allowlist', 'open']).optional(),
    dm: z.enum(['pairing', 'disabled']).optional(),
    allowBots: z.boolean().optional(),
    replyToUnknown: z.boolean().optional(),
    admins: z.array(z.string().min(1)).optional(),
    historyLimit: z.number().int().min(1).max(200).optional(),
    defaults: z
      .object({
        wake: wake.optional(),
        delivery: delivery.optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      })
      .optional(),
  })
  .openapi('ChannelBindBody')

export const ChannelPolicyBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    agentId: z.string().min(1).nullable().optional(),
    wake: wake.nullable().optional(),
    delivery: delivery.nullable().optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .openapi('ChannelPolicyBody')

export const ChannelMemberSchema = z
  .object({ id: z.string(), name: z.string() })
  .openapi('ChannelMember')
export const ChannelMemberListSchema = z
  .object({ items: z.array(ChannelMemberSchema) })
  .openapi('ChannelMemberList')

export const ChannelUnlinkedSchema = z
  .object({
    peerId: z.string().openapi({ description: 'The platform user id.' }),
    name: z.string().optional(),
    username: z.string().optional(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    messageCount: z.number().int(),
    ignored: z.boolean(),
  })
  .openapi('ChannelUnlinked')
export const ChannelUnlinkedListSchema = z
  .object({ items: z.array(ChannelUnlinkedSchema) })
  .openapi('ChannelUnlinkedList')
export const ChannelUnlinkedQuery = z.object({
  includeIgnored: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Also list the people marked as ignored.' }),
})

export const ChannelLinkBodySchema = z
  .object({
    peerId: z
      .string()
      .regex(/^\d{1,20}$/, 'a numeric Telegram user id')
      .openapi({ description: 'The numeric Telegram user id of the person.' }),
    memberId: z.string().min(1).max(64),
    name: z.string().min(1).max(80).optional(),
  })
  .openapi('ChannelLinkBody')

export const ChannelIgnoreBodySchema = z
  .object({ ignored: z.boolean() })
  .openapi('ChannelIgnoreBody')

const kind = z.enum(['dm', 'group', 'channel'])
export const ChannelInboxConversationSchema = z
  .object({
    conversationId: z.string(),
    kind,
    title: z.string(),
    container: z.string(),
    topic: z.string().optional(),
    agentId: z.string(),
    allowed: z.boolean().openapi({ description: 'The conversation passes the allowlist now.' }),
    woke: z.number().int().openapi({ description: 'Messages that woke the agent.' }),
    observed: z.number().int().openapi({ description: 'Messages stored as context only.' }),
    dropped: z.number().int().openapi({ description: 'Messages the gateway dropped.' }),
    firstAt: z.number().int(),
    lastAt: z.number().int(),
    preview: z
      .object({
        text: z.string(),
        at: z.number().int(),
        self: z.boolean(),
        sender: z.string().optional(),
      })
      .optional(),
    sessionId: z.string().optional(),
    threadId: z.string().optional().openapi({
      description: "The agent's thread of this conversation, once it woke the agent.",
    }),
  })
  .openapi('ChannelInboxConversation')

export const ChannelInboxPageSchema = z
  .object({
    items: z.array(ChannelInboxConversationSchema),
    next: z.string().optional().openapi({ description: 'Pass as `cursor` for the next page.' }),
  })
  .openapi('ChannelInboxPage')

export const ChannelLogMessageSchema = z
  .object({
    id: z.string(),
    platformId: z.string(),
    at: z.number().int(),
    self: z.boolean().openapi({ description: 'Sent by this connection (the agent).' }),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    text: z.string(),
    attachments: z.array(
      z.object({
        name: z.string().optional(),
        mediaType: z.string().optional(),
        size: z.number().int().optional(),
      }),
    ),
    replyTo: z
      .object({
        messageId: z.string(),
        senderName: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    editedAt: z.number().int().optional(),
    deletedAt: z.number().int().optional(),
    edits: z.array(z.object({ at: z.number().int(), text: z.string() })).optional(),
    disposition: z.enum(['woke', 'observed']).optional(),
    approval: z
      .object({
        kind: z.enum(['approval', 'question']),
        toolName: z.string(),
        status: z.enum(['open', 'answered']),
        outcome: z.string().optional(),
        answeredBy: z.string().optional(),
        answeredAt: z.number().int().optional(),
      })
      .optional(),
  })
  .openapi('ChannelLogMessage')

export const ChannelConversationLogSchema = z
  .object({
    conversation: ChannelInboxConversationSchema,
    items: z.array(ChannelLogMessageSchema).openapi({ description: 'Oldest first.' }),
    next: z
      .string()
      .optional()
      .openapi({ description: 'Pass as `before` to load older messages; absent at the start.' }),
  })
  .openapi('ChannelConversationLog')

export const ChannelInboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
})
export const ChannelMessagesQuery = z.object({
  conversationId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  before: z.string().optional(),
})

export const CHANNEL_EVENT_TYPES = [
  'woke',
  'observed',
  'dropped',
  'reply-queued',
  'reply-sent',
  'reply-retried',
  'reply-failed',
  'approval-posted',
  'approval-answered',
  'breaker-opened',
  'needs-auth',
] as const

export const ChannelActivitySchema = z
  .object({
    id: z.string(),
    at: z.number().int(),
    type: z.enum(CHANNEL_EVENT_TYPES),
    reason: z.string().optional().openapi({
      description:
        'A drop reason (`unlinked-sender`, `chat-not-allowed`, `dm-disabled`, `bot-sender`, `loop-guard`, `duplicate`, `agent-unavailable`, `not-authorized`), a wake reason, or a short note. Never message text.',
    }),
    conversationId: z.string().optional(),
    conversationTitle: z.string().optional(),
    peerId: z.string().optional(),
    peerName: z.string().optional(),
    platformId: z.string().optional(),
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .openapi('ChannelActivity')

export const ChannelActivityPageSchema = z
  .object({
    items: z.array(ChannelActivitySchema).openapi({ description: 'Newest first.' }),
    next: z.string().optional().openapi({ description: 'Pass as `before` for older events.' }),
  })
  .openapi('ChannelActivityPage')

export const ChannelActivityQuery = z.object({
  type: z.enum(CHANNEL_EVENT_TYPES).optional(),
  conversationId: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const ChannelIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
})
export const ChannelChatParam = ChannelIdParam.extend({
  chatId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'chatId', in: 'path' } }),
})
export const ChannelLinkParam = ChannelIdParam.extend({
  peerId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'peerId', in: 'path' } }),
})
export const ChannelTopicQuery = z.object({
  topic: z
    .string()
    .optional()
    .openapi({ description: 'A forum topic id: the policy is of the topic.' }),
})

export const ChannelSelectBodySchema = z
  .object({ selected: z.boolean() })
  .openapi('ChannelSelectBody')

export const ChannelBackfillBodySchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .nullable()
      .openapi({ description: 'History window in days; `null` = no backfill.' }),
  })
  .openapi('ChannelBackfillBody')

export const ChannelAdminLogBodySchema = z
  .object({ enabled: z.boolean() })
  .openapi('ChannelAdminLogBody')

export const ChannelAdminLogRunSchema = z
  .object({ force: z.boolean().optional() })
  .openapi('ChannelAdminLogRun')

export const ChannelLimitsBodySchema = z
  .object({
    dmDailyMax: z.number().int().min(0).max(1000).optional(),
    dailyMax: z.number().int().min(0).max(5000).optional(),
    adminLogEveryMs: z.number().int().min(60_000).optional(),
    chatMinIntervalMs: z.number().int().min(0).optional(),
    groupMax: z.number().int().min(1).optional(),
    groupWindowMs: z.number().int().min(1).optional(),
    connectionMax: z.number().int().min(1).optional(),
    connectionWindowMs: z.number().int().min(1).optional(),
  })
  .openapi('ChannelLimitsBody')
