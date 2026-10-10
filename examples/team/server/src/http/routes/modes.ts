import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { getMode, setMode } from '../../app/modes.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import { ModePutSchema, ModeStateSchema } from '../schemas/modes.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const get = createRoute({
  method: 'get',
  path: '/agents/{id}/mode',
  tags: ['agents'],
  summary: "Permission mode of the agent's DM chat",
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The effective mode and the modes available',
      content: json(ModeStateSchema),
    },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const put = createRoute({
  method: 'put',
  path: '/agents/{id}/mode',
  tags: ['agents'],
  summary: "Pick the permission mode of the agent's DM chat",
  description:
    'Takes effect at the next tool call, a running turn included. Delegated tasks started by this chat inherit it, unless their own agent is stricter. Emits a `mode-changed` event.',
  security,
  request: { params: IdParam, body: { required: true, content: json(ModePutSchema) } },
  responses: {
    200: { description: 'The new state', content: json(ModeStateSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived agent, or a mode this agent does not allow (`MODE_NOT_ALLOWED`)'),
    ...errorResponses,
  },
})

export function modeRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(get, (c) => c.json(getMode(deps, c.req.valid('param').id), 200))
    .openapi(put, (c) =>
      c.json(setMode(deps, c.req.valid('param').id, c.req.valid('json').mode), 200),
    )
}
