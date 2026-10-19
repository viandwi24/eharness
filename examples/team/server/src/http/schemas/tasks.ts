import { z } from '@hono/zod-openapi'
import {
  BOARD_COLUMNS,
  EVENT_TYPES,
  QUEUE_REASONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../../app/catalog.ts'
import { ChatStatsSchema, UiMessageSchema } from './chat.ts'
import { LibraryEntrySchema, MemoryFileInfoSchema } from './library.ts'
import { RoutineSchema } from './routines.ts'

export const TaskStatusSchema = z.enum(TASK_STATUSES).openapi('TaskStatus', {
  description:
    '`queued`: in the work queue, no session yet (a worker program takes it); `needs_action`: an approval or question waits for a person; `running` (also while a run is parked on a decision: see `column` of the task for `waiting`); `retrying` (a temporary error, such as an unavailable AI provider, stopped the turn: it is continued automatically at `retry.nextAt`; see `retry`); `done`; `failed`; `stopped` (aborted); `interrupted` (its process stopped; continue it); `timed_out` (a delegation ran past its time limit).',
})

export const TaskPrioritySchema = z.enum(TASK_PRIORITIES).openapi('TaskPriority')

export const TaskReportSchema = z
  .object({
    status: z.enum(['done', 'partial', 'failed', 'needs_decision']),
    summary: z.string(),
    outputs: z
      .array(z.string())
      .openapi({ description: 'Library paths of what the run produced.' }),
    notes: z.string().optional(),
  })
  .openapi('TaskReport', {
    description: 'The structured final report a program run ends with (`SendOptions.output`).',
  })

export const DeliverableSchema = z
  .object({
    path: z.string().min(1).max(500).openapi({
      description:
        'Library file the run must leave. Tokens: `{date}` (UTC day of the run), `{slug}` (program name, or task title for a work item), `{runId}` (run timestamp in ms), `{program}` (program id).',
      example: '/library/reports/{slug}/{date}.md',
    }),
    kind: z.enum(['markdown', 'json', 'any']),
    requiredSections: z.array(z.string().min(1).max(200)).max(30).optional().openapi({
      description: 'Markdown: headings the file must have (any level, case-insensitive).',
    }),
    schema: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'JSON: a JSON Schema the parsed file must match (zod `fromJSONSchema` subset: type, properties, required, items, enum, const, min/max, pattern, additionalProperties, anyOf/oneOf/allOf, local $ref).',
    }),
    minChars: z.number().int().min(1).optional(),
  })
  .openapi('Deliverable', {
    description:
      'A file a program run must leave in the library. Checked by the server when the run ends: exists, kind, headings, JSON schema, length.',
  })

export const DeliverableCheckSchema = z
  .object({
    pattern: z.string(),
    path: z.string().openapi({ description: 'The path after the tokens were resolved.' }),
    ok: z.boolean(),
    problems: z.array(z.string()),
  })
  .openapi('DeliverableCheck')

export const DeliverableResultSchema = z
  .object({
    status: z.enum(['pass', 'fail']),
    attempts: z.number().int().openapi({
      description: '1: checked once; 2: checked again after the one fix-up turn.',
    }),
    checkedAt: z.number().int(),
    checks: z.array(DeliverableCheckSchema),
  })
  .openapi('DeliverableResult', {
    description:
      'The deliverable checks of a run. `fail`: the run is partial, a decision is open, and a work item stays out of Review.',
  })

export const GrantsSchema = z
  .object({
    tools: z.array(z.string().max(500)).max(100),
    connectors: z.array(z.string().max(500)).max(100),
    read: z.array(z.string().max(500)).max(100),
    write: z.array(z.string().max(500)).max(100),
  })
  .partial()
  .openapi('TaskGrants', {
    description:
      'Extra permissions for one task: tool names or rules, connectors (every tool), library path globs to read and to write. Pre-approved on top of what the agent has in chat.',
  })

export const TaskSchema = z
  .object({
    id: z.string(),
    agentId: z.string().openapi({ description: 'The agent that runs the task session.' }),
    sessionId: z.string().openapi({ example: 'dm:0198…:agent:call_1' }),
    parentSessionId: z
      .string()
      .nullable()
      .openapi({ description: 'The session that delegated the task (the lead DM), if any.' }),
    origin: z.enum(['user', 'lead', 'routine', 'program']),
    title: z.string(),
    status: TaskStatusSchema,
    pendingKind: z.enum(['approval', 'question']).nullable(),
    startedAt: z.number().int(),
    endedAt: z.number().int().nullable(),
    summary: z.string().nullable().openapi({ description: 'Preview of the last report.' }),
    lastActivityAt: z.number().int(),
    costUsd: z.number(),
    tokens: z.number().int(),
    report: TaskReportSchema.nullable().openapi({
      description: 'The final report of a program run; null for other tasks and while it runs.',
    }),
    deliverables: DeliverableResultSchema.nullable().openapi({
      description: 'Deliverable checks of a program run; null when the program lists none.',
    }),
    brief: z.string().nullable().openapi({
      description:
        'Work queue: what to do, in markdown (send-back notes are appended). null for tasks that did not come from the queue.',
    }),
    inputs: z.array(z.string()).openapi({ description: 'Library paths the task starts from.' }),
    priority: TaskPrioritySchema,
    dueAt: z.number().int().nullable(),
    createdBy: z.string().nullable().openapi({
      description:
        '`client` or the id of the agent that queued it; null = not a work item (no Review step).',
    }),
    acceptedAt: z.number().int().nullable().openapi({
      description:
        'When the client accepted the finished work. A done work item with a `done` or `partial` report and no `acceptedAt` is in Review.',
    }),
    round: z.number().int().openapi({ description: '1, +1 every time the work was sent back.' }),
    history: z.array(z.string()).openapi({ description: 'Sessions of earlier rounds.' }),
    hold: z.boolean().openapi({
      description: 'Queued only: the task does not start on its own; the client starts it.',
    }),
    review: z.boolean().openapi({
      description:
        'Finished work waits in Review (client-made tasks by default). false: it goes straight to Done and the creator (an agent) reads the result.',
    }),
    grants: GrantsSchema.nullable().openapi({
      description: "Extra permissions given with the task on top of the agent's own; null = none.",
    }),
    queue: z.enum(QUEUE_REASONS).nullable().optional().openapi({
      description:
        'Queued tasks only (`GET /tasks`, `GET /tasks/{id}`): why it has not started. `hold`: held by the client. `worker`: an active worker program of the agent owns the queue. `slot`: the agent (or the team) works on its maximum already; it starts when one ends. `starting`: a slot is free, it starts now.',
    }),
    queueNote: z.string().nullable().optional().openapi({
      description:
        'Queued tasks only: when a `slot` wait is held by a task that waits for the client, a sentence naming it ("waiting: <task> needs your approval first"). null otherwise.',
    }),
    retry: z
      .object({
        attempt: z.number().int().openapi({ description: 'The retry that waits (1-based).' }),
        max: z.number().int(),
        nextAt: z.number().int().openapi({ description: 'When it starts (epoch ms).' }),
        errorCode: z.string(),
        errorMessage: z
          .string()
          .openapi({ description: 'The last error, as the AI provider said it.' }),
        running: z.boolean().openapi({ description: 'The retry turn runs right now.' }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          'Only while `status` is `retrying`: the automatic retry of a temporary failure. A task that failed after its last attempt has `status: failed` and no `retry`; `POST /tasks/{id}/retry` continues it by hand.',
      }),
    column: z.enum(BOARD_COLUMNS).optional().openapi({
      description:
        'Where the board shows the task (`GET /tasks` and `GET /tasks/{id}`). `status` is what the session does; `column` adds what the client sees: a run parked on an open decision (`escalate`, `request_authority`) has `status: running` but `column: waiting`, a finished work item that is not accepted is `review`.',
    }),
  })
  .openapi('Task')

export const TaskListSchema = z.object({ tasks: z.array(TaskSchema) }).openapi('TaskList')

export const TaskIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '0198f0a2-0000-7000-8000-000000000000',
      description: 'Task id.',
    }),
})

export const QuestionSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    multiSelect: z.boolean(),
  })
  .openapi('Question')

export const ApprovalSchema = z
  .object({
    id: z.string().openapi({
      description:
        'The approval id, or the tool call id of a question: the `{id}` of `POST /attention/{id}/answer`.',
    }),
    kind: z.enum(['approval', 'question']),
    sessionId: z.string(),
    parentSessionId: z.string().nullable(),
    agentId: z.string(),
    agentName: z.string(),
    taskId: z.string().nullable(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    risk: z.enum(['read', 'write', 'external', 'unknown']).nullable(),
    questions: z.array(QuestionSchema).nullable(),
    answeredWaiting: z.number().int().openapi({
      description:
        'Items of this session that were answered already and wait for the others of the same batch (hidden from the list).',
    }),
  })
  .openapi('Approval')

export const ApprovalListSchema = z
  .object({ approvals: z.array(ApprovalSchema) })
  .openapi('ApprovalList')

export const WorkerJobSchema = z
  .object({
    status: z.enum(['running', 'finished', 'stopped']),
    chunk: z
      .number()
      .int()
      .openapi({ description: 'The chunk running now (a chunk is up to 80 steps).' }),
    steps: z.number().int().openapi({ description: 'Model steps of the finished chunks.' }),
    costUsd: z.number().openapi({ description: 'Estimated cost of the finished chunks.' }),
    startedAt: z.number().int(),
    updatedAt: z
      .number()
      .int()
      .openapi({ description: 'Last change (the last checkpoint while running).' }),
    checkpoint: z
      .string()
      .nullable()
      .openapi({ description: "The worker's last checkpoint note." }),
    stopReason: z.string().nullable().openapi({
      description:
        'Why a stopped job stopped: `stuck`, `cost`, `duration`, `stopped` (a person) or a stop of the turn.',
    }),
  })
  .openapi('WorkerJob', {
    description:
      'The long-run job of a background worker task: it runs as a chain of chunks and survives restarts.',
  })

export const TaskDetailSchema = z
  .object({
    task: TaskSchema,
    job: WorkerJobSchema.nullable().openapi({
      description: 'The long-run job of a background worker task; null for any other task.',
    }),
    messages: z
      .array(UiMessageSchema)
      .openapi({ description: 'The stored messages of the task session (newest 200).' }),
    outputs: z.array(z.string()).openapi({
      description:
        'Library paths of the files the task session wrote, newest first. Filled only with `?outputs=files` (else `[]`); works with `?messages=none`.',
    }),
    approvals: z.array(ApprovalSchema).openapi({ description: 'What the task waits for.' }),
  })
  .openapi('TaskDetail')

export const EventSchema = z
  .object({
    seq: z.number().int(),
    type: z.enum(EVENT_TYPES),
    agentId: z.string().nullable(),
    sessionId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.number().int(),
  })
  .openapi('TeamEvent', {
    description:
      'App events: `message-added` (agent, role, preview), `task-changed` (taskId, status, pendingKind, title), `agent-message` (from, to, preview), `model-call` (id, kind, status, model; one per logged provider call, for the Logs page) and the change events. Session events come from `eharness/activity` (spec 25): `turn-started` (turnId, kind, source; every turn of every session, also server-started ones), `pending-changed` (a snapshot: `waiting` = approvals / questions that wait for a person, `[]` when nothing does), `approval-decided` (id, approved, by), `attention-answered`, `session-recovered`, `child-reported`.',
  })

export const EventListSchema = z
  .object({
    events: z.array(EventSchema),
    lastSeq: z.number().int().openapi({
      description: 'Cursor for the next call: the `seq` of the last event, else the current head.',
    }),
    resync: z.literal(true).optional().openapi({
      description:
        'Present when `after` is older than the events kept by retention: some events were missed, refetch the state (agents, tasks, chats) and continue from `lastSeq`.',
    }),
  })
  .openapi('EventList')

export const ActivitySchema = z
  .object({
    lastMessageAt: z.number().int().nullable(),
    preview: z.string().nullable(),
    unread: z.number().int(),
  })
  .openapi('AgentActivity')

export const AgentSessionsSchema = z
  .object({
    dm: z.object({
      sessionId: z.string(),
      lastMessageAt: z.number().int().nullable(),
      preview: z.string().nullable(),
      unread: z.number().int(),
      pending: z
        .number()
        .int()
        .openapi({ description: 'Approvals / questions waiting in the DM.' }),
    }),
    tasks: z.array(TaskSchema).openapi({ description: 'Tasks this agent runs.' }),
    delegated: z.array(TaskSchema).openapi({ description: 'Tasks this agent handed to others.' }),
  })
  .openapi('AgentSessions')

export const ReadMarkerSchema = z
  .object({ agentId: z.string(), lastReadSeq: z.number().int() })
  .openapi('ReadMarker')

export const TaskMessageBodySchema = z
  .object({
    text: z.string().min(1).max(20_000),
    mode: z.enum(['steer', 'queue']).optional().openapi({
      description:
        '`steer` (default): joins the running turn at its next step boundary (a queued turn when idle). `queue`: a turn of its own after the running one.',
    }),
  })
  .openapi('TaskMessageBody')

export const TaskMessageResultSchema = z
  .object({
    taskId: z.string(),
    mode: z.enum(['steer', 'queue']),
    inboxId: z.string(),
    target: z.enum(['local', 'remote']),
  })
  .openapi('TaskMessageResult')

export const AgentContextSchema = z
  .object({
    agent: z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() }),
    stats: ChatStatsSchema,
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string().nullable(),
        source: z.string(),
        deferred: z.boolean(),
        tokens: z.number(),
      }),
    ),
    memory: z.object({
      workspace: z.array(MemoryFileInfoSchema),
      agent: z.array(MemoryFileInfoSchema),
    }),
    routines: z.array(RoutineSchema),
    tasks: z.object({ owned: z.array(TaskSchema), delegated: z.array(TaskSchema) }),
    files: z.array(LibraryEntrySchema),
  })
  .openapi('AgentContext')

const paths = z.array(z.string().min(1).max(500)).max(50)

export const TaskCreateSchema = z
  .object({
    agentId: z.string().min(1).openapi({ description: 'Owner: agent id or slug.' }),
    title: z.string().min(1).max(200),
    brief: z.string().max(20_000).optional(),
    inputs: paths.optional().openapi({ description: 'Library paths (start with /).' }),
    priority: TaskPrioritySchema.optional(),
    dueAt: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({ description: 'Epoch milliseconds.' }),
    hold: z.boolean().optional().openapi({
      description:
        'Do not start on its own (default false: the task starts when the agent has a free slot).',
    }),
    review: z.boolean().optional().openapi({
      description: 'Finished work waits in Review. Default true for the client.',
    }),
    grants: GrantsSchema.nullable().optional(),
  })
  .openapi('TaskCreate')

export const TaskPatchSchema = z
  .object({
    agentId: z.string().min(1).optional().openapi({ description: 'Reassign (agent id or slug).' }),
    title: z.string().min(1).max(200).optional(),
    brief: z.string().max(20_000).optional(),
    inputs: paths.optional(),
    priority: TaskPrioritySchema.optional(),
    dueAt: z.number().int().positive().nullable().optional(),
    hold: z.boolean().optional().openapi({ description: 'false releases a held task.' }),
    review: z.boolean().optional(),
    grants: GrantsSchema.nullable().optional(),
  })
  .openapi('TaskPatch')

export const TaskSendBackSchema = z
  .object({
    note: z
      .string()
      .min(1)
      .max(4000)
      .openapi({ description: 'What to change. Appended to the brief.' }),
  })
  .openapi('TaskSendBack')

export const TaskSendBackResultSchema = TaskSchema.extend({
  hint: z.string().openapi({
    description:
      'What happens next: it starts on its own, waits for a free slot of the agent, or (an active worker program of the agent) is picked up by that program at its next run.',
  }),
}).openapi('TaskSendBackResult')
