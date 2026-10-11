import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  createTest,
  deleteRehearsal,
  deleteTest,
  getRehearsal,
  listRehearsals,
  listTests,
  rehearsalFile,
  rehearsalMessages,
  runTests,
  startRehearsal,
  updateTest,
} from '../../app/rehearsal.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import { ProgramIdParam } from '../schemas/programs.ts'
import {
  RehearsalIdParam,
  RehearsalListSchema,
  RehearsalMessagesSchema,
  RehearsalSchema,
  RehearsalStartSchema,
  TestCaseSchema,
  TestCreateSchema,
  TestIdParam,
  TestListSchema,
  TestPatchSchema,
  TestRunSchema,
  TestRunStartedSchema,
} from '../schemas/rehearsal.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const raw = (response: Response): never => response as never
const unknownProgram = jsonError('Unknown program')
const unknownRehearsal = jsonError('Unknown rehearsal')

const startRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/rehearsals',
  tags: ['rehearsals'],
  summary: 'Test run (rehearsal) of a program',
  description:
    'Runs the program as it is saved now on sample data, in a safe mode: its own session `rehearsal:<programId>:<ts>` (never a task: not in the run history, the board, the digest or the heartbeat); library writes go to a scratch overlay and the real library is never modified (reads see the real library unless the sample says `reads: sample`); tools of external connectors that write are simulated (`SIMULATED: would call <tool> with <input>`) and recorded; decisions it would raise are recorded as "would ask", none is created; a separate small budget cap. Send `{}` for the defaults. Returns when the run has started: poll `GET /rehearsals/{id}`.',
  security,
  request: {
    params: ProgramIdParam,
    body: { required: true, content: json(RehearsalStartSchema) },
  },
  responses: {
    201: { description: 'Created: the rehearsal is running', content: json(RehearsalSchema) },
    404: unknownProgram,
    409: jsonError('`REHEARSAL_BUSY` or archived agent'),
    ...errorResponses,
  },
})

const listRoute = createRoute({
  method: 'get',
  path: '/programs/{id}/rehearsals',
  tags: ['rehearsals'],
  summary: 'Rehearsals of a program, newest first',
  description: 'Without the content of the produced files (read one rehearsal for that).',
  security,
  request: {
    params: ProgramIdParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
  },
  responses: {
    200: { description: 'Rehearsals', content: json(RehearsalListSchema) },
    404: unknownProgram,
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/rehearsals/{id}',
  tags: ['rehearsals'],
  summary: 'A rehearsal with its result',
  security,
  request: { params: RehearsalIdParam },
  responses: {
    200: { description: 'The rehearsal', content: json(RehearsalSchema) },
    404: unknownRehearsal,
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/rehearsals/{id}',
  tags: ['rehearsals'],
  summary: 'Delete a finished rehearsal',
  security,
  request: { params: RehearsalIdParam },
  responses: {
    200: { description: 'The deleted rehearsal', content: json(RehearsalSchema) },
    404: unknownRehearsal,
    409: jsonError('`REHEARSAL_BUSY`: still running'),
    ...errorResponses,
  },
})

const fileRoute = createRoute({
  method: 'get',
  path: '/rehearsals/{id}/file',
  tags: ['rehearsals'],
  summary: 'Download a file the rehearsal produced',
  description:
    'The bytes with `Content-Disposition: attachment`. Files over the stored caps have no content (404).',
  security,
  request: {
    params: RehearsalIdParam,
    query: z.object({ path: z.string().min(1).max(500) }),
  },
  responses: {
    200: {
      description: 'The file',
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
    },
    404: jsonError('Unknown rehearsal or file, or the content was not stored'),
    ...errorResponses,
  },
})

const messagesRoute = createRoute({
  method: 'get',
  path: '/rehearsals/{id}/messages',
  tags: ['rehearsals'],
  summary: 'The chat of the rehearsal session (read only)',
  security,
  request: { params: RehearsalIdParam },
  responses: {
    200: { description: 'Messages, oldest first', content: json(RehearsalMessagesSchema) },
    404: unknownRehearsal,
    ...errorResponses,
  },
})

const testsRoute = createRoute({
  method: 'get',
  path: '/programs/{id}/tests',
  tags: ['rehearsals'],
  summary: 'Test cases of a program, with a summary',
  description:
    'The summary says how many pass, fail (at the current program version) or are stale (never run, or not run since the last edit). The web warns when a program with failing tests is activated; it is not a block.',
  security,
  request: { params: ProgramIdParam },
  responses: {
    200: { description: 'Test cases', content: json(TestListSchema) },
    404: unknownProgram,
    ...errorResponses,
  },
})

const createTestRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/tests',
  tags: ['rehearsals'],
  summary: 'Save a test case',
  description:
    'Sample inputs plus expectations (deliverables must pass, tools that must not be called, an expected report status). Give `rehearsalId` to save the sample of a rehearsal you just ran.',
  security,
  request: { params: ProgramIdParam, body: { required: true, content: json(TestCreateSchema) } },
  responses: {
    201: { description: 'Created', content: json(TestCaseSchema) },
    404: jsonError('Unknown program or rehearsal'),
    409: jsonError('Too many test cases'),
    ...errorResponses,
  },
})

const runTestsRoute = createRoute({
  method: 'post',
  path: '/programs/{id}/tests/run',
  tags: ['rehearsals'],
  summary: 'Run the test cases',
  description:
    'Re-runs all cases (or one with `caseId`) one after the other in the background, each as a rehearsal; poll `GET /programs/{id}/tests` for the results.',
  security,
  request: { params: ProgramIdParam, body: { required: true, content: json(TestRunSchema) } },
  responses: {
    202: { description: 'Started', content: json(TestRunStartedSchema) },
    404: jsonError('Unknown program or case'),
    409: jsonError('`TESTS_BUSY`'),
    ...errorResponses,
  },
})

const patchTestRoute = createRoute({
  method: 'patch',
  path: '/program-tests/{id}',
  tags: ['rehearsals'],
  summary: 'Edit a test case',
  description: 'Changing the sample or the expectations clears the last result.',
  security,
  request: { params: TestIdParam, body: { required: true, content: json(TestPatchSchema) } },
  responses: {
    200: { description: 'The case', content: json(TestCaseSchema) },
    404: jsonError('Unknown test case'),
    ...errorResponses,
  },
})

const deleteTestRoute = createRoute({
  method: 'delete',
  path: '/program-tests/{id}',
  tags: ['rehearsals'],
  summary: 'Delete a test case',
  security,
  request: { params: TestIdParam },
  responses: {
    200: { description: 'The deleted case', content: json(TestCaseSchema) },
    404: jsonError('Unknown test case'),
    ...errorResponses,
  },
})

export function rehearsalRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(startRoute, async (c) => {
      return c.json(
        (await startRehearsal(deps, c.req.valid('param').id, c.req.valid('json'))) as never,
        201,
      )
    })
    .openapi(listRoute, (c) => {
      const { limit } = c.req.valid('query')
      return c.json(
        { rehearsals: listRehearsals(deps, c.req.valid('param').id, limit) } as never,
        200,
      )
    })
    .openapi(getRoute, (c) => c.json(getRehearsal(deps, c.req.valid('param').id) as never, 200))
    .openapi(deleteRoute, (c) =>
      c.json(deleteRehearsal(deps, c.req.valid('param').id) as never, 200),
    )
    .openapi(fileRoute, (c) => {
      const file = rehearsalFile(deps, c.req.valid('param').id, c.req.valid('query').path)
      const body =
        file.text !== null
          ? new TextEncoder().encode(file.text)
          : file.base64 !== null
            ? new Uint8Array(Buffer.from(file.base64, 'base64'))
            : undefined
      if (body === undefined) {
        return c.json(
          { error: { code: 'NOT_FOUND', message: `the content of ${file.path} was not stored` } },
          404,
        )
      }
      const name = file.path.split('/').pop() ?? 'file'
      return raw(
        new Response(body as unknown as BodyInit, {
          headers: {
            'content-type': file.mediaType ?? 'application/octet-stream',
            'content-length': String(body.byteLength),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'x-content-type-options': 'nosniff',
          },
        }),
      )
    })
    .openapi(messagesRoute, async (c) =>
      c.json({ messages: await rehearsalMessages(deps, c.req.valid('param').id) } as never, 200),
    )
    .openapi(testsRoute, (c) => c.json(listTests(deps, c.req.valid('param').id) as never, 200))
    .openapi(createTestRoute, (c) =>
      c.json(createTest(deps, c.req.valid('param').id, c.req.valid('json')) as never, 201),
    )
    .openapi(runTestsRoute, (c) => {
      const { caseId } = c.req.valid('json')
      return c.json(runTests(deps, c.req.valid('param').id, caseId) as never, 202)
    })
    .openapi(patchTestRoute, (c) =>
      c.json(updateTest(deps, c.req.valid('param').id, c.req.valid('json')) as never, 200),
    )
    .openapi(deleteTestRoute, (c) =>
      c.json(deleteTest(deps, c.req.valid('param').id) as never, 200),
    )
}
