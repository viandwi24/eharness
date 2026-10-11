import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  approveDecision,
  getDecision,
  listDecisions,
  openDecisionCount,
  rejectDecision,
} from '../../app/decisions.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  ApproveBodySchema,
  DecisionIdParam,
  DecisionListSchema,
  DecisionQuerySchema,
  DecisionSchema,
  RejectBodySchema,
} from '../schemas/decisions.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const params = { params: DecisionIdParam }
const unknown = jsonError('Unknown decision')

const listRoute = createRoute({
  method: 'get',
  path: '/decisions',
  tags: ['decisions'],
  summary: 'List decisions',
  description:
    'The Decision Center: proposals, escalations and amendments that only the client can settle, newest first. Tool approvals are not here: they are answered inline in the chat of their session.',
  security,
  request: { query: DecisionQuerySchema },
  responses: {
    200: { description: 'Decisions', content: json(DecisionListSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/decisions/{id}',
  tags: ['decisions'],
  summary: 'A decision',
  security,
  request: params,
  responses: {
    200: { description: 'The decision', content: json(DecisionSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const approveRoute = createRoute({
  method: 'post',
  path: '/decisions/{id}/approve',
  tags: ['decisions'],
  summary: 'Approve a decision',
  description:
    'Proposal: creates the program with the authority of the proposal (`edit` changes it first; a one-off plan also runs once). Escalation: resumes the parked session with `{ decision, note }` as the tool output (`choice` picks an option). Amendment: adds the authority to the program, then resumes the run. The first answer wins (`409 DECISION_CLOSED`); a run that no longer waits makes the decision `expired` (`409 DECISION_EXPIRED`).',
  security,
  request: { ...params, body: { required: false, content: json(ApproveBodySchema) } },
  responses: {
    200: { description: 'The decision, decided', content: json(DecisionSchema) },
    404: unknown,
    409: jsonError('`DECISION_CLOSED`, `DECISION_EXPIRED`, `PROGRAM_DELETED` or an archived agent'),
    ...errorResponses,
  },
})

const rejectRoute = createRoute({
  method: 'post',
  path: '/decisions/{id}/reject',
  tags: ['decisions'],
  summary: 'Reject a decision',
  description:
    'Escalation and amendment: resumes the parked session with `{ decision: "rejected", note }`; the agent continues without what it asked for. Proposal: nothing is created.',
  security,
  request: { ...params, body: { required: false, content: json(RejectBodySchema) } },
  responses: {
    200: { description: 'The decision, decided', content: json(DecisionSchema) },
    404: unknown,
    409: jsonError('`DECISION_CLOSED` or `DECISION_EXPIRED`'),
    ...errorResponses,
  },
})

export function decisionRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(
        {
          decisions: listDecisions(deps, q),
          open: openDecisionCount(deps),
        } as never,
        200,
      )
    })
    .openapi(getRoute, (c) => c.json(getDecision(deps, c.req.valid('param').id) as never, 200))
    .openapi(approveRoute, async (c) => {
      const body = c.req.valid('json') ?? {}
      return c.json((await approveDecision(deps, c.req.valid('param').id, body)) as never, 200)
    })
    .openapi(rejectRoute, async (c) => {
      const body = c.req.valid('json') ?? {}
      return c.json((await rejectDecision(deps, c.req.valid('param').id, body)) as never, 200)
    })
}
