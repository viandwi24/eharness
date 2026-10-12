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

const sessionScope = z.enum(['node', 'room'])

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const proactiveShape = z.object({
  allowed: z.boolean().optional().openapi({
    description: 'May the agent post here without being asked (routines, heartbeat). Default off.',
  }),
  quietHours: z.object({ from: clock, to: clock }).optional().openapi({
    description: 'HH:MM in the team timezone; proactive posts are held during this window.',
  }),
  digest: z.boolean().optional(),
  digestMinutes: z.number().int().min(5).max(1440).optional(),
  maxMentions: z.number().int().min(0).max(20).optional(),
})
export const ChannelProactiveSchema = proactiveShape
const proactiveEffective = z.object({
  allowed: z.boolean(),
  digest: z.boolean(),
  digestMinutes: z.number().int(),
  maxMentions: z.number().int(),
  quietHours: z.object({ from: z.string(), to: z.string() }).optional(),
})

export const ChannelPolicySchema = z
  .object({
    enabled: z.boolean().openapi({
      description: '`false` takes the node out of the allowlist, `true` puts it in.',
    }),
    agentId: z.string().optional(),
    wake: wake.optional(),
    delivery: delivery.optional(),
    retentionDays: z.number().int().optional(),
    observe: z.boolean().optional().openapi({
      description: 'Store the full log of the node (default on).',
    }),
    sessionScope: sessionScope.optional().openapi({
      description:
        '`node` (default): own session. `room`: a thread shares the session of its room.',
    }),
    redactOnDelete: z.boolean().optional().openapi({
      description: "Drop a message's content when it is deleted on the platform.",
    }),
    proactive: ChannelProactiveSchema.optional(),
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
      observe: z.boolean().optional(),
      sessionScope: sessionScope.optional(),
      redactOnDelete: z.boolean().optional(),
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

const settingKey = z.enum([
  'enabled',
  'agentId',
  'wake',
  'delivery',
  'retentionDays',
  'observe',
  'sessionScope',
  'redactOnDelete',
  'proactive',
])

export const ChannelNodeSchema = z
  .object({
    id: z.string().openapi({ description: 'The node id.' }),
    parentId: z
      .string()
      .optional()
      .openapi({ description: 'The node this one is a child of (a topic of a forum).' }),
    nativeId: z.string().openapi({ description: "The platform's id (opaque)." }),
    kind: z.enum(['space', 'room', 'thread', 'direct']),
    chatKind: z.enum(['dm', 'group', 'channel']),
    platformType: z.string(),
    title: z.string(),
    username: z.string().optional(),
    state: z.enum(['active', 'closed', 'archived', 'deleted', 'left']),
    container: z.boolean().openapi({ description: 'Has child nodes (a forum).' }),
    postable: z.boolean().openapi({ description: 'Messages can be sent and stored here.' }),
    member: z.string().optional().openapi({
      description: 'What the connection is in the node: `member`, `admin`, `owner` or `none`.',
    }),
    canPost: z.boolean().optional(),
    account: ChannelAccountChatSchema.optional(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    policy: ChannelPolicySchema.nullable().openapi({
      description: 'What is set on this node itself; null = everything is inherited.',
    }),
    effective: z.object({
      allowed: z.boolean(),
      agentId: z.string(),
      wake,
      delivery,
      retentionDays: z.number().int(),
      observe: z.boolean(),
      sessionScope,
      redactOnDelete: z.boolean(),
      proactive: proactiveEffective,
    }),
    inherited: z
      .partialRecord(
        settingKey,
        z.object({
          from: z.enum(['node', 'ancestor', 'connection', 'default']),
          nodeId: z.string().optional(),
        }),
      )
      .openapi({ description: 'Where each effective setting comes from.' }),
  })
  .openapi('ChannelNode')

export const ChannelChatSchema = ChannelNodeSchema
export const ChannelChatListSchema = z
  .object({ items: z.array(ChannelNodeSchema) })
  .openapi('ChannelNodeList')

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
        observe: z.boolean().optional(),
        sessionScope: sessionScope.optional(),
        redactOnDelete: z.boolean().optional(),
      })
      .optional(),
  })
  .openapi('ChannelBindBody')

export const ChannelPolicyBodySchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    agentId: z.string().min(1).nullable().optional(),
    wake: wake.nullable().optional(),
    delivery: delivery.nullable().optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    observe: z.boolean().nullable().optional(),
    sessionScope: sessionScope.nullable().optional(),
    redactOnDelete: z.boolean().nullable().optional(),
    proactive: proactiveShape.nullable().optional(),
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
    conversationId: z.string().openapi({ description: 'The node id.' }),
    kind,
    title: z.string(),
    container: z.string(),
    topic: z.string().optional(),
    parentId: z.string().optional(),
    parentTitle: z.string().optional(),
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
        'A drop reason (`unlinked-sender`, `chat-not-allowed`, `dm-disabled`, `bot-sender`, `loop-guard`, `duplicate`, `agent-unavailable`, `not-authorized`, `not-observed`), a wake reason, or a short note. Never message text.',
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
    .openapi({
      param: { name: 'chatId', in: 'path', description: 'The node id of the chat or topic.' },
    }),
})
export const ChannelLinkParam = ChannelIdParam.extend({
  peerId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'peerId', in: 'path' } }),
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

// --- people directory, reminders (L6) ---------------------------------------------------------

const role = z.enum(['owner', 'admin', 'member', 'guest'])
export const ChannelPersonSchema = z
  .object({
    peerId: z.string().openapi({ description: 'The platform user id.' }),
    name: z.string().optional(),
    username: z.string().optional(),
    kind: z.string(),
    isBot: z.boolean(),
    role,
    roleSource: z.string().openapi({
      description: '`directory`, `linked-admin`, `linked-member`, `anonymous`, `bot` or `default`.',
    }),
    explicit: z
      .boolean()
      .openapi({ description: 'The team set this role (a directory entry exists).' }),
    divisions: z.array(z.object({ nodeId: z.string(), title: z.string() })),
    memberId: z.string().optional().openapi({ description: 'The linked team member.' }),
    platformAdmin: z.array(
      z.object({
        nodeId: z.string(),
        title: z.string(),
        role: z.enum(['owner', 'admin']),
        customTitle: z.string().optional(),
      }),
    ),
    suggestion: z.object({ role, reason: z.string() }).optional().openapi({
      description: 'The platform lists this person as admin and the team has not decided.',
    }),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
  })
  .openapi('ChannelPerson')
export const ChannelPersonListSchema = z
  .object({ items: z.array(ChannelPersonSchema) })
  .openapi('ChannelPersonList')
export const ChannelRoleBodySchema = z
  .object({ role, divisions: z.array(z.string().min(1)).max(100).optional() })
  .openapi('ChannelRoleBody')
export const ChannelImportResultSchema = z
  .object({ chats: z.number().int(), people: z.number().int(), problems: z.array(z.string()) })
  .openapi('ChannelImportResult')
export const ChannelPeopleSettingsSchema = z
  .object({
    defaultRole: role.openapi({
      description: 'Role of somebody who is neither in the directory nor linked to a team member.',
    }),
    approvalTtlHours: z.number().min(0.02).max(720).openapi({
      description: 'An approval nobody answers in a chat is declined after this long.',
    }),
  })
  .openapi('ChannelPeopleSettings')
export const ChannelPeopleSettingsBodySchema = ChannelPeopleSettingsSchema.partial().openapi(
  'ChannelPeopleSettingsBody',
)
export const ChannelReminderSchema = z
  .object({
    id: z.string(),
    nodeId: z.string(),
    chatTitle: z.string(),
    text: z.string(),
    whenText: z
      .string()
      .openapi({ description: 'The schedule in words with the absolute time and zone.' }),
    status: z.enum(['active', 'done', 'cancelled']),
    mentions: z.array(z.string()),
    createdByName: z.string().optional(),
    createdByRole: z.string().optional(),
    createdAt: z.number().int(),
    lastFiredAt: z.number().int().optional(),
    fireCount: z.number().int(),
    lastError: z.string().optional(),
  })
  .openapi('ChannelReminder')
export const ChannelReminderListSchema = z
  .object({ items: z.array(ChannelReminderSchema) })
  .openapi('ChannelReminderList')
export const ChannelReminderQuery = z.object({
  all: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Also finished and cancelled ones.' }),
})
export const ChannelReminderParam = z.object({ id: z.string(), reminderId: z.string() })
