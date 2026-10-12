import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { recheckTask } from '../../app/deliverables.ts'
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
import {
  acceptTask,
  cancelQueuedTask,
  createTask,
  sendBackHint,
  sendBackTask,
  startTaskNow,
  updateQueuedTask,
  withColumns,
} from '../../app/work-queue.ts'
import { errorResponses, IdParam, jsonError, ThreadQuery } from '../schemas/common.ts'
import {
  AgentContextSchema,
  AgentSessionsSchema,
  ApprovalListSchema,
  ReadMarkerSchema,
  TaskCreateSchema,
  TaskDetailSchema,
  TaskIdParam,
  TaskListSchema,
  TaskMessageBodySchema,
  TaskMessageResultSchema,
  TaskPatchSchema,
  TaskSchema,
  TaskSendBackResultSchema,
  TaskSendBackSchema,
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

const createTaskRoute = createRoute({
  method: 'post',
  path: '/tasks',
  tags: ['tasks'],
  summary: 'Queue a task for an agent (the work queue)',
  description:
    'Assigns a task to an agent: it has an owner, a brief, inputs (library paths), a priority, an optional due date, optional `grants` (extra permissions for this task) and `hold` / `review` flags. It starts on its own (`status: queued` until the agent has a free slot, see `Agent.taskConcurrency`) and the agent works with its normal tools and permissions, as in chat. An agent with an active worker program leaves its queue to that program. Managers do the same with the `create_task` tool.',
  security,
  request: { body: { required: true, content: json(TaskCreateSchema) } },
  responses: {
    201: { description: 'Queued', content: json(TaskSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('The agent is archived'),
    ...errorResponses,
  },
})

const patchTaskRoute = createRoute({
  method: 'patch',
  path: '/tasks/{id}',
  tags: ['tasks'],
  summary: 'Change a queued task',
  description:
    'Re-prioritise, reassign, rewrite, set a due date, grants, hold (`hold: false` releases a held task). `409 TASK_NOT_QUEUED` once it started.',
  security,
  request: { params: TaskIdParam, body: { required: true, content: json(TaskPatchSchema) } },
  responses: {
    200: { description: 'The task', content: json(TaskSchema) },
    404: jsonError('Unknown task or agent'),
    409: jsonError('`TASK_NOT_QUEUED`'),
    ...errorResponses,
  },
})

const cancelTaskRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/cancel',
  tags: ['tasks'],
  summary: 'Cancel a queued task',
  description:
    'The task ends `stopped`. A task that already runs is stopped from its session instead.',
  security,
  request: { params: TaskIdParam },
  responses: {
    200: { description: 'The task', content: json(TaskSchema) },
    404: jsonError('Unknown task'),
    409: jsonError('`TASK_NOT_QUEUED`'),
    ...errorResponses,
  },
})

const startTaskRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/start',
  tags: ['tasks'],
  summary: 'Start a queued task now',
  description:
    'Starts a queued task at once: a held task, one that waits for a free slot of its agent, or one an active worker program has not taken yet. The agent works on it with its normal tools and permissions (plus the task grants). `409 TASK_NOT_QUEUED` once it runs.',
  security,
  request: { params: TaskIdParam },
  responses: {
    200: { description: 'The task, running', content: json(TaskSchema) },
    404: jsonError('Unknown task'),
    409: jsonError('`TASK_NOT_QUEUED` or the agent is archived'),
    ...errorResponses,
  },
})

const acceptTaskRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/accept',
  tags: ['tasks'],
  summary: 'Accept finished work in Review',
  description:
    'Review = a done work item (it came through the queue) whose report status is `done` or `partial` and that was not accepted yet.',
  security,
  request: { params: TaskIdParam },
  responses: {
    200: { description: 'The task', content: json(TaskSchema) },
    404: jsonError('Unknown task'),
    409: jsonError('`TASK_NOT_IN_REVIEW`'),
    ...errorResponses,
  },
})

const sendBackRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/send-back',
  tags: ['tasks'],
  summary: 'Send finished work back with a note',
  description:
    'The task is queued again with the note appended to its brief (`round` + 1) and starts on its own, so the agent revises it in a new session (the earlier ones stay in `history`). Also retries a work item that failed, stopped or was interrupted.',
  security,
  request: { params: TaskIdParam, body: { required: true, content: json(TaskSendBackSchema) } },
  responses: {
    200: {
      description: 'The task, queued again, and what happens next',
      content: json(TaskSendBackResultSchema),
    },
    404: jsonError('Unknown task'),
    409: jsonError('`TASK_NOT_IN_REVIEW`'),
    ...errorResponses,
  },
})

const checkDeliverablesRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/deliverables/check',
  tags: ['tasks'],
  summary: 'Check the deliverables of a run again',
  description:
    "Checks the files of the run against its program's deliverables now (no fix-up turn). Use it after the files were repaired: a passing result lets a work item enter Review.",
  security,
  request: { params: TaskIdParam },
  responses: {
    200: { description: 'The task with the new result', content: json(TaskSchema) },
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
  summary: 'The chat thread and the tasks of an agent',
  security,
  request: { params: IdParam, query: ThreadQuery },
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
    'For one chat thread (`thread`, default the newest). Session stats and usage, the tools the model sees, memory file lists (workspace and agent), routines, current tasks and the latest files the agent wrote.',
  security,
  request: { params: IdParam, query: ThreadQuery },
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
      const tasks = listTasks(deps, {
        limit,
        ...(status === undefined ? {} : { status }),
        ...(agentId === undefined ? {} : { agentId }),
      })
      return c.json({ tasks: withColumns(deps, tasks) }, 200)
    })
    .openapi(taskRoute, async (c) => {
      const detail = await getTask(deps, c.req.valid('param').id)
      const [task] = withColumns(deps, [detail.task])
      return c.json({ ...detail, task } as never, 200)
    })
    .openapi(createTaskRoute, (c) =>
      c.json(createTask(deps, c.req.valid('json') as never) as never, 201),
    )
    .openapi(patchTaskRoute, (c) =>
      c.json(
        updateQueuedTask(deps, c.req.valid('param').id, c.req.valid('json') as never) as never,
        200,
      ),
    )
    .openapi(cancelTaskRoute, (c) =>
      c.json(cancelQueuedTask(deps, c.req.valid('param').id) as never, 200),
    )
    .openapi(startTaskRoute, (c) =>
      c.json(startTaskNow(deps, c.req.valid('param').id) as never, 200),
    )
    .openapi(acceptTaskRoute, (c) =>
      c.json(acceptTask(deps, c.req.valid('param').id) as never, 200),
    )
    .openapi(sendBackRoute, (c) => {
      const task = sendBackTask(deps, c.req.valid('param').id, c.req.valid('json').note)
      return c.json({ ...task, hint: sendBackHint(deps, task) } as never, 200)
    })
    .openapi(checkDeliverablesRoute, async (c) =>
      c.json((await recheckTask(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(approvalsRoute, async (c) => c.json({ approvals: await listApprovals(deps) }, 200))
    .openapi(sessionsRoute, async (c) =>
      c.json(
        (await agentSessions(deps, c.req.valid('param').id, c.req.valid('query').thread)) as never,
        200,
      ),
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
      c.json(
        (await agentContext(deps, c.req.valid('param').id, c.req.valid('query').thread)) as never,
        200,
      ),
    )
    .openapi(readRoute, (c) => c.json(markAgentRead(deps, c.req.valid('param').id), 200))
}
