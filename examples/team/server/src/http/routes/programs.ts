import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  createProgram,
  deleteProgram,
  getProgram,
  listPrograms,
  pauseProgram,
  programRuns,
  programView,
  resumeProgram,
  runProgramNow,
  updateProgram,
} from '../../app/programs.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  ProgramCreateSchema,
  ProgramIdParam,
  ProgramListSchema,
  ProgramPatchSchema,
  ProgramRunStartedSchema,
  ProgramRunsSchema,
  ProgramSchema,
} from '../schemas/programs.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const params = { params: ProgramIdParam }
const unknown = jsonError('Unknown program')

const listRoute = createRoute({
  method: 'get',
  path: '/programs',
  tags: ['programs'],
  summary: 'List programs',
  security,
  request: {
    query: z.object({
      agentId: z.string().optional().openapi({ description: 'Only this agent (id or slug).' }),
    }),
  },
  responses: {
    200: { description: 'Programs', content: json(ProgramListSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/programs',
  tags: ['programs'],
  summary: 'Create a program',
  description:
    'A standing order for an agent: brief, authority, gates, escalation, forbidden, budget, trigger and report. Each run is a task session `program:<id>:<runAt>` that follows Execute, Verify, Report and ends with a structured report. The authority is enforced by the permission engine for the run: allowed tools and paths run without approval, `forbidden` is denied, everything else is refused (nobody is there to ask).',
  security,
  request: { body: { required: true, content: json(ProgramCreateSchema) } },
  responses: {
    201: { description: 'Created', content: json(ProgramSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('Archived agent or a schedule without a next slot'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/programs/{id}',
  tags: ['programs'],
  summary: 'A program',
  security,
  request: params,
  responses: {
    200: { description: 'The program', content: json(ProgramSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/programs/{id}',
  tags: ['programs'],
  summary: 'Edit a program',
  description:
    'A run already in progress keeps the authority it started with; the next run uses the new one. Changing the trigger moves the schedule.',
  security,
  request: { ...params, body: { required: true, content: json(ProgramPatchSchema) } },
  responses: {
    200: { description: 'The program', content: json(ProgramSchema) },
    404: unknown,
    409: jsonError('Version conflict or a schedule without a next slot'),
    ...errorResponses,
  },
})

const deleteRoute_ = createRoute({
  method: 'delete',
  path: '/programs/{id}',
  tags: ['programs'],
  summary: 'Delete a program',
  description:
    'Removes the program and its schedule. The task sessions of its past runs stay on the board.',
  security,
  request: params,
  responses: {
    200: { description: 'The deleted program', content: json(ProgramSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const pauseRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/pause',
  tags: ['programs'],
  summary: 'Pause a program',
  description: 'Stops the schedule trigger. A run in progress finishes.',
  security,
  request: params,
  responses: {
    200: { description: 'The program', content: json(ProgramSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const resumeRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/resume',
  tags: ['programs'],
  summary: 'Resume a program',
  description: 'Recomputes the next slot from now: nothing missed while paused fires.',
  security,
  request: params,
  responses: {
    200: { description: 'The program', content: json(ProgramSchema) },
    404: unknown,
    409: jsonError('Archived agent or a finished schedule'),
    ...errorResponses,
  },
})

const runRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/run',
  tags: ['programs'],
  summary: 'Run now',
  description:
    'Starts a run now (the schedule is untouched). Returns when the run has started, not when it ends: follow the task session. `409 PROGRAM_BUSY` while another run of the program is going.',
  security,
  request: params,
  responses: {
    202: { description: 'Started', content: json(ProgramRunStartedSchema) },
    404: unknown,
    409: jsonError('`PROGRAM_BUSY` or archived agent'),
    ...errorResponses,
  },
})

const runsRoute = createRoute({
  method: 'get',
  path: '/programs/{id}/runs',
  tags: ['programs'],
  summary: 'Run history, newest first',
  description:
    'The task sessions of the program, each with its structured report once the run ended.',
  security,
  request: {
    ...params,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  },
  responses: {
    200: { description: 'Runs', content: json(ProgramRunsSchema) },
    404: unknown,
    ...errorResponses,
  },
})

export function programRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => {
      const { agentId } = c.req.valid('query')
      return c.json(
        { programs: listPrograms(deps, agentId === undefined ? {} : { agentId }) } as never,
        200,
      )
    })
    .openapi(createRoute_, (c) => c.json(createProgram(deps, c.req.valid('json')) as never, 201))
    .openapi(getRoute, (c) =>
      c.json(programView(deps, getProgram(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(patchRoute, (c) =>
      c.json(updateProgram(deps, c.req.valid('param').id, c.req.valid('json')) as never, 200),
    )
    .openapi(deleteRoute_, (c) =>
      c.json(programView(deps, deleteProgram(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(pauseRoute, (c) => c.json(pauseProgram(deps, c.req.valid('param').id) as never, 200))
    .openapi(resumeRoute, (c) => c.json(resumeProgram(deps, c.req.valid('param').id) as never, 200))
    .openapi(runRoute, async (c) =>
      c.json((await runProgramNow(deps, c.req.valid('param').id)) as never, 202),
    )
    .openapi(runsRoute, (c) => {
      const { limit } = c.req.valid('query')
      return c.json({ runs: programRuns(deps, c.req.valid('param').id, limit) } as never, 200)
    })
}
