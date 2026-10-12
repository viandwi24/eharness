import { z } from '@hono/zod-openapi'
import { RoutineSpecSchema } from './routines.ts'
import { DeliverableSchema, TaskSchema } from './tasks.ts'

const list = (max: number) => z.array(z.string().min(1).max(500)).max(max)

export const ProgramAuthoritySchema = z
  .object({
    tools: list(100).openapi({
      description:
        'Tool names or permission rule specifiers the run may use (`web_fetch`, `Bash(git status)`, `WebFetch(domain:example.com)`). Enforced by the permission engine.',
    }),
    connectors: list(100).openapi({
      description: 'Connector or connection ids: every tool of them is allowed.',
    }),
    read: list(100).openapi({
      description: 'Library path globs the run may read (`/library/data/**`).',
    }),
    write: list(100).openapi({
      description:
        'Library path globs the run may write (`/library/reports/**`); they are readable too.',
    }),
  })
  .openapi('ProgramAuthority')

export const ProgramBudgetSchema = z
  .object({
    perRunUsd: z.number().positive().nullable().openapi({
      description: 'One run stops (`cost-cap`) when it has spent this much. null = no limit.',
    }),
    perDayUsd: z.number().positive().nullable().openapi({
      description:
        'All runs of the program in one UTC day stop at this spend (ledger scope `program:<id>:<day>`). null = no limit.',
    }),
    maxOutputTokens: z.number().int().min(256).max(65536).nullable().optional().openapi({
      description:
        'Output tokens one model call of a run may produce. Every call reserves its worst case (context + this cap at the model price) against the budgets before it runs, so a small cap is what lets a small budget work. null / absent: sized from the budget (at most 16 384).',
    }),
  })
  .openapi('ProgramBudget')

export const ProgramTriggerSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('schedule'), spec: RoutineSpecSchema }),
  ])
  .openapi('ProgramTrigger', {
    description:
      '`manual`: runs only on "run now". `schedule`: the routine scheduler fires it (same claim, overlap, recovery and failure rules as routines).',
  })

const ReportSchema = z.enum(['digest', 'task', 'silent']).openapi({
  description:
    '`digest`: a line in the client digest; `task`: the run on the board; `silent`: nothing beyond the run history.',
})

export const ProgramWorkerSchema = z
  .object({
    maxTasks: z.number().int().min(1).max(20).openapi({
      description: 'Queued tasks one run takes at most; each runs in a session of its own.',
    }),
  })
  .openapi('ProgramWorker', {
    description:
      'Makes the program a worker program (the work queue): each run claims the next queued tasks of its agent (priority, then due date, then age), one session per task, and finishing moves a task to Review.',
  })

export const ProgramTriggerStateSchema = z
  .object({
    status: z.enum(['active', 'paused']),
    pausedReason: z
      .enum([
        'manual',
        'max-failures',
        'max-fires',
        'ended',
        'completed',
        'agent-archived',
        'unrunnable',
      ])
      .nullable(),
    nextFireAt: z.number().int().nullable(),
    lastFireAt: z.number().int().nullable(),
    lastStatus: z.string().nullable(),
    failures: z.number().int(),
  })
  .openapi('ProgramTriggerState', {
    description:
      'The routine that owns the schedule trigger (it pauses itself after repeated failures).',
  })

export const ProgramWarningSchema = z
  .object({
    code: z.enum(['tool-unavailable', 'tool-off', 'channel-not-bound', 'budget-below-minimum']),
    field: z.string().openapi({ example: 'authority.tools' }),
    message: z.string(),
  })
  .openapi('ProgramWarning', {
    description:
      'Something the program cannot do as configured: a tool in its authority its agent never has (its connector is off, or the agent is not bound to a channel), or a budget below the cost of one model call. Warnings never block a save.',
  })

const GrantedToolSchema = z.object({
  name: z.string(),
  kind: z.enum(['read', 'write', 'destructive', 'external', 'unknown']),
  status: z.enum(['granted', 'gate', 'off', 'unavailable']).openapi({
    description:
      '`granted`: usable; `gate`: a write of a third-party connector, refused until the client decides; `off`: connector mode Off; `unavailable`: the agent has no such tool.',
  }),
})

export const EffectiveGrantSchema = z
  .object({
    connectors: z.array(
      z.object({
        requested: z.string(),
        id: z.string().nullable(),
        label: z.string(),
        tools: z.array(GrantedToolSchema),
      }),
    ),
    tools: z.array(GrantedToolSchema),
    read: z.array(z.string()),
    write: z.array(z.string()),
  })
  .openapi('EffectiveGrant', {
    description:
      'What an authority really gives: the tools each connector resolves to, read or write.',
  })

export const ProgramSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    brief: z.string(),
    authority: ProgramAuthoritySchema,
    gates: z.array(z.string()).openapi({
      description:
        'Actions that still need the client (told to the agent; decisions come in a later phase).',
    }),
    escalation: z.string(),
    forbidden: z.array(z.string()).openapi({
      description:
        'Rules or tool names denied in every case (deny rules of the permission engine).',
    }),
    budget: ProgramBudgetSchema,
    trigger: ProgramTriggerSchema,
    report: ReportSchema,
    worker: ProgramWorkerSchema.nullable(),
    deliverables: z.array(DeliverableSchema).openapi({
      description: 'Files each run must leave in the library; checked when the run ends.',
    }),
    status: z.enum(['active', 'paused']),
    createdBy: z.string().openapi({ description: '`client`, or the id of the proposing agent.' }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    version: z.number().int(),
    triggerState: ProgramTriggerStateSchema.nullable(),
    warnings: z.array(ProgramWarningSchema).optional().openapi({
      description: 'Only on the answers of create and update: see `ProgramWarning`.',
    }),
    grant: EffectiveGrantSchema.nullable().optional().openapi({
      description: 'The effective grant of the authority (null when the agent is not activated).',
    }),
  })
  .openapi('Program')

export const ProgramListSchema = z
  .object({ programs: z.array(ProgramSchema) })
  .openapi('ProgramList')

const fields = {
  name: z.string().min(1).max(120),
  brief: z.string().min(1).max(20_000),
  escalation: z.string().max(20_000),
  gates: list(100),
}

export const ProgramCreateSchema = z
  .object({
    agentId: z.string().min(1).openapi({ description: 'Agent id or slug.' }),
    name: fields.name,
    brief: fields.brief,
    authority: ProgramAuthoritySchema.partial().optional(),
    gates: fields.gates.optional(),
    escalation: fields.escalation.optional(),
    forbidden: list(100).optional(),
    budget: ProgramBudgetSchema.partial().optional(),
    trigger: ProgramTriggerSchema.optional(),
    report: ReportSchema.optional(),
    worker: ProgramWorkerSchema.partial().nullable().optional(),
    deliverables: z.array(DeliverableSchema).max(20).optional(),
  })
  .openapi('ProgramCreate')

export const ProgramPatchSchema = z
  .object({
    name: fields.name.optional(),
    brief: fields.brief.optional(),
    authority: ProgramAuthoritySchema.partial().optional(),
    gates: fields.gates.optional(),
    escalation: fields.escalation.optional(),
    forbidden: list(100).optional(),
    budget: ProgramBudgetSchema.partial().optional(),
    trigger: ProgramTriggerSchema.optional(),
    report: ReportSchema.optional(),
    worker: ProgramWorkerSchema.partial().nullable().optional(),
    deliverables: z.array(DeliverableSchema).max(20).optional(),
    version: z
      .number()
      .int()
      .optional()
      .describe(
        'The `version` the editor loaded; a different current version answers 409 `VERSION_CONFLICT`.',
      ),
  })
  .openapi('ProgramPatch')

export const ProgramCheckSchema = z
  .object({
    agentId: z.string().min(1).openapi({ description: 'Agent id or slug.' }),
    authority: ProgramAuthoritySchema.partial().optional(),
    budget: ProgramBudgetSchema.partial().optional(),
  })
  .openapi('ProgramCheck')

export const ProgramCheckResultSchema = z
  .object({
    warnings: z.array(ProgramWarningSchema),
    grant: EffectiveGrantSchema.nullable(),
    errors: z.array(z.string()).openapi({
      description:
        'Problems that would refuse a save (unknown connector or tool), with the valid options.',
    }),
    repaired: z.array(z.object({ from: z.string(), to: z.string() })),
  })
  .openapi('ProgramCheckResult')

export const ProgramRunStartedSchema = z
  .object({
    sessionId: z.string().nullable().openapi({
      example: 'program:0198…:1760000000000',
      description: 'null for a worker program with nothing queued (`idle`).',
    }),
    taskId: z.string().nullable(),
    started: z
      .boolean()
      .openapi({ description: 'false: that run existed already, or nothing was queued.' }),
    idle: z
      .boolean()
      .openapi({ description: 'true: a worker program found no queued task for its agent.' }),
  })
  .openapi('ProgramRunStarted')

export const ProgramRunsSchema = z
  .object({
    runs: z
      .array(TaskSchema)
      .openapi({ description: 'Task sessions of the program, newest first.' }),
  })
  .openapi('ProgramRuns')

export const ProgramIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Program id.' }),
})

export const RememberedDecisionSchema = z
  .object({
    id: z.string(),
    programId: z.string(),
    subject: z.string(),
    question: z.string(),
    choice: z.string(),
    note: z.string(),
    decisionId: z.string(),
    decidedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .openapi('RememberedDecision', {
    description:
      'A stand-down answer ("keep waiting", "skip") the client gave; later runs of the program do not ask it again until it expires.',
  })

export const ProgramMemorySchema = z
  .object({ remembered: z.array(RememberedDecisionSchema) })
  .openapi('ProgramMemory')

export const ProgramMemoryParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
  memoryId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'memoryId', in: 'path' } }),
})
