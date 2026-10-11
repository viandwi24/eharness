import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { answerApproval, listApprovals } from '../../app/approvals.ts'
import { listEvents, markAgentRead } from '../../app/events.ts'
import type { Deps } from '../../app/ports.ts'
import {
  abortTask,
  agentContext,
  agentSessions,
  getTask,
  listTasks,
  messageTask,
  resumeTask,
} from '../../app/tasks.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  AgentContextSchema,
  AgentSessionsSchema,
  ApprovalAcceptedSchema,
  ApprovalBodySchema,
  ApprovalListSchema,
  EventListSchema,
  EventsStreamSchema,
  ReadMarkerSchema,
  TaskAbortBodySchema,
  TaskAbortResultSchema,
  TaskDetailSchema,
  TaskIdParam,
  TaskListSchema,
  TaskMessageBodySchema,
  TaskMessageResultSchema,
  TaskStatusSchema,
} from '../schemas/tasks.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

/** A raw `Response` (an SSE stream) satisfies any declared response. */
const raw = (response: Response): never => response as never

const afterQuery = z
  .string()
  .regex(/^\d{1,15}$/)
  .optional()

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

const taskStreamRoute = createRoute({
  method: 'get',
  path: '/tasks/{id}/stream',
  tags: ['tasks'],
  summary: 'Follow the running turn of a task (UI message stream)',
  description:
    'Replays the chunks of the active turn of the task session from `from` and follows it until it ends, also when another instance runs it (stream log, ADR-0039). `204` when nothing streams: use `GET /tasks/{id}`. A continuation turn after an approval replays only the continuation.',
  security,
  request: {
    params: TaskIdParam,
    query: z.object({
      from: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional()
        .openapi({
          description: 'Chunk cursor (0-based). Also read from `Last-Event-ID`. Default 0.',
        }),
    }),
  },
  responses: {
    200: {
      description: 'The UI message stream from the cursor',
      content: { 'text/event-stream': { schema: EventsStreamSchema } },
    },
    204: { description: 'No turn is streaming' },
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
    'Pending tool approvals and `ask_user_question` questions of every DM chat and every delegated task, read from the stored session state (any instance).',
  security,
  responses: {
    200: { description: 'Pending items', content: json(ApprovalListSchema) },
    ...errorResponses,
  },
})

const answerRoute = createRoute({
  method: 'post',
  path: '/approvals/{id}',
  tags: ['approvals'],
  summary: 'Answer an approval or a question',
  description: [
    '`respond()` on the session that owns the item, from whichever instance receives the request. A step can raise several approvals at once: each answer is recorded on its own (`status: "recorded"`, `remaining` = items still waiting) and the answer to the last one resumes the session (`status: "resumed"`). Nothing streams: the continuation runs server side (a child task continues, and when it ends the lead that waits for it resumes by itself) and shows in the events feed.',
    '',
    '- Approval: `{ approved, reason?, note?, remember?, endTurn? }`. `remember: "session"` grants the tool for the rest of the session. `note` is shown to the model after the result; `endTurn` ends the turn after the answer without a model call (`after-answers`, or `if-denied`).',
    '- Question: `{ answers }` (one per question, `null` dismisses).',
    '',
    'An item that is gone (answered elsewhere) is `404`; a stale answer or a running turn is `409`.',
  ].join('\n'),
  security,
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .openapi({
          param: { name: 'id', in: 'path' },
          description: 'The `id` of an item of `GET /approvals`.',
        }),
    }),
    body: { required: true, content: json(ApprovalBodySchema) },
  },
  responses: {
    202: {
      description: 'Recorded (`recorded`) or recorded and resumed (`resumed`)',
      content: json(ApprovalAcceptedSchema),
    },
    404: jsonError('No such pending item'),
    409: jsonError('Stale answer, ambiguous id, or a turn of the session is running'),
    ...errorResponses,
  },
})

const eventsRoute = createRoute({
  method: 'get',
  path: '/events',
  tags: ['events'],
  summary: 'Events after a cursor (JSON)',
  security,
  request: {
    query: z.object({
      after: afterQuery.openapi({ description: 'Return events with a higher `seq`. Default 0.' }),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  },
  responses: {
    200: { description: 'Events, oldest first', content: json(EventListSchema) },
    ...errorResponses,
  },
})

const streamRoute = createRoute({
  method: 'get',
  path: '/events/stream',
  tags: ['events'],
  summary: 'Live event feed (SSE)',
  description:
    'The `eharness/activity` stream: every instance tails the shared events log (poll, 500 ms), so a client connected to instance B sees what instance A did. Starts after `after` (or `Last-Event-ID`); without either it starts at the current head (new events only). Frames: `retry` + `: connected` + `event: boot` at once; `resync` when the cursor is behind the retention mark or ahead of the head; `: keep-alive` every 15 s.',
  security,
  request: {
    query: z.object({
      after: afterQuery.openapi({ description: 'Replay events with a higher `seq`.' }),
    }),
  },
  responses: {
    200: {
      description: 'Server-sent events',
      content: { 'text/event-stream': { schema: EventsStreamSchema } },
    },
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

const abortRoute = createRoute({
  method: 'post',
  path: '/tasks/{id}/abort',
  tags: ['tasks'],
  summary: 'Stop the running turn of a task (any instance)',
  description:
    '`requestAbort()` on the task session: the instance that runs the turn stops it within one poll. A task that waits for an approval has no running turn (`target: idle`): answer or deny the approval instead.',
  security,
  request: {
    params: TaskIdParam,
    body: { required: false, content: json(TaskAbortBodySchema) },
  },
  responses: {
    200: { description: 'Where the abort went', content: json(TaskAbortResultSchema) },
    404: jsonError('Unknown task'),
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
  return (
    new OpenAPIHono()
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
      .openapi(taskStreamRoute, async (c) =>
        raw(await resumeTask(deps, c.req.valid('param').id, c.req.raw)),
      )
      .openapi(approvalsRoute, async (c) => c.json({ approvals: await listApprovals(deps) }, 200))
      .openapi(answerRoute, async (c) => {
        const { id } = c.req.valid('param')
        const body = c.req.valid('json')
        const { view, outcome } = await answerApproval(
          deps,
          id,
          'answers' in body
            ? { kind: 'question', answers: body.answers }
            : {
                kind: 'approval',
                approved: body.approved,
                ...(body.reason === undefined ? {} : { reason: body.reason }),
                ...(body.note === undefined ? {} : { note: body.note }),
                ...(body.endTurn === undefined ? {} : { endTurn: body.endTurn }),
                ...(body.remember === undefined ? {} : { remember: body.remember }),
              },
          body.sessionId,
        )
        return c.json(
          {
            accepted: true as const,
            status: outcome.status,
            remaining: outcome.status === 'recorded' ? outcome.remaining : 0,
            id: view.id,
            sessionId: view.sessionId,
            agentId: view.agentId,
          },
          202,
        )
      })
      .openapi(eventsRoute, async (c) => {
        const { after, limit } = c.req.valid('query')
        return c.json(await listEvents(deps, { after: Number(after ?? 0), limit }), 200)
      })
      // the library's SSE handler: initial flush, boot id, keep-alives, Last-Event-ID, resync
      .openapi(streamRoute, (c) => raw(deps.feed.stream(c.req.raw)))
      .openapi(sessionsRoute, async (c) =>
        c.json((await agentSessions(deps, c.req.valid('param').id)) as never, 200),
      )
      .openapi(abortRoute, async (c) => {
        const body = c.req.valid('json')
        return c.json(await abortTask(deps, c.req.valid('param').id, body?.reason), 200)
      })
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
  )
}
