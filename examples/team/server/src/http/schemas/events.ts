import { z } from '@hono/zod-openapi'
import { APP_STREAM_TYPES, CHANNEL_STREAM_TYPES, STREAM_SOURCES } from '../../app/catalog.ts'

const epoch = z.coerce.number().int().min(0)

export const StreamTypeSchema = z
  .enum([...CHANNEL_STREAM_TYPES, ...APP_STREAM_TYPES] as const)
  .openapi('StreamEventType')

export const EventListQuery = z.object({
  source: z
    .enum(STREAM_SOURCES)
    .optional()
    .openapi({ description: '`channel` (chat platforms) or `app`.' }),
  connectionId: z.string().min(1).optional().openapi({ description: 'Only this chat connection.' }),
  type: z.string().min(1).max(1000).optional().openapi({
    description:
      'One or more event types, comma separated (`member.join_requested,member.joined`).',
  }),
  chat: z.string().min(1).max(200).optional().openapi({
    description: 'A chat: its internal id, or part of its title.',
  }),
  actor: z.string().min(1).max(200).optional().openapi({
    description: 'A person: their platform user id, or part of a name or username.',
  }),
  from: epoch.optional().openapi({ description: 'At or after this time (epoch ms).' }),
  to: epoch.optional().openapi({ description: 'At or before this time (epoch ms).' }),
  cursor: z.string().min(1).optional().openapi({ description: '`next` of the previous page.' }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const StreamEventSchema = z
  .object({
    id: z
      .string()
      .openapi({ description: '`ch:<id>` (a chat event) or `app:<seq>`; sorts by time.' }),
    at: z.number().int().openapi({ description: 'Epoch ms.' }),
    source: z.enum(STREAM_SOURCES),
    connectionId: z.string().optional(),
    sourceLabel: z.string().openapi({ description: 'The connection label, or `app`.' }),
    type: StreamTypeSchema,
    chat: z
      .object({
        nodeId: z.string(),
        roomId: z.string().optional(),
        nativeId: z.string(),
        title: z.string(),
      })
      .optional(),
    actor: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        username: z.string().optional(),
        role: z.string().optional(),
        self: z.boolean().optional(),
      })
      .optional(),
    summary: z.string().openapi({ description: 'Who did what where. Never a message body.' }),
    fields: z.record(z.string(), z.string()).openapi({
      description: 'Flat facts the trigger filters read (`emoji`, `link`, `program`, `kind`, ...).',
    }),
    link: z.string().nullable().openapi({ description: 'An app page about the event.' }),
    agentCaused: z.boolean().openapi({
      description:
        'The agent itself caused it (its own message or admin action, a run a trigger started).',
    }),
    agentId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .openapi('StreamEvent')

export const EventPageSchema = z
  .object({
    items: z.array(StreamEventSchema).openapi({ description: 'Newest first.' }),
    next: z.string().optional().openapi({ description: 'Pass as `cursor` for older events.' }),
  })
  .openapi('EventPage')

export const EventIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'ch:0198f0a2-0000-7000-8000-000000000000',
    }),
})

export const EventTypeInfoSchema = z
  .object({
    type: StreamTypeSchema,
    source: z.enum(STREAM_SOURCES),
    label: z.string(),
    fields: z.array(z.string()),
    delivery: z
      .object({ bot: z.string(), account: z.string() })
      .optional()
      .openapi({ description: 'What a bot and a user account deliver of this type.' }),
  })
  .openapi('EventTypeInfo')

export const EventCatalogSchema = z
  .object({
    types: z.array(EventTypeInfoSchema),
    connections: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        platform: z.string(),
        transport: z.enum(['bot', 'user']).optional(),
      }),
    ),
  })
  .openapi('EventCatalog')
