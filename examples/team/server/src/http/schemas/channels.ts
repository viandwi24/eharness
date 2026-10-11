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

export const ChannelConnectionSchema = z
  .object({
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
