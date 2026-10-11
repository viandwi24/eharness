import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { getAgent } from '../../app/agents.ts'
import { digestView, getHeartbeat, setDigest, setHeartbeat } from '../../app/heartbeat.ts'
import type { Deps } from '../../app/ports.ts'
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
    'The ambient monitor of an agent: its configuration (on for the lead by default), the state of its checklist (`HEARTBEAT.md` in its memory), the routine that wakes it and the last beats (ok, attention, skipped, failed). Also the daily digest settings.',
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
    'Turn it on or off, set the interval (5 minutes to 24 hours), the active hours and their timezone. The routine that wakes it follows. The checklist is the memory file `HEARTBEAT.md` (edit it through `/memory`); `createChecklist` writes a template when there is none.',
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
    'Fires one beat outside the schedule. The same rules apply: outside the active hours, with an empty checklist or while the previous beat runs it is skipped (`started: false` with the reason) and costs no model call.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Started, or skipped with a reason', content: json(BeatRunSchema) },
    404: jsonError('Unknown agent'),
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
    'Once a day at `time` (default 18:00, in `timezone` or the lead heartbeat timezone) the lead DM gets what ran, what waits, what the heartbeat noticed and the cost. A quiet day sends nothing.',
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
    .openapi(digestGet, (c) => c.json(digestView(deps) as never, 200))
    .openapi(digestPatch, (c) => {
      setDigest(deps, c.req.valid('json'))
      return c.json(digestView(deps) as never, 200)
    })
}
