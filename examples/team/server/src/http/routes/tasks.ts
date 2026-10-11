import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { markAgentRead } from '../../app/events.ts'
import type { Deps } from '../../app/ports.ts'
import {
  agentContext,
  agentSessions,
  getTask,
  listApprovals,
  listTasks,
  messageTask,
} from '../../app/tasks.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  AgentContextSchema,
  AgentSessionsSchema,
  ApprovalListSchema,
  ReadMarkerSchema,
  TaskDetailSchema,
  TaskIdParam,
  TaskListSchema,
  TaskMessageBodySchema,
  TaskMessageResultSchema,
  TaskStatusSchema,
} from '../schemas/tasks.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const tasksRoute = createRoute({
  method: 'get',
  path: '/tasks',
  tags: ['tasks'],
  summary: 'The task board: tasks across agents',
  description:
    'Tasks are delegated runs (child sessions of the lead). The index is written by every instance on turn start / end and repaired at boot, so it is the same for all of them. Newest activity first.',
  security,
  request: {
    query: z.object({
      status: TaskStatusSchema.optional().openapi({ description: 'Only this status.' }),
      agentId: z
        .string()
        .optional()
        .openapi({ description: 'Only tasks of this agent (id or slug).' }),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: { description: 'Tasks', content: json(TaskListSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const taskRoute = createRoute({
  method: 'get',
  path: '/tasks/{id}',
  tags: ['tasks'],
  summary: 'A task with the messages of its session and what it waits for',
  security,
  request: { params: TaskIdParam },
  responses: {
    200: { description: 'The task', content: json(TaskDetailSchema) },
    404: jsonError('Unknown task'),
    ...errorResponses,
  },
})

const approvalsRoute = createRoute({
  method: 'get',
  path: '/approvals',
  tags: ['approvals'],
  summary: 'Everything that waits for a person, across all sessions',
  description:
    'Pending tool approvals and `ask_user_question` questions of every DM chat and every delegated task, read from the stored session state (any instance), with the agent, the task and the question texts. Answer with `POST /attention/{id}/answer` (`eharness/http`). `id` and `sessionId` of an item go into that route.',
  security,
  responses: {
    200: { description: 'Pending items', content: json(ApprovalListSchema) },
    ...errorResponses,
  },
})

const sessionsRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/sessions',
  tags: ['agents'],
  summary: 'The DM chat and the tasks of an agent',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'DM state, owned and delegated tasks', content: json(AgentSessionsSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const readRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/read',
  tags: ['agents'],
  summary: 'Mark the chat of an agent as read (clears its unread count)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The new marker', content: json(ReadMarkerSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const messageRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/messages',
  tags: ['tasks'],
  summary: 'Send a message into the session of a task',
  description:
    'Through the durable inbox (`enqueue`), so it reaches the instance that holds the session. `steer` joins the running turn at its next step boundary; `queue` runs after it. On an idle or finished task either starts a turn of the task agent. While approvals are pending the message waits behind them.',
  security,
  request: {
    params: TaskIdParam,
    body: { required: true, content: json(TaskMessageBodySchema) },
  },
  responses: {
    202: { description: 'Stored in the inbox', content: json(TaskMessageResultSchema) },
    404: jsonError('Unknown task'),
    ...errorResponses,
  },
})

const contextRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/context',
  tags: ['agents'],
  summary: 'Everything the right panel of an agent shows',
  description:
    'Session stats and usage, the tools the model sees, memory file lists (workspace and agent), routines, current tasks and the latest files the agent wrote.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Context', content: json(AgentContextSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

export function taskRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(tasksRoute, (c) => {
      const { status, agentId, limit } = c.req.valid('query')
      return c.json(
        {
          tasks: listTasks(deps, {
            limit,
            ...(status === undefined ? {} : { status }),
            ...(agentId === undefined ? {} : { agentId }),
          }),
        },
        200,
      )
    })
    .openapi(taskRoute, async (c) => {
      const detail = await getTask(deps, c.req.valid('param').id)
      return c.json(detail as never, 200)
    })
    .openapi(approvalsRoute, async (c) => c.json({ approvals: await listApprovals(deps) }, 200))
    .openapi(sessionsRoute, async (c) =>
      c.json((await agentSessions(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(messageRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json(
        await messageTask(deps, c.req.valid('param').id, {
          text: body.text,
          ...(body.mode === undefined ? {} : { mode: body.mode }),
        }),
        202,
      )
    })
    .openapi(contextRoute, async (c) =>
      c.json((await agentContext(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(readRoute, (c) => c.json(markAgentRead(deps, c.req.valid('param').id), 200))
}
