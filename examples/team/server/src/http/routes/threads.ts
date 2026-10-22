import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  archiveThread,
  createThread,
  discussInChat,
  listThreads,
  renameThread,
  restoreThread,
} from '../../app/threads.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  DiscussSchema,
  ThreadCreateSchema,
  ThreadListSchema,
  ThreadParams,
  ThreadPatchSchema,
  ThreadSchema,
  ThreadsQuerySchema,
} from '../schemas/threads.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const unknown = jsonError('Unknown agent or thread')

const listRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/threads',
  tags: ['threads'],
  summary: 'Chat threads of an agent',
  description:
    'All threads are equal. Newest activity first, archived ones last (with `archived=true`). An agent that has none yet gets one for its existing single DM (`dm:<agentId>`): the history stays where it is.',
  security,
  request: { params: IdParam, query: ThreadsQuerySchema },
  responses: {
    200: { description: 'Threads', content: json(ThreadListSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/agents/{id}/threads',
  tags: ['threads'],
  summary: 'New chat',
  description:
    'Creates an empty thread; its session starts with the first message. Threads are created on demand, never by an event.',
  security,
  request: { params: IdParam, body: { required: true, content: json(ThreadCreateSchema) } },
  responses: {
    201: { description: 'The thread', content: json(ThreadSchema) },
    404: unknown,
    409: jsonError('Archived agent'),
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/agents/{id}/threads/{threadId}',
  tags: ['threads'],
  summary: 'Rename a thread',
  security,
  request: { params: ThreadParams, body: { required: true, content: json(ThreadPatchSchema) } },
  responses: {
    200: { description: 'The thread', content: json(ThreadSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const archiveRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/threads/{threadId}/archive',
  tags: ['threads'],
  summary: 'Archive a thread',
  description:
    'Hides it from the list; its history stays readable and a thread that is archived takes no new messages (409 `THREAD_ARCHIVED`) until it is restored.',
  security,
  request: { params: ThreadParams },
  responses: {
    200: { description: 'The thread', content: json(ThreadSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/threads/{threadId}/restore',
  tags: ['threads'],
  summary: 'Restore an archived thread',
  security,
  request: { params: ThreadParams },
  responses: {
    200: { description: 'The thread', content: json(ThreadSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const discussRoute = createRoute({
  method: 'post',
  path: '/threads/discuss',
  tags: ['threads'],
  summary: 'Discuss in chat',
  description:
    'Opens a NEW thread on the lead (or `agent`) seeded with the context of an alert or a run: one context message, no model call. The client then asks what they want to know.',
  security,
  request: { body: { required: true, content: json(DiscussSchema) } },
  responses: {
    201: { description: 'The new thread', content: json(ThreadSchema) },
    404: jsonError('Unknown briefing, alert, run or agent'),
    409: jsonError('No lead agent, or an archived agent'),
    ...errorResponses,
  },
})

export function threadRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) =>
      c.json(
        {
          threads: listThreads(deps, c.req.valid('param').id, {
            archived: c.req.valid('query').archived === 'true',
          }),
        },
        200,
      ),
    )
    .openapi(createRouteDef, (c) =>
      c.json(createThread(deps, c.req.valid('param').id, c.req.valid('json')), 201),
    )
    .openapi(patchRoute, (c) => {
      const { id, threadId } = c.req.valid('param')
      return c.json(renameThread(deps, id, threadId, c.req.valid('json').title), 200)
    })
    .openapi(archiveRoute, (c) => {
      const { id, threadId } = c.req.valid('param')
      return c.json(archiveThread(deps, id, threadId), 200)
    })
    .openapi(restoreRoute, (c) => {
      const { id, threadId } = c.req.valid('param')
      return c.json(restoreThread(deps, id, threadId), 200)
    })
    .openapi(discussRoute, async (c) => c.json(await discussInChat(deps, c.req.valid('json')), 201))
}
