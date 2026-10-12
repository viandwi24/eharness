import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  authorityGrant,
  checkProgramDraft,
  createProgram,
  deleteProgram,
  forgetProgramMemory,
  getProgram,
  listPrograms,
  pauseProgram,
  programMemory,
  programRuns,
  programView,
  programWithWarnings,
  resumeProgram,
  runProgramNow,
  updateProgram,
} from '../../app/programs.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  ProgramCheckResultSchema,
  ProgramCheckSchema,
  ProgramCreateSchema,
  ProgramIdParam,
  ProgramListSchema,
  ProgramMemoryParam,
  ProgramMemorySchema,
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

const checkRoute = createRoute({
  method: 'post',
  path: '/programs/check',
  tags: ['programs'],
  summary: 'What a program cannot do as configured',
  description:
    'Checks an agent, an authority and a budget (nothing is stored): tools the authority names that the agent never has (its connector is off; a channel tool while the agent is bound to no channel connection) and a budget below what one model call reserves on the agent model. The editor calls it while the client types; create and update answer with the same `warnings`.',
  security,
  request: { body: { required: true, content: json(ProgramCheckSchema) } },
  responses: {
    200: { description: 'Warnings', content: json(ProgramCheckResultSchema) },
    404: jsonError('Unknown agent'),
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
    'The authority is read on every tool call: an edit applies to a run in progress from its next call (a widening approved in the Decision Center reaches the run that asked), and to every later run. Changing the trigger moves the schedule.',
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

const memoryRoute = createRoute({
  method: 'get',
  path: '/programs/{id}/memory',
  tags: ['programs'],
  summary: 'Decisions the program remembers',
  security,
  request: params,
  responses: {
    200: { description: 'Remembered decisions', content: json(ProgramMemorySchema) },
    404: unknown,
    ...errorResponses,
  },
})

const forgetRoute = createRoute({
  method: 'delete',
  path: '/programs/{id}/memory/{memoryId}',
  tags: ['programs'],
  summary: 'Forget a remembered decision',
  security,
  request: { params: ProgramMemoryParam },
  responses: {
    200: { description: 'Forgotten', content: json(ProgramMemorySchema) },
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
    .openapi(checkRoute, async (c) => {
      const body = c.req.valid('json')
      const inspection = await authorityGrant(deps, body.agentId, body.authority)
      return c.json(
        {
          warnings: await checkProgramDraft(deps, body),
          grant: inspection?.grant ?? null,
          errors: inspection?.errors ?? [],
          repaired: inspection?.repaired ?? [],
        },
        200,
      )
    })
    .openapi(createRoute_, async (c) => {
      const body = c.req.valid('json')
      // activate the agent first: the authority is checked against what it really has
      await authorityGrant(deps, body.agentId, undefined)
      return c.json((await programWithWarnings(deps, createProgram(deps, body))) as never, 201)
    })
    .openapi(getRoute, async (c) => {
      const view = programView(deps, getProgram(deps, c.req.valid('param').id))
      const inspection = await authorityGrant(deps, view.agentId, view.authority)
      return c.json({ ...view, grant: inspection?.grant ?? null } as never, 200)
    })
    .openapi(patchRoute, async (c) => {
      const id = c.req.valid('param').id
      await authorityGrant(deps, getProgram(deps, id).agentId, undefined)
      return c.json(
        (await programWithWarnings(deps, updateProgram(deps, id, c.req.valid('json')))) as never,
        200,
      )
    })
    .openapi(deleteRoute_, (c) =>
      c.json(programView(deps, deleteProgram(deps, c.req.valid('param').id)) as never, 200),
    )
    .openapi(pauseRoute, (c) => c.json(pauseProgram(deps, c.req.valid('param').id) as never, 200))
    .openapi(resumeRoute, (c) => c.json(resumeProgram(deps, c.req.valid('param').id) as never, 200))
    .openapi(runRoute, async (c) =>
      c.json((await runProgramNow(deps, c.req.valid('param').id)) as never, 202),
    )
    .openapi(memoryRoute, (c) =>
      c.json({ remembered: programMemory(deps, c.req.valid('param').id) } as never, 200),
    )
    .openapi(forgetRoute, (c) => {
      const { id, memoryId } = c.req.valid('param')
      forgetProgramMemory(deps, id, memoryId)
      return c.json({ remembered: programMemory(deps, id) } as never, 200)
    })
    .openapi(runsRoute, (c) => {
      const { limit } = c.req.valid('query')
      return c.json({ runs: programRuns(deps, c.req.valid('param').id, limit) } as never, 200)
    })
}
