import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  pauseRoutine,
  resumeRoutine,
  routineRuns,
  runRoutineNow,
  updateRoutine,
} from '../../app/routines.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  RoutineCreateSchema,
  RoutineIdParam,
  RoutineListSchema,
  RoutinePatchSchema,
  RoutineRunSchema,
  RoutineRunsSchema,
  RoutineSchema,
} from '../schemas/routines.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const params = { params: RoutineIdParam }
const unknown = jsonError('Unknown routine')

const listRoute = createRoute({
  method: 'get',
  path: '/routines',
  tags: ['routines'],
  summary: 'List routines',
  security,
  request: {
    query: z.object({
      agentId: z.string().optional().openapi({ description: 'Only this agent (id or slug).' }),
    }),
  },
  responses: {
    200: { description: 'Routines', content: json(RoutineListSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/routines',
  tags: ['routines'],
  summary: 'Create a routine',
  description:
    'A scheduled prompt for an agent. Every instance ticks; the one that wins the compare-and-set on `nextFireAt` fires the slot, once (`session.enqueue` with the deterministic id `sched:<id>:<slot>`). Missed fires after downtime are skipped (or the latest one fires within `catchUpWindowMs`); overlap defaults to `skip`. A fire that needs an approval lands in `GET /approvals` (needs action) and is never approved by the scheduler.',
  security,
  request: { body: { required: true, content: json(RoutineCreateSchema) } },
  responses: {
    201: { description: 'Created', content: json(RoutineSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived agent or a schedule without a next slot'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/routines/{id}',
  tags: ['routines'],
  summary: 'A routine',
  security,
  request: params,
  responses: {
    200: { description: 'The routine', content: json(RoutineSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/routines/{id}',
  tags: ['routines'],
  summary: 'Edit a routine',
  description: 'Changing the schedule of an active routine recomputes its next slot from now.',
  security,
  request: { ...params, body: { required: true, content: json(RoutinePatchSchema) } },
  responses: {
    200: { description: 'The routine', content: json(RoutineSchema) },
    404: unknown,
    409: jsonError('Schedule without a next slot'),
    ...errorResponses,
  },
})

const deleteRoute_ = createRoute({
  method: 'delete',
  path: '/routines/{id}',
  tags: ['routines'],
  summary: 'Delete a routine and its run history',
  security,
  request: params,
  responses: {
    200: { description: 'The deleted routine', content: json(RoutineSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const pauseRoute = createRoute({
  method: 'post',
  path: '/routines/{id}/pause',
  tags: ['routines'],
  summary: 'Pause a routine',
  security,
  request: params,
  responses: {
    200: { description: 'The routine', content: json(RoutineSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const resumeRoute = createRoute({
  method: 'post',
  path: '/routines/{id}/resume',
  tags: ['routines'],
  summary: 'Resume a routine',
  description:
    'Recomputes the next slot from now (nothing missed while paused fires) and resets the failure counter.',
  security,
  request: params,
  responses: {
    200: { description: 'The routine', content: json(RoutineSchema) },
    404: unknown,
    409: jsonError('Ended, exhausted or archived agent'),
    ...errorResponses,
  },
})

const runRoute = createRoute({
  method: 'post',
  path: '/routines/{id}/run',
  tags: ['routines'],
  summary: 'Run now',
  description:
    'A manual fire with the same enqueue path; the schedule is untouched. `409 ROUTINE_BUSY` when overlap is `skip` and the previous run is still in the way.',
  security,
  request: params,
  responses: {
    202: {
      description: 'Enqueued (or failed to enqueue: see `status`)',
      content: json(RoutineRunSchema),
    },
    404: unknown,
    409: jsonError('`ROUTINE_BUSY` or archived agent'),
    ...errorResponses,
  },
})

const runsRoute = createRoute({
  method: 'get',
  path: '/routines/{id}/runs',
  tags: ['routines'],
  summary: 'Run history, newest first',
  security,
  request: {
    ...params,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  },
  responses: {
    200: { description: 'Runs', content: json(RoutineRunsSchema) },
    404: unknown,
    ...errorResponses,
  },
})

export function routineRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => {
      const { agentId } = c.req.valid('query')
      return c.json(
        { routines: listRoutines(deps, agentId === undefined ? {} : { agentId }) } as never,
        200,
      )
    })
    .openapi(createRoute_, (c) => {
      const b = c.req.valid('json')
      return c.json(
        createRoutine(deps, {
          agentId: b.agentId,
          name: b.name,
          prompt: b.prompt,
          schedule: b.schedule,
          sessionMode: b.sessionMode,
          overlap: b.overlap,
          catchUpWindowMs: b.catchUpWindowMs,
          maxFailures: b.maxFailures,
          maxFires: b.maxFires,
          endAt: b.endAt,
        }) as never,
        201,
      )
    })
    .openapi(getRoute, (c) => c.json(getRoutine(deps, c.req.valid('param').id) as never, 200))
    .openapi(patchRoute, (c) => {
      const b = c.req.valid('json')
      return c.json(updateRoutine(deps, c.req.valid('param').id, b) as never, 200)
    })
    .openapi(deleteRoute_, (c) =>
      c.json(deleteRoutine(deps, c.req.valid('param').id) as never, 200),
    )
    .openapi(pauseRoute, (c) => c.json(pauseRoutine(deps, c.req.valid('param').id) as never, 200))
    .openapi(resumeRoute, (c) => c.json(resumeRoutine(deps, c.req.valid('param').id) as never, 200))
    .openapi(runRoute, async (c) =>
      c.json((await runRoutineNow(deps, c.req.valid('param').id)) as never, 202),
    )
    .openapi(runsRoute, (c) => {
      const { limit } = c.req.valid('query')
      return c.json({ runs: routineRuns(deps, c.req.valid('param').id, limit) } as never, 200)
    })
}
