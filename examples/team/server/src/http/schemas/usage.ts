import { z } from '@hono/zod-openapi'
import { USAGE_SOURCES } from '../../app/usage.ts'

const TotalSchema = z.object({
  count: z.number().int(),
  tokens: z.number().int(),
  costUsd: z.number(),
})

export const SourceUsageSchema = z
  .object({
    source: z.enum(USAGE_SOURCES).openapi({
      description:
        '`chat` (all chat threads), `task` (tasks queued by a person), `delegated` (work an agent handed to another), `routine` (routine runs), `program` (program runs).',
    }),
    count: z
      .number()
      .int()
      .openapi({ description: 'Chat: turns that ran a model step. The others: runs.' }),
    tokens: z.number().int(),
    costUsd: z.number(),
  })
  .openapi('SourceUsage')

export const WorkspaceUsageSchema = z
  .object({
    total: TotalSchema,
    bySource: z.array(SourceUsageSchema),
    agents: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        color: z.string().optional(),
        bySource: z.array(SourceUsageSchema),
        total: TotalSchema,
      }),
    ),
  })
  .openapi('WorkspaceUsage')
