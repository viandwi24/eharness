import { z } from '@hono/zod-openapi'
import { EVENT_TYPES, MAX_NOTE_CHARS, TASK_STATUSES } from '../../app/catalog.ts'
import { ChatStatsSchema, UiMessageSchema } from './chat.ts'
import { LibraryEntrySchema, MemoryFileInfoSchema } from './library.ts'
import { RoutineSchema } from './routines.ts'

export const TaskStatusSchema = z.enum(TASK_STATUSES).openapi('TaskStatus', {
  description:
    '`needs_action`: an approval or question waits for a person; `running`; `done`; `failed`; `stopped` (aborted).',
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
    origin: z.enum(['user', 'lead', 'routine']),
    title: z.string(),
    status: TaskStatusSchema,
    pendingKind: z.enum(['approval', 'question']).nullable(),
    startedAt: z.number().int(),
    endedAt: z.number().int().nullable(),
    summary: z.string().nullable().openapi({ description: 'Preview of the last report.' }),
    lastActivityAt: z.number().int(),
    costUsd: z.number(),
    tokens: z.number().int(),
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
        'The approval id, or the tool call id of a question: the `{id}` of `POST /approvals/{id}`.',
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

const SessionHint = z.string().optional().openapi({
  description: 'Session of the item; only needed when two sessions carry the same id.',
})

export const ApprovalDecisionSchema = z
  .object({
    approved: z.boolean(),
    reason: z
      .string()
      .max(2000)
      .optional()
      .openapi({ description: 'Shown to the model when denied.' }),
    note: z.string().max(MAX_NOTE_CHARS).optional().openapi({
      description:
        'A free-text note of the person about this call: the model reads it right after the result (approved) or as part of the reason (denied).',
    }),
    endTurn: z.enum(['after-answers', 'if-denied']).optional().openapi({
      description:
        'End the turn after the answer without calling the model again (spec 11): always, or only when denied.',
    }),
    sessionId: SessionHint,
  })
  .openapi('ApprovalDecision', { description: 'Answer of a tool approval.' })

export const QuestionAnswerSchema = z
  .object({
    answers: z
      .array(
        z.object({
          selected: z.array(z.string()).optional(),
          other: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .nullable()
      .openapi({ description: 'One answer per question, in order; null dismisses the questions.' }),
    sessionId: SessionHint,
  })
  .openapi('QuestionAnswer', { description: 'Answer of an `ask_user_question` question.' })

export const ApprovalBodySchema = z
  .union([ApprovalDecisionSchema, QuestionAnswerSchema])
  .openapi('ApprovalAnswer')

export const ApprovalAcceptedSchema = z
  .object({
    accepted: z.literal(true),
    id: z.string(),
    sessionId: z.string(),
    agentId: z.string(),
  })
  .openapi('ApprovalAccepted', {
    description:
      'The answer is recorded and the session continues in the background; follow it with the events feed.',
  })

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
      '`message-added` (agent, role, preview), `task-changed` (taskId, status, pendingKind, title), `approval-needed` (id, kind, toolName), `approval-decided`, `agent-message` (from, to, preview).',
  })

export const EventListSchema = z
  .object({
    events: z.array(EventSchema),
    lastSeq: z.number().int().openapi({
      description: 'Cursor for the next call: the `seq` of the last event, else the current head.',
    }),
  })
  .openapi('EventList')

export const EventsStreamSchema = z.string().openapi({
  description:
    'Server-sent events: `id` = seq, `event` = type, `data` = the JSON event. A comment line every 15 s keeps the connection open.',
  example: 'id: 12\nevent: task-changed\ndata: {"seq":12,"type":"task-changed",…}\n\n',
})

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

export const TaskAbortBodySchema = z
  .object({ reason: z.string().max(500).optional() })
  .openapi('TaskAbortBody')

export const TaskAbortResultSchema = z
  .object({
    taskId: z.string(),
    target: z.enum(['local', 'remote', 'idle', 'unsupported']).openapi({
      description:
        '`local`/`remote`: the turn was told to stop (here or on another instance). `idle`: nothing was running.',
    }),
  })
  .openapi('TaskAbortResult')

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
