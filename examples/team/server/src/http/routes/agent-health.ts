import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { dismissFinding, listHealth, restoreFinding } from '../../app/health.ts'
import type { Deps } from '../../app/ports.ts'
import {
  FindingAckSchema,
  FindingListSchema,
  FindingQuerySchema,
  FingerprintParam,
} from '../schemas/agent-health.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const listRoute = createRoute({
  method: 'get',
  path: '/agent-health/findings',
  tags: ['health'],
  summary: 'Agent health findings',
  description:
    'Problems the server noticed in the last 24 hours from its own data: a tool denied again and again, a tool loop, the same tool error, an approval nobody answers, a context spike, a program run that ended partial or failed, provider errors. High severity ones raise a bell notice once. Dismissed findings are hidden unless `dismissed=true`.',
  security,
  request: { query: FindingQuerySchema },
  responses: {
    200: { description: 'Findings, high severity first', content: json(FindingListSchema) },
    ...errorResponses,
  },
})

const dismissRoute = createRoute({
  method: 'post',
  path: '/agent-health/findings/{fingerprint}/dismiss',
  tags: ['health'],
  summary: 'Dismiss a finding',
  description: 'Hides the finding (by fingerprint) and keeps it from raising a notice.',
  security,
  request: { params: FingerprintParam },
  responses: {
    200: { description: 'Dismissed', content: json(FindingAckSchema) },
    ...errorResponses,
  },
})

const restoreRoute = createRoute({
  method: 'delete',
  path: '/agent-health/findings/{fingerprint}/dismiss',
  tags: ['health'],
  summary: 'Show a dismissed finding again',
  security,
  request: { params: FingerprintParam },
  responses: {
    200: { description: 'Restored', content: json(FindingAckSchema) },
    409: jsonError('`NOT_DISMISSED`'),
    ...errorResponses,
  },
})

export function agentHealthRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, async (c) => {
      const q = c.req.valid('query')
      return c.json(
        (await listHealth(deps, {
          agentId: q.agent,
          severity: q.severity,
          kind: q.kind,
          includeDismissed: q.dismissed === 'true',
        })) as never,
        200,
      )
    })
    .openapi(dismissRoute, (c) => {
      dismissFinding(deps, c.req.valid('param').fingerprint)
      return c.json({ ok: true as const }, 200)
    })
    .openapi(restoreRoute, (c) => {
      restoreFinding(deps, c.req.valid('param').fingerprint)
      return c.json({ ok: true as const }, 200)
    })
}
