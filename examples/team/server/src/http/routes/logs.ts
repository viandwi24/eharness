import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getModelCall, listModelCalls, modelCallStats } from '../../app/logs.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  LogFilterQuery,
  LogIdParam,
  ModelCallDetailSchema,
  ModelCallListSchema,
  ModelCallStatsSchema,
} from '../schemas/logs.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const listRoute = createRoute({
  method: 'get',
  path: '/logs',
  tags: ['logs'],
  summary: 'Model call log: one row per provider call, newest first',
  description:
    'Every call to a model (agent steps, compaction, memory flush, the Auto mode classifier) with timing, tokens and cost. Rows do not carry the request / response JSON: use `GET /logs/{id}`. Kept for a limited time and number of rows.',
  security,
  request: {
    query: LogFilterQuery.extend({
      cursor: z.string().optional().openapi({ description: '`nextCursor` of the previous page.' }),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: { description: 'A page of calls', content: json(ModelCallListSchema) },
    ...errorResponses,
  },
})

const statsRoute = createRoute({
  method: 'get',
  path: '/logs/stats',
  tags: ['logs'],
  summary: 'Histogram of calls over a time range, with totals',
  description:
    'Buckets of the range `from`..`to` (default: the last 24 hours) with count, errors, tokens and cost, under the same filters as the list.',
  security,
  request: {
    query: LogFilterQuery.extend({
      bucketMs: z.coerce.number().int().min(1000).optional().openapi({
        description:
          'Bucket width in ms; default fits the range in about 60 buckets (at most 200).',
      }),
    }),
  },
  responses: {
    200: { description: 'Buckets and totals', content: json(ModelCallStatsSchema) },
    ...errorResponses,
  },
})

const detailRoute = createRoute({
  method: 'get',
  path: '/logs/{id}',
  tags: ['logs'],
  summary: 'One call with its request, response and output',
  description: 'Pass the list filters to get `prevId` / `nextId` of the neighbours in that view.',
  security,
  request: { params: LogIdParam, query: LogFilterQuery },
  responses: {
    200: { description: 'The call', content: json(ModelCallDetailSchema) },
    404: jsonError('Unknown call (it may have been pruned)'),
    ...errorResponses,
  },
})

export function logRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => c.json(listModelCalls(deps, clean(c.req.valid('query'))), 200))
    .openapi(statsRoute, (c) => c.json(modelCallStats(deps, clean(c.req.valid('query'))), 200))
    .openapi(detailRoute, (c) =>
      c.json(getModelCall(deps, c.req.valid('param').id, clean(c.req.valid('query'))), 200),
    )
}

/** Drop undefined keys (exactOptionalPropertyTypes). */
function clean<T extends Record<string, unknown>>(query: T): T {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as T
}
