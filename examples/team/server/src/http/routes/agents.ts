import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  archiveAgent,
  createAgent,
  getAgent,
  listAgentsWithActivity,
  updateAgent,
} from '../../app/agents.ts'
import { redactAgent } from '../../app/catalog.ts'
import type { Deps } from '../../app/ports.ts'
import {
  AgentCreateSchema,
  AgentListSchema,
  AgentPatchSchema,
  AgentSchema,
  TOOL_CATALOG_VALUE,
  ToolCatalogSchema,
} from '../schemas/agents.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const list = createRoute({
  method: 'get',
  path: '/agents',
  tags: ['agents'],
  summary: 'List agents with their sidebar activity',
  security,
  request: {
    query: z.object({
      includeArchived: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'Include archived agents.' }),
    }),
  },
  responses: {
    200: { description: 'Agents, oldest first', content: json(AgentListSchema) },
    ...errorResponses,
  },
})

const create = createRoute({
  method: 'post',
  path: '/agents',
  tags: ['agents'],
  summary: 'Create an agent',
  security,
  request: { body: { required: true, content: json(AgentCreateSchema) } },
  responses: {
    201: { description: 'The new agent', content: json(AgentSchema) },
    409: jsonError('Slug already in use'),
    ...errorResponses,
  },
})

const get = createRoute({
  method: 'get',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Get an agent',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The agent', content: json(AgentSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const patch = createRoute({
  method: 'patch',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Edit an agent (bumps its version)',
  security,
  request: { params: IdParam, body: { required: true, content: json(AgentPatchSchema) } },
  responses: {
    200: { description: 'The updated agent', content: json(AgentSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived, or changed concurrently'),
    ...errorResponses,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/agents/{id}',
  tags: ['agents'],
  summary: 'Archive an agent (history stays readable)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The archived agent', content: json(AgentSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('The lead cannot be archived'),
    ...errorResponses,
  },
})

const tools = createRoute({
  method: 'get',
  path: '/tools',
  tags: ['agents'],
  summary: 'The fixed tool catalog a definition can choose from',
  security,
  responses: {
    200: { description: 'Tool names with descriptions', content: json(ToolCatalogSchema) },
    ...errorResponses,
  },
})

export function agentRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(list, (c) => {
      const { includeArchived } = c.req.valid('query')
      return c.json(
        {
          agents: listAgentsWithActivity(deps, {
            includeArchived: includeArchived === 'true',
          }).map(redactAgent),
        },
        200,
      )
    })
    .openapi(create, (c) => c.json(redactAgent(createAgent(deps, c.req.valid('json'))), 201))
    .openapi(get, (c) => c.json(redactAgent(getAgent(deps, c.req.valid('param').id)), 200))
    .openapi(patch, (c) =>
      c.json(redactAgent(updateAgent(deps, c.req.valid('param').id, c.req.valid('json'))), 200),
    )
    .openapi(remove, (c) => c.json(redactAgent(archiveAgent(deps, c.req.valid('param').id)), 200))
    .openapi(tools, (c) => c.json(TOOL_CATALOG_VALUE, 200))
}
