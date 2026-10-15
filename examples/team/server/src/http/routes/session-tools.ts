/**
 * "Tools in this session" and the forced reload. These sit beside the `eharness/http` session
 * routes (same session ids), registered before them so the forward entry does not take them.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import { reloadAgentTools, reloadSessionTools, sessionTools } from '../../app/session-tools.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import { ReloadResultSchema, SessionToolsSchema } from '../schemas/session-tools.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const SessionParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'dm:0198f0a2-0000-7000-8000-000000000000',
      description: 'Session id, as the other `/sessions/{id}` routes take it (URL-encoded).',
    }),
})

const toolsRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/tools',
  tags: ['chats'],
  summary: 'Which tools a session has: configured, loaded in its last model call, missing',
  description:
    'Read-only and cheap (stored data and the agent\'s last activation; no model call, the session is not opened). `configured` is what the agent offers now, per connection. `lastCall` is read from the request of the newest model call of the session (`tools` = loaded, the "Deferred tools:" block = loadable with `tool_search`); it is null with a note when there is no call yet or its request was too large to keep. `missing` lists configured, allowed tools the last call neither loaded nor deferred.',
  security,
  request: { params: SessionParam },
  responses: {
    200: { description: 'The tools', content: json(SessionToolsSchema) },
    404: jsonError('Unknown session'),
    ...errorResponses,
  },
})

const reloadRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/reload',
  tags: ['chats'],
  summary: 'Force a reload of the tools of a session',
  description:
    "For urgent cases. The agent's connectors are activated again (remote MCP lists are fetched anew), the agent is rebuilt, and the session object is closed as soon as it is idle, so the next message opens a fresh one. A running turn is never cut: `pending` is true and the session closes right after the turn. The model is told once that its tools were reloaded.",
  security,
  request: { params: SessionParam },
  responses: {
    200: { description: 'What was reloaded', content: json(ReloadResultSchema) },
    404: jsonError('Unknown session'),
    409: jsonError('Archived agent'),
    ...errorResponses,
  },
})

const agentReloadRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/reload',
  tags: ['agents'],
  summary: 'Force a reload of the tools in every open chat of an agent',
  description:
    'The same as `POST /sessions/{id}/reload` for every session of the agent that is open on this server.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'What was reloaded', content: json(ReloadResultSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived agent'),
    ...errorResponses,
  },
})

export function sessionToolsRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(toolsRoute, async (c) =>
      c.json(await sessionTools(deps, c.req.valid('param').id), 200),
    )
    .openapi(reloadRoute, async (c) =>
      c.json(await reloadSessionTools(deps, c.req.valid('param').id), 200),
    )
    .openapi(agentReloadRoute, async (c) =>
      c.json(await reloadAgentTools(deps, c.req.valid('param').id), 200),
    )
}
