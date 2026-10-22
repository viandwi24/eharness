/** Owner routes of the Developer API: API agents, API keys, the request log and usage. */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { DeveloperApi } from '../../app/developer-api.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  ApiAgentCreateSchema,
  ApiAgentListSchema,
  ApiAgentPatchSchema,
  ApiAgentSchema,
  ApiKeyCreatedSchema,
  ApiKeyCreateSchema,
  ApiKeyListSchema,
  ApiKeyPatchSchema,
  ApiKeySchema,
  ApiRequestListSchema,
  ApiUsageSchema,
} from '../schemas/developer.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const tags = ['developer']

export function developerRoutes(api: DeveloperApi): OpenAPIHono {
  const { owner } = api
  const app = new OpenAPIHono()

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/agents',
      tags,
      summary: 'API agents',
      description:
        'Isolated agents that other applications call with an API key. They are not team agents: no chats, channels or team tools.',
      security,
      request: { query: z.object({ includeArchived: z.enum(['true', 'false']).optional() }) },
      responses: {
        200: { description: 'The API agents', content: json(ApiAgentListSchema) },
        ...errorResponses,
      },
    }),
    (c) =>
      c.json({ agents: owner.listAgents(c.req.valid('query').includeArchived === 'true') }, 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/agents',
      tags,
      summary: 'Create an API agent',
      description:
        'Default access is nothing: no tools. Grant read-only library folders (`readFolders`), at most one `writeFolder`, and web search.',
      security,
      request: { body: { required: true, content: json(ApiAgentCreateSchema) } },
      responses: {
        201: { description: 'The agent', content: json(ApiAgentSchema) },
        409: jsonError('The slug is taken (`SLUG_TAKEN`)'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.createAgent(c.req.valid('json')), 201),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/agents/{id}',
      tags,
      summary: 'One API agent (by id or slug)',
      security,
      request: { params: IdParam },
      responses: {
        200: { description: 'The agent', content: json(ApiAgentSchema) },
        404: jsonError('Unknown API agent'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.getAgent(c.req.valid('param').id), 200),
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/developer/agents/{id}',
      tags,
      summary: 'Edit an API agent',
      description: 'Takes effect on the next request; open conversations keep their history.',
      security,
      request: { params: IdParam, body: { required: true, content: json(ApiAgentPatchSchema) } },
      responses: {
        200: { description: 'The agent', content: json(ApiAgentSchema) },
        404: jsonError('Unknown API agent'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.updateAgent(c.req.valid('param').id, c.req.valid('json')), 200),
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/developer/agents/{id}',
      tags,
      summary: 'Archive an API agent',
      description: 'It stops answering API calls (404 for developers). Nothing is deleted.',
      security,
      request: { params: IdParam },
      responses: {
        200: { description: 'The archived agent', content: json(ApiAgentSchema) },
        404: jsonError('Unknown API agent'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.archiveAgent(c.req.valid('param').id), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/keys',
      tags,
      summary: 'API keys with today usage and the last 30 days',
      security,
      request: {},
      responses: {
        200: { description: 'The keys', content: json(ApiKeyListSchema) },
        ...errorResponses,
      },
    }),
    (c) => c.json({ keys: owner.listKeys() }, 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/keys',
      tags,
      summary: 'Create an API key',
      description:
        'The answer holds the whole key once (`ehk_...`); only its SHA-256 is stored. Send it as `Authorization: Bearer ehk_...` to `/v1`.',
      security,
      request: { body: { required: true, content: json(ApiKeyCreateSchema) } },
      responses: {
        201: { description: 'The key (shown once)', content: json(ApiKeyCreatedSchema) },
        ...errorResponses,
      },
    }),
    async (c) => c.json(await owner.createKey(c.req.valid('json')), 201),
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/developer/keys/{id}',
      tags,
      summary: 'Edit an API key (name, agents, limits, origins, expiry)',
      security,
      request: { params: IdParam, body: { required: true, content: json(ApiKeyPatchSchema) } },
      responses: {
        200: { description: 'The key', content: json(ApiKeySchema) },
        404: jsonError('Unknown key'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.updateKey(c.req.valid('param').id, c.req.valid('json')), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/keys/{id}/revoke',
      tags,
      summary: 'Revoke an API key',
      description: 'The key stops working at once. It cannot be restored.',
      security,
      request: { params: IdParam },
      responses: {
        200: { description: 'The revoked key', content: json(ApiKeySchema) },
        404: jsonError('Unknown key'),
        ...errorResponses,
      },
    }),
    (c) => c.json(owner.revokeKey(c.req.valid('param').id), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/requests',
      tags,
      summary: 'Recent API requests (metadata only)',
      description:
        'Time, key, agent, mode, status, tokens and cost. Inputs and answers are never logged.',
      security,
      request: {
        query: z.object({
          keyId: z.string().optional(),
          agentId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.coerce.number().int().optional(),
        }),
      },
      responses: {
        200: { description: 'Newest first', content: json(ApiRequestListSchema) },
        ...errorResponses,
      },
    }),
    (c) => c.json({ requests: owner.requests(c.req.valid('query')) }, 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/usage',
      tags,
      summary: 'Requests and cost per day',
      security,
      request: {
        query: z.object({
          keyId: z.string().optional(),
          days: z.coerce.number().int().min(1).max(90).default(14),
        }),
      },
      responses: {
        200: { description: 'Totals and one row per UTC day', content: json(ApiUsageSchema) },
        ...errorResponses,
      },
    }),
    (c) => {
      const q = c.req.valid('query')
      return c.json(owner.usage(q.keyId, q.days), 200)
    },
  )

  return app
}
