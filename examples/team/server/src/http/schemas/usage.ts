import { z } from '@hono/zod-openapi'
import { USAGE_SOURCES } from '../../app/usage.ts'

const TotalSchema = z.object({
  count: z.number().int(),
  calls: z.number().int().openapi({ description: 'Model calls (the unit of the Logs page).' }),
  tokens: z.number().int(),
  costUsd: z.number(),
})

export const SourceUsageSchema = z
  .object({
    source: z.enum(USAGE_SOURCES).openapi({
      description:
        '`chat` (all chat threads), `task` (tasks started by a person), `delegated` (work an agent handed to another), `routine` (routine runs), `program` (program runs), `heartbeat` (the ambient monitor), `rehearsal` (test runs), `other` (calls without a session).',
    }),
    count: z
      .number()
      .int()
      .openapi({ description: 'Chat and heartbeat: turns that called a model. The others: runs.' }),
    calls: z.number().int().openapi({ description: 'Model calls (the unit of the Logs page).' }),
    tokens: z.number().int(),
    costUsd: z.number(),
  })
  .openapi('SourceUsage')

export const WorkspaceUsageSchema = z
  .object({
    since: z.number().int().nullable().openapi({
      description: 'Start of the oldest call still in the log; the totals cover from then on.',
    }),
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
