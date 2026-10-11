import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { chatStats, compactChat, getChatTools, setChatTools } from '../../app/chat.ts'
import type { Deps } from '../../app/ports.ts'
import {
  ChatStatsSchema,
  ChatToolsPutSchema,
  ChatToolsSchema,
  CompactResultSchema,
} from '../schemas/chat.ts'
import { errorResponses, IdParam, jsonError, ThreadQuery } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const compactRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/compact',
  tags: ['chats'],
  summary: 'Summarise the older part of the chat now',
  security,
  request: { params: IdParam, query: ThreadQuery },
  responses: {
    200: { description: 'The summary, or nothing to compact', content: json(CompactResultSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('A turn runs (`EH_SESSION_BUSY`) or the agent is archived'),
    ...errorResponses,
  },
})

const statsRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/stats',
  tags: ['chats'],
  summary: 'Context size, usage, active turn and pending approvals',
  security,
  request: { params: IdParam, query: ThreadQuery },
  responses: {
    200: { description: 'Session statistics', content: json(ChatStatsSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const toolsGetRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/chat/tools',
  tags: ['chats'],
  summary: 'Connectors this chat offers to the model (composer tools menu)',
  description:
    "The agent's enabled connections (and web search), each with whether this chat offers it. A new chat offers all of them.",
  security,
  request: { params: IdParam, query: ThreadQuery },
  responses: {
    200: { description: 'The connectors and their switches', content: json(ChatToolsSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const toolsPutRoute = createRoute({
  method: 'put',
  path: '/agents/{id}/chat/tools',
  tags: ['chats'],
  summary: 'Switch connectors off or on for this chat only',
  description:
    'Replaces the list of switched-off connections (400 `UNKNOWN_CONNECTION` for an id that is not a connector of this agent). Takes effect at the next model step (a running turn included). The tool definitions and their order do not change (prompt cache): switched-off tools are only not offered. Permissions and pinned asks of the tools that stay on are unchanged.',
  security,
  request: {
    params: IdParam,
    query: ThreadQuery,
    body: { required: true, content: json(ChatToolsPutSchema) },
  },
  responses: {
    200: { description: 'The new state', content: json(ChatToolsSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived agent'),
    ...errorResponses,
  },
})

export function chatRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(compactRoute, async (c) => {
      const result = await compactChat(deps, c.req.valid('param').id, c.req.valid('query').thread)
      return c.json(result as never, 200)
    })
    .openapi(toolsGetRoute, async (c) =>
      c.json(await getChatTools(deps, c.req.valid('param').id, c.req.valid('query').thread), 200),
    )
    .openapi(toolsPutRoute, async (c) =>
      c.json(
        await setChatTools(
          deps,
          c.req.valid('param').id,
          c.req.valid('json').off,
          c.req.valid('query').thread,
        ),
        200,
      ),
    )
    .openapi(statsRoute, async (c) =>
      c.json(await chatStats(deps, c.req.valid('param').id, c.req.valid('query').thread), 200),
    )
}
