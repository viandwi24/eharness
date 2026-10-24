import { z } from '@hono/zod-openapi'
import {
  FIRE_RESULTS,
  SKIP_REASONS,
  TRIGGER_ACTION_KINDS,
  WAKE_TARGETS,
} from '../../app/catalog.ts'
import { StreamEventSchema, StreamTypeSchema } from './events.ts'

export const TriggerScopeSchema = z
  .object({
    connectionIds: z.array(z.string().min(1).max(100)).max(50).default([]).openapi({
      description: 'Only these chat connections; empty = any. Applies to chat events only.',
    }),
    chatIds: z.array(z.string().min(1).max(100)).max(50).default([]).openapi({
      description: 'Only these chats (internal node ids; a chat includes its topics); empty = any.',
    }),
  })
  .openapi('TriggerScope')

export const FieldFilterSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(40)
      .openapi({ description: 'A fact of the event (`program`, `kind`, `link`, `state`, ...).' }),
    equals: z.string().max(100).optional().openapi({ description: 'Exact match, ignoring case.' }),
    contains: z.string().max(100).optional().openapi({ description: 'Substring, ignoring case.' }),
  })
  .openapi('TriggerFieldFilter')

export const TriggerFiltersSchema = z
  .object({
    actorRoles: z
      .array(z.enum(['owner', 'admin', 'member', 'guest']))
      .max(4)
      .default([])
      .openapi({
        description: 'The directory role of the person behind a chat event.',
      }),
    actors: z.array(z.string().min(1).max(100)).max(50).default([]).openapi({
      description: 'The person: a platform user id, `@username` or exact name.',
    }),
    textContains: z.array(z.string().min(1).max(100)).max(10).default([]).openapi({
      description: 'Message events: the text has any of these words (ignoring case).',
    }),
    textRegex: z.string().max(200).optional().openapi({
      description:
        'Message events: the text matches this expression (case-insensitive, at most 200 characters, no back references or nested repeats; the text is cut to 2000 characters).',
    }),
    emoji: z.array(z.string().min(1).max(20)).max(20).default([]).openapi({
      description: 'Reaction events: the emoji is one of these.',
    }),
    fields: z.array(FieldFilterSchema).max(10).default([]).openapi({
      description: 'Facts of the event; all must match.',
    }),
  })
  .openapi('TriggerFilters')

export const TriggerActionSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('wake'),
      agentId: z.string().min(1).openapi({ description: 'The agent to wake (id).' }),
      target: z.enum(WAKE_TARGETS).default('triggers').openapi({
        description:
          '`chat`: the session of the chat the event happened in. `thread`: the agent\'s newest web chat. `triggers`: a web thread named "Triggers".',
      }),
      instruction: z
        .string()
        .min(1)
        .max(2000)
        .openapi({ description: 'What the agent should do about the event.' }),
      includeText: z.boolean().optional().openapi({
        description:
          'Give the agent a short preview of the message text (untrusted data). Default off.',
      }),
    }),
    z.object({ kind: z.literal('program'), programId: z.string().min(1) }),
    z.object({
      kind: z.literal('notify'),
      dm: z
        .boolean()
        .optional()
        .openapi({ description: 'Also message the owner in their direct chat.' }),
      title: z.string().max(120).optional(),
    }),
    z.object({
      kind: z.literal('webhook'),
      url: z.string().min(1).max(500).openapi({ description: 'An https URL on a public host.' }),
    }),
  ])
  .openapi('TriggerAction', { description: `One of ${TRIGGER_ACTION_KINDS.join(', ')}.` })

export const TriggerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    eventTypes: z.array(StreamTypeSchema),
    scope: TriggerScopeSchema,
    filters: TriggerFiltersSchema,
    action: TriggerActionSchema,
    hasSecret: z
      .boolean()
      .openapi({ description: 'A webhook secret is stored (it is never returned).' }),
    cooldownSec: z.number().int(),
    allowSelf: z.boolean(),
    createdBy: z.string(),
    notes: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastFiredAt: z.number().int().nullable(),
    fireCount: z.number().int(),
    errorCount: z.number().int(),
    filteredCount: z.number().int().openapi({
      description:
        'Messages and reactions that did not match the filters since the server started (counted, not logged).',
    }),
  })
  .openapi('Trigger')

export const TriggerListSchema = z
  .object({
    items: z.array(TriggerSchema),
    executedLastHour: z.number().int(),
    hourlyCap: z.number().int(),
  })
  .openapi('TriggerList')

export const TriggerCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional(),
    eventTypes: z.array(StreamTypeSchema).min(1).max(40),
    scope: TriggerScopeSchema.partial().optional(),
    filters: TriggerFiltersSchema.partial().optional(),
    action: TriggerActionSchema,
    webhookSecret: z.string().min(16).max(200).optional().openapi({
      description:
        'Webhook only, write-only: signs each call (HMAC-SHA256). At least 16 characters.',
    }),
    cooldownSec: z.number().int().min(0).max(604800).optional().openapi({
      description: 'After a firing the trigger waits this long before it can fire again. 0 = none.',
    }),
    allowSelf: z.boolean().optional().openapi({
      description: 'Also fire on events the agent itself caused (default no: avoids loops).',
    }),
    notes: z.string().max(500).nullable().optional(),
  })
  .openapi('TriggerCreate')

export const TriggerPatchSchema = TriggerCreateSchema.partial().openapi('TriggerPatch')

export const TriggerIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
})

export const TriggerFireSchema = z
  .object({
    id: z.string(),
    triggerId: z.string(),
    eventId: z.string(),
    eventType: z.string(),
    at: z.number().int(),
    result: z.enum(FIRE_RESULTS),
    reason: z
      .string()
      .nullable()
      .openapi({
        description: `For \`skipped\`: ${SKIP_REASONS.join(', ')}. For \`error\`: a short code.`,
      }),
    actionKind: z.enum(TRIGGER_ACTION_KINDS),
    durationMs: z.number().int(),
    detail: z.record(z.string(), z.unknown()).openapi({
      description:
        'Facts of the outcome: session, task, webhook status, the error. Never a message body.',
    }),
  })
  .openapi('TriggerFire')

export const TriggerFiresQuery = z.object({
  result: z.enum(FIRE_RESULTS).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const TriggerFirePageSchema = z
  .object({ items: z.array(TriggerFireSchema), next: z.string().optional() })
  .openapi('TriggerFirePage')

export const TriggerTestSchema = z
  .object({ eventId: z.string().min(1).openapi({ description: 'A past event (`GET /events`).' }) })
  .openapi('TriggerTest')

export const TriggerDryRunSchema = z
  .object({
    trigger: z.object({ id: z.string(), name: z.string() }),
    event: StreamEventSchema,
    verdict: z.enum(['fire', 'skip', 'nomatch']),
    reason: z.string().optional(),
    summary: z.string(),
    notes: z.array(z.string()),
    problems: z.array(z.string()),
    wouldDo: z.array(z.string()),
  })
  .openapi('TriggerDryRun', {
    description:
      'What the trigger would do with the event, without doing it. Nothing was sent, woken or run.',
  })
