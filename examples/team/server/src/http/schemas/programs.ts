import { z } from '@hono/zod-openapi'
import { RoutineSpecSchema } from './routines.ts'
import { TaskSchema } from './tasks.ts'

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

export const ProgramTriggerStateSchema = z
  .object({
    status: z.enum(['active', 'paused']),
    pausedReason: z
      .enum(['manual', 'max-failures', 'max-fires', 'ended', 'completed', 'agent-archived'])
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
    status: z.enum(['active', 'paused']),
    createdBy: z.string().openapi({ description: '`client`, or the id of the proposing agent.' }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    version: z.number().int(),
    triggerState: ProgramTriggerStateSchema.nullable(),
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
    version: z
      .number()
      .int()
      .optional()
      .describe(
        'The `version` the editor loaded; a different current version answers 409 `VERSION_CONFLICT`.',
      ),
  })
  .openapi('ProgramPatch')

export const ProgramRunStartedSchema = z
  .object({
    sessionId: z.string().openapi({ example: 'program:0198…:1760000000000' }),
    taskId: z.string().nullable(),
    started: z.boolean().openapi({ description: 'false: that run existed already.' }),
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
