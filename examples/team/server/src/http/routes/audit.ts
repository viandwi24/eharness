import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { auditCsv, collectAudit } from '../../app/audit.ts'
import { invalid } from '../../app/errors.ts'
import type { Deps } from '../../app/ports.ts'
import { AuditFilterQuery, AuditListQuery, AuditPageSchema } from '../schemas/audit.ts'
import { errorResponses } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const tags = ['audit']

const listRoute = createRoute({
  method: 'get',
  path: '/audit/actions',
  tags,
  summary: 'Audit of platform actions across all connections',
  description:
    'What the agents did on chat platforms (moderation, pins, admin rights, lookups): one row per call with the connection, the chat, the person who asked (`web owner`, a team member, `autonomous <origin>`), the agent, the session, the result (`ok`, `error`, `refused`, `rate_limited`) and the duration. Newest first, cursor paged. Never a message body.',
  security,
  request: { query: AuditListQuery },
  responses: {
    200: {
      description: 'A page of rows',
      content: { 'application/json': { schema: AuditPageSchema } },
    },
    ...errorResponses,
  },
})

const csvRoute = createRoute({
  method: 'get',
  path: '/audit/actions.csv',
  tags,
  summary: 'The audit as CSV',
  description:
    "The same filters as `GET /audit/actions`, no paging: up to 10 000 rows, newest first. Fields are quoted and escaped; text that a spreadsheet would run as a formula starts with `'`.",
  security,
  request: { query: AuditFilterQuery },
  responses: {
    200: {
      description: 'CSV',
      content: { 'text/csv': { schema: z.string() } },
    },
    ...errorResponses,
  },
})

/** Only the keys that are set (the ports take `exactOptionalPropertyTypes`). */
const defined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export function auditRoutes(deps: Deps): OpenAPIHono {
  const check = (q: { from?: number; to?: number }): void => {
    if (q.from !== undefined && q.to !== undefined && q.from > q.to)
      throw invalid('from must not be after to')
  }
  return new OpenAPIHono()
    .openapi(listRoute, async (c) => {
      const q = defined(c.req.valid('query'))
      check(q)
      return c.json(await deps.channelInbox.audit(q), 200)
    })
    .openapi(csvRoute, async (c) => {
      const q = defined(c.req.valid('query'))
      check(q)
      const rows = await collectAudit((query) => deps.channelInbox.audit(query), q)
      const stamp = new Date(deps.clock.now()).toISOString().slice(0, 10)
      return new Response(auditCsv(rows), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="audit-${stamp}.csv"`,
          'x-content-type-options': 'nosniff',
        },
      }) as never
    })
}
