import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getAgent } from '../../app/agents.ts'
import { notFound } from '../../app/errors.ts'
import { digestView, getHeartbeat, setDigest, setHeartbeat } from '../../app/heartbeat.ts'
import type { Deps } from '../../app/ports.ts'
import { removeOrder } from '../../app/standing-orders.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  BeatRunSchema,
  DigestPatchSchema,
  DigestViewSchema,
  HeartbeatPatchSchema,
  HeartbeatSchema,
} from '../schemas/heartbeat.ts'

const security = [{ Bearer: [] }]
const json = <T extends Parameters<typeof Object>[0]>(schema: T) => ({
  'application/json': { schema },
})

const getRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/heartbeat',
  tags: ['heartbeat'],
  summary: 'Heartbeat of an agent',
  description:
    'The ambient monitor of an agent: its standing orders (the ongoing instructions people gave it in chat, kept as lines of `HEARTBEAT.md` in its memory), the advanced settings, the routine that wakes it and the last beats (ok, attention, skipped, failed). It runs by itself when there is at least one order or checklist item; no toggle.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The heartbeat', content: json(HeartbeatSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/agents/{id}/heartbeat',
  tags: ['heartbeat'],
  summary: 'Configure the heartbeat of an agent',
  description:
    'Advanced settings: the interval (5 minutes to 24 hours, default 30), the active hours and their timezone. The routine that wakes it follows. Orders are given to the agent in chat (its `standing_order` tool) or written in the memory file `HEARTBEAT.md` (read and write it through `/memory/file`, scope `agent`); removing one is the delete route below.',
  security,
  request: { params: IdParam, body: { required: true, content: json(HeartbeatPatchSchema) } },
  responses: {
    200: { description: 'The heartbeat', content: json(HeartbeatSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('The agent is archived'),
    ...errorResponses,
  },
})

const runRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/heartbeat/run',
  tags: ['heartbeat'],
  summary: 'Run a beat now',
  description:
    'Fires one beat outside the schedule. The same rules apply: outside the active hours, with nothing to watch or while the previous beat runs it is skipped (`started: false` with the reason) and costs no model call.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Started, or skipped with a reason', content: json(BeatRunSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const orderParams = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
})

const orderDelete = createRoute({
  method: 'delete',
  path: '/agents/{id}/heartbeat/orders/{orderId}',
  tags: ['heartbeat'],
  summary: 'Remove a standing order',
  description:
    'Deletes the order line from the agent HEARTBEAT.md; the rest of the file stays. The heartbeat stops reporting for it from the next beat.',
  security,
  request: { params: orderParams },
  responses: {
    200: { description: 'The heartbeat', content: json(HeartbeatSchema) },
    404: jsonError('Unknown agent or order'),
    ...errorResponses,
  },
})

const digestGet = createRoute({
  method: 'get',
  path: '/digest',
  tags: ['heartbeat'],
  summary: 'Daily digest settings',
  security,
  responses: {
    200: { description: 'The digest settings', content: json(DigestViewSchema) },
    ...errorResponses,
  },
})

const digestPatch = createRoute({
  method: 'patch',
  path: '/digest',
  tags: ['heartbeat'],
  summary: 'Change the daily digest',
  description:
    'Once a day at `time` (default 18:00, in `timezone` or the team timezone) the bell gets one notification with what ran, what waits, what the heartbeat noticed and the cost. A quiet day adds nothing.',
  security,
  request: { body: { required: true, content: json(DigestPatchSchema) } },
  responses: {
    200: { description: 'The digest settings', content: json(DigestViewSchema) },
    ...errorResponses,
  },
})

export function heartbeatRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(getRoute, async (c) =>
      c.json((await getHeartbeat(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(patchRoute, async (c) =>
      c.json(
        (await setHeartbeat(deps, c.req.valid('param').id, c.req.valid('json'))) as never,
        200,
      ),
    )
    .openapi(runRoute, async (c) => {
      const agent = getAgent(deps, c.req.valid('param').id)
      return c.json(await deps.heartbeat.run(agent.id, deps.clock.now()), 200)
    })
    .openapi(orderDelete, async (c) => {
      const { id, orderId } = c.req.valid('param')
      const agent = getAgent(deps, id)
      const removed = await removeOrder(deps, agent.id, orderId)
      if (removed === undefined) throw notFound('standing order', orderId)
      return c.json((await getHeartbeat(deps, agent.id)) as never, 200)
    })
    .openapi(digestGet, (c) => c.json(digestView(deps) as never, 200))
    .openapi(digestPatch, (c) => {
      setDigest(deps, c.req.valid('json'))
      return c.json(digestView(deps) as never, 200)
    })
}
