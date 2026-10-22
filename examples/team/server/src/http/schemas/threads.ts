import { z } from '@hono/zod-openapi'

export const ThreadSeedSchema = z
  .object({
    // `briefing` only on threads that were opened before the Briefing page was removed (P55)
    kind: z.enum(['briefing', 'alert', 'run']),
    ref: z.string().openapi({ description: 'Id of the notification or task.' }),
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
    kind: z.enum(['alert', 'run']),
    ref: z.string().openapi({ description: 'Alert (notification) id or task id.' }),
    agent: z.string().optional().openapi({ description: 'Agent id or slug; default the lead.' }),
  })
  .openapi('Discuss')
