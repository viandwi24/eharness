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

export const ChannelPairingSchema = z
  .object({
    memberId: z.string(),
    link: z.string().openapi({ description: 'Deep link to open in Telegram. Shown once.' }),
    command: z.string(),
    expiresAt: z.number().int(),
  })
  .openapi('ChannelPairing')

export const ChannelBindBodySchema = z
  .object({
    agentId: z.string().min(1),
    groupPolicy: z.enum(['allowlist', 'open']).optional(),
    dm: z.enum(['pairing', 'disabled']).optional(),
    allowBots: z.boolean().optional(),
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

export const PairingBodySchema = z
  .object({ memberId: z.string().min(1).max(64).default('owner') })
  .openapi('ChannelPairingBody')

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
