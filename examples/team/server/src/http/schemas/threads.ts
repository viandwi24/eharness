import { z } from '@hono/zod-openapi'

export const ThreadSeedSchema = z
  .object({
    kind: z.enum(['briefing', 'alert', 'run']),
    ref: z.string().openapi({ description: 'Id of the briefing, notification or task.' }),
    title: z.string(),
  })
  .openapi('ThreadSeed', { description: 'What a "Discuss in chat" thread was opened about.' })

export const ThreadSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    sessionId: z.string().openapi({
      example: 'chat:0198…:0198…',
      description:
        'The eharness session of the thread: `chat:<agentId>:<id>`, or `dm:<agentId>` for the thread that existed before threads did. Use it with `/sessions/{id}/…`.',
    }),
    title: z.string().nullable().openapi({
      description: 'Null until named: the first message names an unnamed thread.',
    }),
    source: z.enum(['web', 'channel']).openapi({
      description: 'Where the conversation lives. `channel` is reserved for messaging channels.',
    }),
    sourceLabel: z.string().nullable().openapi({
      description: 'Display label of the source, for example the name of a group.',
    }),
    seed: ThreadSeedSchema.nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastMessageAt: z.number().int().nullable(),
    preview: z.string().nullable(),
    archivedAt: z.number().int().nullable(),
  })
  .openapi('Thread')

export const ThreadListSchema = z.object({ threads: z.array(ThreadSchema) }).openapi('ThreadList')

export const ThreadsQuerySchema = z.object({
  archived: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Include archived threads (listed last).' }),
})

export const ThreadParams = z.object({
  id: z.string().openapi({ description: 'Agent id or slug.' }),
  threadId: z.string(),
})

export const ThreadCreateSchema = z
  .object({ title: z.string().min(1).max(200).optional() })
  .openapi('ThreadCreate')

export const ThreadPatchSchema = z
  .object({ title: z.string().min(1).max(200) })
  .openapi('ThreadPatch')

export const DiscussSchema = z
  .object({
    kind: z.enum(['briefing', 'alert', 'run']),
    ref: z.string().openapi({ description: 'Briefing id, alert (notification) id or task id.' }),
    item: z
      .number()
      .int()
      .min(0)
      .optional()
      .openapi({ description: 'With a briefing: the index of one item of it.' }),
    agent: z.string().optional().openapi({ description: 'Agent id or slug; default the lead.' }),
  })
  .openapi('Discuss')
