import { z } from '@hono/zod-openapi'

// --- API agents (owner) ------------------------------------------------------------------------

export const ApiAgentSchema = z
  .object({
    id: z.string(),
    slug: z
      .string()
      .openapi({ example: 'support-bot', description: 'Used in `/v1/agents/{slug}/run`.' }),
    name: z.string().openapi({ example: 'Support bot' }),
    description: z.string(),
    instructions: z.string(),
    rules: z.array(z.string()),
    model: z.string().nullable().openapi({ description: 'Null = the workspace default model.' }),
    modelProfile: z.string().nullable(),
    readFolders: z.array(z.string()).openapi({
      example: ['/library/public/cs'],
      description:
        'Library folders the agent may read (everything under them). It sees nothing else.',
    }),
    writeFolder: z.string().nullable().openapi({
      example: '/library/tickets',
      description: 'The one folder the agent may also write to; null = read-only.',
    }),
    webSearch: z.boolean(),
    retentionDays: z
      .number()
      .int()
      .openapi({ description: 'Idle conversations are deleted after this many days.' }),
    version: z.number().int(),
    archivedAt: z.number().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('ApiAgent')

const draftFields = {
  slug: z
    .string()
    .optional()
    .openapi({ description: 'Lowercase letters, digits and dashes. Default: from the name.' }),
  description: z.string().max(500).optional(),
  rules: z.array(z.string().max(500)).max(50).optional(),
  model: z.string().nullable().optional(),
  modelProfile: z.string().nullable().optional(),
  readFolders: z.array(z.string()).max(50).optional(),
  writeFolder: z.string().nullable().optional(),
  webSearch: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}

export const ApiAgentCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(50_000),
    ...draftFields,
  })
  .openapi('ApiAgentCreate')

export const ApiAgentPatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    instructions: z.string().min(1).max(50_000).optional(),
    ...draftFields,
  })
  .openapi('ApiAgentPatch')

export const ApiAgentListSchema = z
  .object({ agents: z.array(ApiAgentSchema) })
  .openapi('ApiAgentList')

// --- API keys (owner) --------------------------------------------------------------------------

const UsageTotalsSchema = z
  .object({
    requests: z.number().int(),
    costUsd: z.number(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
  })
  .openapi('ApiUsageTotals')

export const ApiKeySchema = z
  .object({
    id: z
      .string()
      .openapi({ example: 'ehk_a1b2c3d4', description: 'The visible part of the key.' }),
    name: z.string(),
    agents: z
      .array(z.string())
      .openapi({ description: 'Slugs of the API agents the key may call.' }),
    dailyCostLimitUsd: z.number().nullable(),
    rateLimitPerMin: z.number().int().nullable(),
    origins: z
      .array(z.string())
      .openapi({ description: 'Browser origins allowed to call with this key (CORS).' }),
    expiresAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    createdAt: z.number(),
    today: z.object({ costUsd: z.number(), requests: z.number().int() }).openapi({
      description: 'USD spent today (UTC) and requests in the last minute.',
    }),
    month: UsageTotalsSchema.openapi({ description: 'The last 30 days.' }),
  })
  .openapi('ApiKey')

export const ApiKeyListSchema = z.object({ keys: z.array(ApiKeySchema) }).openapi('ApiKeyList')

const keyFields = {
  dailyCostLimitUsd: z.number().positive().nullable().optional(),
  rateLimitPerMin: z.number().int().positive().nullable().optional(),
  origins: z.array(z.string()).max(50).optional(),
  expiresAt: z.number().int().nullable().optional(),
}

export const ApiKeyCreateSchema = z
  .object({ name: z.string().min(1).max(80), agents: z.array(z.string()).min(1), ...keyFields })
  .openapi('ApiKeyCreate')

export const ApiKeyPatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    agents: z.array(z.string()).min(1).optional(),
    ...keyFields,
  })
  .openapi('ApiKeyPatch')

export const ApiKeyCreatedSchema = z
  .object({
    key: z.string().openapi({
      example: 'ehk_a1b2c3d4_0123456789abcdefghijklmnopqrstuv',
      description: 'The whole key. Shown once: only its hash is stored.',
    }),
    view: ApiKeySchema,
  })
  .openapi('ApiKeyCreated')

export const ApiRequestSchema = z
  .object({
    id: z.string(),
    at: z.number(),
    keyId: z.string(),
    agentId: z.string(),
    mode: z.enum(['run', 'conversation']),
    conversationId: z.string().nullable(),
    status: z.number().int().openapi({ description: 'HTTP status; 0 while the request runs.' }),
    errorCode: z.string().nullable(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number(),
    durationMs: z.number().int(),
  })
  .openapi('ApiRequest')

export const ApiRequestListSchema = z
  .object({ requests: z.array(ApiRequestSchema) })
  .openapi('ApiRequestList')

export const ApiUsageSchema = z
  .object({
    totals: UsageTotalsSchema,
    days: z.array(z.object({ day: z.number(), requests: z.number().int(), costUsd: z.number() })),
  })
  .openapi('ApiUsage')

// --- /v1 (developers) --------------------------------------------------------------------------

export const V1RunBodySchema = z
  .object({
    input: z
      .union([
        z.string().min(1),
        z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
      ])
      .openapi({
        description:
          'The request: a string, or a transcript of `{ role, content }` messages that ends with a `user` message.',
        example: 'Where is my order 1042?',
      }),
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({
        description:
          'Extra facts for this request (customer, page, plan). Untrusted: the agent treats it as data.',
        example: { customer: 'Acme', plan: 'pro' },
      }),
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({
        description:
          'A JSON Schema (`"type": "object"`). The answer is then validated JSON in `output`; an answer that does not match is retried and, failing that, a 502.',
        example: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: ['refund', 'shipping', 'other'] },
            urgent: { type: 'boolean' },
          },
          required: ['intent', 'urgent'],
        },
      }),
  })
  .openapi('V1RunBody')

export const V1RunResponseSchema = z
  .object({
    output: z
      .unknown()
      .openapi({ description: 'Text, or the validated JSON object when `outputSchema` was sent.' }),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
    costUsd: z.number().openapi({ description: 'What this request cost, in USD.' }),
  })
  .openapi('V1RunResponse')

export const V1ConversationCreateSchema = z
  .object({
    agent: z
      .string()
      .min(1)
      .openapi({ example: 'support-bot', description: 'Slug of an API agent.' }),
    endUserId: z.string().max(200).optional().openapi({
      description:
        'Your id of the person talking. The same `endUserId` + agent returns the open conversation.',
      example: 'user-42',
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('V1ConversationCreate')

export const V1ConversationSchema = z
  .object({
    id: z.string(),
    agent: z.string(),
    endUserId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    status: z.enum(['open', 'closed']),
    createdAt: z.number(),
    lastMessageAt: z.number(),
    reused: z
      .boolean()
      .optional()
      .openapi({ description: 'True when an open conversation of this `endUserId` was returned.' }),
  })
  .openapi('V1Conversation')

export const V1MessageBodySchema = z
  .object({
    text: z.string().min(1).optional().openapi({ example: 'Hello, I need help with my invoice.' }),
    messages: z
      .array(
        z.object({
          role: z.string(),
          parts: z.array(z.unknown()).optional(),
          content: z.string().optional(),
        }),
      )
      .optional()
      .openapi({
        description:
          'What `useChat` sends: the text of the last user message is used (the server keeps the history).',
      }),
    stream: z.boolean().optional().openapi({
      description: 'Default true: a UI message stream (SSE). False: one JSON answer.',
    }),
  })
  .openapi('V1MessageBody')

export const V1MessageResponseSchema = z
  .object({
    text: z.string(),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
    costUsd: z.number(),
  })
  .openapi('V1MessageResponse')

export const V1HistorySchema = z
  .object({
    messages: z.array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant']),
        text: z.string(),
        createdAt: z.number().nullable(),
      }),
    ),
    nextBefore: z
      .string()
      .optional()
      .openapi({ description: 'Pass as `before` for the page of older messages.' }),
  })
  .openapi('V1History')

export const V1AgentsSchema = z
  .object({
    agents: z.array(z.object({ slug: z.string(), name: z.string(), description: z.string() })),
  })
  .openapi('V1Agents')

export const V1StreamSchema = z.string().openapi({
  description:
    'Server-sent events in the AI SDK UI message stream format (`text-delta` chunks, then `[DONE]`). Tool calls and reasoning are never sent.',
})
