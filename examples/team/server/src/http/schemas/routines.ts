import { z } from '@hono/zod-openapi'

export const RoutineSpecSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('cron'),
      expr: z.string().min(1).max(200).openapi({ example: '0 9 * * 1-5' }),
      tz: z.string().min(1).max(100).openapi({ example: 'Europe/Berlin' }),
    }),
    z.object({
      kind: z.literal('every'),
      everyMs: z.number().int().min(10_000).openapi({ example: 3_600_000 }),
    }),
    z.object({ kind: z.literal('at'), at: z.number().int().openapi({ description: 'Epoch ms.' }) }),
  ])
  .openapi('RoutineSpec', {
    description:
      '`cron` (5 or 6 fields, IANA timezone, croner syntax), `every` (interval in ms, at least 10 s) or `at` (one shot).',
  })

const SessionModeSchema = z.enum(['dm', 'task']).openapi({
  description:
    '`dm`: the fire is appended to the agent DM chat. `task`: every fire runs in a new task session `routine:<id>:<slot>` (shows on the board).',
})
const OverlapSchema = z.enum(['skip', 'queue']).openapi({
  description:
    '`skip`: a fire is dropped while the previous one still runs or waits. `queue`: it queues behind.',
})

export const RoutineSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    prompt: z.string(),
    schedule: RoutineSpecSchema,
    sessionMode: SessionModeSchema,
    overlap: OverlapSchema,
    catchUpWindowMs: z.number().int().nullable().openapi({
      description:
        'null: fires missed during downtime are skipped. Else the latest missed slot fires once when it is younger than this.',
    }),
    status: z.enum(['active', 'paused']),
    pausedReason: z
      .enum(['manual', 'max-failures', 'max-fires', 'ended', 'completed', 'agent-archived'])
      .nullable(),
    nextFireAt: z.number().int().nullable(),
    lastFireAt: z.number().int().nullable(),
    lastStatus: z.string().nullable(),
    failures: z.number().int().openapi({ description: 'Consecutive failed runs.' }),
    maxFailures: z
      .number()
      .int()
      .openapi({ description: 'The routine pauses itself at this many.' }),
    fireCount: z.number().int(),
    maxFires: z.number().int().nullable(),
    endAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    version: z.number().int(),
  })
  .openapi('Routine')

export const RoutineListSchema = z
  .object({ routines: z.array(RoutineSchema) })
  .openapi('RoutineList')

const fields = {
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(20_000),
  schedule: RoutineSpecSchema,
  sessionMode: SessionModeSchema,
  overlap: OverlapSchema,
  catchUpWindowMs: z.number().int().min(1).nullable(),
  maxFailures: z.number().int().min(1),
  maxFires: z.number().int().min(1).nullable(),
  endAt: z.number().int().nullable(),
}

export const RoutineCreateSchema = z
  .object({
    agentId: z.string().min(1).openapi({ description: 'Agent id or slug.' }),
    name: fields.name,
    prompt: fields.prompt,
    schedule: fields.schedule,
    sessionMode: fields.sessionMode.optional(),
    overlap: fields.overlap.optional(),
    catchUpWindowMs: fields.catchUpWindowMs.optional(),
    maxFailures: fields.maxFailures.optional(),
    maxFires: fields.maxFires.optional(),
    endAt: fields.endAt.optional(),
  })
  .openapi('RoutineCreate')

export const RoutinePatchSchema = z
  .object({
    name: fields.name.optional(),
    prompt: fields.prompt.optional(),
    schedule: fields.schedule.optional(),
    sessionMode: fields.sessionMode.optional(),
    overlap: fields.overlap.optional(),
    catchUpWindowMs: fields.catchUpWindowMs.optional(),
    maxFailures: fields.maxFailures.optional(),
    maxFires: fields.maxFires.optional(),
    endAt: fields.endAt.optional(),
    version: z
      .number()
      .int()
      .optional()
      .describe(
        'The `version` the editor loaded; a different current version answers 409 `VERSION_CONFLICT`.',
      ),
  })
  .openapi('RoutinePatch')

export const RoutineRunSchema = z
  .object({
    id: z.string(),
    routineId: z.string(),
    scheduledAt: z.number().int(),
    trigger: z.enum(['schedule', 'manual']),
    status: z.enum(['claimed', 'enqueued', 'needs_action', 'succeeded', 'failed', 'skipped']),
    sessionId: z.string(),
    inboxId: z.string().nullable(),
    reason: z.string().nullable(),
    claimedAt: z.number().int(),
    firedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
  })
  .openapi('RoutineRun')

export const RoutineRunsSchema = z
  .object({ runs: z.array(RoutineRunSchema) })
  .openapi('RoutineRuns')

export const RoutineIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Routine id.' }),
})
