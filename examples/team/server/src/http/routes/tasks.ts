import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { answerApproval, listApprovals } from '../../app/approvals.ts'
import { listEvents, markAgentRead } from '../../app/events.ts'
import type { Deps } from '../../app/ports.ts'
import { agentSessions, getTask, listTasks } from '../../app/tasks.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  AgentSessionsSchema,
  ApprovalAcceptedSchema,
  ApprovalBodySchema,
  ApprovalListSchema,
  EventListSchema,
  EventsStreamSchema,
  ReadMarkerSchema,
  TaskDetailSchema,
  TaskIdParam,
  TaskListSchema,
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
    '`respond()` on the session that owns the item, from whichever instance receives the request. Nothing streams: the continuation runs server side (a child task continues, and when it ends the lead that waits for it resumes by itself) and shows in the events feed.',
    '',
    '- Approval: `{ approved, reason?, note?, endTurn? }`. `note` is shown to the model after the result; `endTurn` ends the turn after the answer without a model call (`after-answers`, or `if-denied`).',
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
    202: { description: 'Recorded; the session continues', content: json(ApprovalAcceptedSchema) },
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
    'Every instance tails the `events` table (poll, 500 ms), so a client connected to instance B sees what instance A did. Starts after `after` (or `Last-Event-ID`); without either it starts at the current head (new events only).',
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
    .openapi(answerRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const view = await answerApproval(
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
            },
        body.sessionId,
      )
      return c.json(
        { accepted: true as const, id: view.id, sessionId: view.sessionId, agentId: view.agentId },
        202,
      )
    })
    .openapi(eventsRoute, (c) => {
      const { after, limit } = c.req.valid('query')
      return c.json(listEvents(deps, { after: Number(after ?? 0), limit }), 200)
    })
    .openapi(streamRoute, (c) => {
      const { after } = c.req.valid('query')
      const header = c.req.header('last-event-id')
      const explicit =
        after ?? (header !== undefined && /^\d{1,15}$/.test(header) ? header : undefined)
      let cursor = explicit === undefined ? deps.tasks.lastSeq() : Number(explicit)
      const pollMs = deps.eventsPollMs ?? 500
      return raw(
        streamSSE(c, async (stream) => {
          let quiet = 0
          try {
            while (!stream.aborted && !stream.closed) {
              const { events } = listEvents(deps, { after: cursor, limit: 200 })
              for (const event of events) {
                await stream.writeSSE({
                  id: String(event.seq),
                  event: event.type,
                  data: JSON.stringify(event),
                })
                cursor = event.seq
              }
              quiet = events.length === 0 ? quiet + pollMs : 0
              if (quiet >= 15_000) {
                await stream.write(': keep-alive\n\n')
                quiet = 0
              }
              await stream.sleep(pollMs)
            }
          } catch {
            // the client went away, or the server is closing: end the stream
          }
        }),
      )
    })
    .openapi(sessionsRoute, async (c) =>
      c.json((await agentSessions(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(readRoute, (c) => c.json(markAgentRead(deps, c.req.valid('param').id), 200))
}
