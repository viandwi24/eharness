import { z } from '@hono/zod-openapi'
import { EVENT_TYPES, TASK_STATUSES } from '../../app/catalog.ts'
import { ChatStatsSchema, UiMessageSchema } from './chat.ts'
import { LibraryEntrySchema, MemoryFileInfoSchema } from './library.ts'
import { RoutineSchema } from './routines.ts'

export const TaskStatusSchema = z.enum(TASK_STATUSES).openapi('TaskStatus', {
  description:
    '`needs_action`: an approval or question waits for a person; `running`; `done`; `failed`; `stopped` (aborted); `interrupted` (its process stopped; continue it); `timed_out` (a delegation ran past its time limit).',
})

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

export const TaskDetailSchema = z
  .object({
    task: TaskSchema,
    messages: z
      .array(UiMessageSchema)
      .openapi({ description: 'The stored messages of the task session (newest 200).' }),
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
