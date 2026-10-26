import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  activateScript,
  createScript,
  decideApproval,
  deleteScript,
  disableScript,
  dryRunScript,
  enableScript,
  getRun,
  getScript,
  getVersion,
  listRuns,
  listScripts,
  listVersions,
  runScriptNow,
  scriptKv,
  scriptTypesText,
  updateScript,
  WEB_OWNER,
  wideningOf,
} from '../../app/scripts.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  ActivateSchema,
  DecisionSchema,
  DryRunResultSchema,
  DryRunSchema,
  RunNowSchema,
  RunParam,
  RunsQuery,
  ScriptCreateSchema,
  ScriptDeletedSchema,
  ScriptDetailSchema,
  ScriptKvSchema,
  ScriptListSchema,
  ScriptParam,
  ScriptPatchSchema,
  ScriptRunListSchema,
  ScriptRunSchema,
  ScriptSchema,
  ScriptTypesSchema,
  ScriptUpdatedSchema,
  ScriptVersionListSchema,
  ScriptVersionSchema,
  VersionParam,
} from '../schemas/scripts.ts'

const security = [{ Bearer: [] }]
const tags = ['scripts']
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const unknownScript = jsonError('Unknown script')
const conflictError = jsonError('Not possible in the current state (see the message)')

const listRoute = createRoute({
  method: 'get',
  path: '/scripts',
  tags,
  summary: 'List scripts',
  security,
  responses: {
    200: { description: 'Scripts', content: json(ScriptListSchema) },
    ...errorResponses,
  },
})

const typesRoute = createRoute({
  method: 'get',
  path: '/scripts-types',
  tags,
  summary: 'The scripts.d.ts and the ctx methods',
  security,
  responses: { 200: { description: 'Types', content: json(ScriptTypesSchema) }, ...errorResponses },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/scripts',
  tags,
  summary: 'Create a script (draft, version 1)',
  security,
  request: { body: { required: true, content: json(ScriptCreateSchema) } },
  responses: {
    201: { description: 'The script', content: json(ScriptSchema) },
    409: jsonError('A script with that name exists'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}',
  tags,
  summary: 'A script with its latest version',
  security,
  request: { params: ScriptParam },
  responses: {
    200: { description: 'The script', content: json(ScriptDetailSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/scripts/{script}',
  tags,
  summary: 'Update a script; new code or manifest adds a version (the running one stays)',
  security,
  request: { params: ScriptParam, body: { required: true, content: json(ScriptPatchSchema) } },
  responses: {
    200: { description: 'The script and the new version', content: json(ScriptUpdatedSchema) },
    404: unknownScript,
    409: conflictError,
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/scripts/{script}',
  tags,
  summary: 'Delete a script with its versions, runs and state',
  security,
  request: { params: ScriptParam },
  responses: {
    200: { description: 'Deleted', content: json(ScriptDeletedSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const versionsRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}/versions',
  tags,
  summary: 'Versions, newest first (without source)',
  security,
  request: { params: ScriptParam },
  responses: {
    200: { description: 'Versions', content: json(ScriptVersionListSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const versionRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}/versions/{version}',
  tags,
  summary: 'One version with its source',
  security,
  request: { params: VersionParam },
  responses: {
    200: { description: 'The version', content: json(ScriptVersionSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const action = (path: string, summary: string, body?: z.ZodType) =>
  createRoute({
    method: 'post',
    path: `/scripts/{script}/${path}`,
    tags,
    summary,
    security,
    request: {
      params: ScriptParam,
      ...(body === undefined ? {} : { body: { required: false, content: json(body) } }),
    },
    responses: {
      200: { description: 'The script', content: json(ScriptSchema) },
      404: unknownScript,
      409: conflictError,
      ...errorResponses,
    },
  })

const activateRoute = action(
  'activate',
  'Run a version (default the latest); the owner activates directly',
  ActivateSchema,
)
const approveRoute = action('approve', 'Approve the version an agent asked to run', DecisionSchema)
const rejectRoute = action('reject', 'Reject the version an agent asked to run', DecisionSchema)
const disableRoute = action('disable', 'Switch the script off')
const enableRoute = action('enable', 'Switch the script on again with the version it ran')

const dryRunRoute = createRoute({
  method: 'post',
  path: '/scripts/{script}/dry-run',
  tags,
  summary: 'Run a version with side effects recorded, not done',
  security,
  request: { params: ScriptParam, body: { required: true, content: json(DryRunSchema) } },
  responses: {
    200: { description: 'The run and the trigger matches', content: json(DryRunResultSchema) },
    404: unknownScript,
    409: conflictError,
    ...errorResponses,
  },
})

const runRoute = createRoute({
  method: 'post',
  path: '/scripts/{script}/run',
  tags,
  summary: 'Run the active version now, for real',
  security,
  request: { params: ScriptParam, body: { required: false, content: json(RunNowSchema) } },
  responses: {
    200: { description: 'The run', content: json(ScriptRunSchema) },
    404: unknownScript,
    409: conflictError,
    ...errorResponses,
  },
})

const runsRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}/runs',
  tags,
  summary: 'Run traces, newest first',
  security,
  request: { params: ScriptParam, query: RunsQuery },
  responses: {
    200: { description: 'Runs', content: json(ScriptRunListSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const runOneRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}/runs/{runId}',
  tags,
  summary: 'One run trace',
  security,
  request: { params: RunParam },
  responses: {
    200: { description: 'The run', content: json(ScriptRunSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

const kvRoute = createRoute({
  method: 'get',
  path: '/scripts/{script}/kv',
  tags,
  summary: 'The key-value state of the script',
  security,
  request: { params: ScriptParam },
  responses: {
    200: { description: 'Entries', content: json(ScriptKvSchema) },
    404: unknownScript,
    ...errorResponses,
  },
})

async function bodyOf<T>(req: { json(): Promise<unknown> }): Promise<T | undefined> {
  try {
    return (await req.json()) as T
  } catch {
    return undefined
  }
}

export function scriptRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => c.json({ scripts: listScripts(deps) } as never, 200))
    .openapi(typesRoute, (c) => c.json(scriptTypesText(deps) as never, 200))
    .openapi(createRoute_, async (c) =>
      c.json((await createScript(deps, WEB_OWNER, c.req.valid('json'))) as never, 201),
    )
    .openapi(getRoute, (c) => {
      const s = getScript(deps, c.req.valid('param').script)
      const latest = getVersion(deps, s.id)
      const pending =
        s.approval.state === 'pending' && s.approval.version !== null
          ? getVersion(deps, s.id, s.approval.version)
          : latest
      const widening = s.activeVersion === pending.version ? [] : wideningOf(deps, s, pending)
      return c.json({ script: s, latest, widening } as never, 200)
    })
    .openapi(patchRoute, async (c) =>
      c.json(
        (await updateScript(
          deps,
          WEB_OWNER,
          c.req.valid('param').script,
          c.req.valid('json'),
        )) as never,
        200,
      ),
    )
    .openapi(deleteRoute, (c) => {
      deleteScript(deps, WEB_OWNER, c.req.valid('param').script)
      return c.json({ deleted: true } as never, 200)
    })
    .openapi(versionsRoute, (c) =>
      c.json(
        {
          versions: listVersions(deps, c.req.valid('param').script).map(({ source: _, ...v }) => v),
        } as never,
        200,
      ),
    )
    .openapi(versionRoute, (c) => {
      const p = c.req.valid('param')
      return c.json(getVersion(deps, p.script, p.version) as never, 200)
    })
    .openapi(activateRoute, async (c) => {
      const body = (await bodyOf<{ version?: number; note?: string }>(c.req)) ?? {}
      return c.json(
        activateScript(deps, WEB_OWNER, c.req.valid('param').script, body).script as never,
        200,
      )
    })
    .openapi(approveRoute, async (c) => {
      const body = (await bodyOf<{ version?: number; note?: string }>(c.req)) ?? {}
      return c.json(
        decideApproval(deps, WEB_OWNER, c.req.valid('param').script, {
          approve: true,
          ...body,
        }) as never,
        200,
      )
    })
    .openapi(rejectRoute, async (c) => {
      const body = (await bodyOf<{ version?: number; note?: string }>(c.req)) ?? {}
      return c.json(
        decideApproval(deps, WEB_OWNER, c.req.valid('param').script, {
          approve: false,
          ...body,
        }) as never,
        200,
      )
    })
    .openapi(disableRoute, (c) =>
      c.json(disableScript(deps, WEB_OWNER, c.req.valid('param').script) as never, 200),
    )
    .openapi(enableRoute, (c) =>
      c.json(enableScript(deps, WEB_OWNER, c.req.valid('param').script) as never, 200),
    )
    .openapi(dryRunRoute, async (c) =>
      c.json(
        (await dryRunScript(
          deps,
          WEB_OWNER,
          c.req.valid('param').script,
          c.req.valid('json'),
        )) as never,
        200,
      ),
    )
    .openapi(runRoute, async (c) => {
      const body = await bodyOf<{ event?: unknown }>(c.req)
      return c.json(
        (await runScriptNow(deps, WEB_OWNER, c.req.valid('param').script, body?.event)) as never,
        200,
      )
    })
    .openapi(runsRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(
        {
          runs: listRuns(deps, c.req.valid('param').script, {
            limit: q.limit,
            before: q.before,
            dryRun: q.dryRun === undefined ? undefined : q.dryRun === 'true',
          }),
        } as never,
        200,
      )
    })
    .openapi(runOneRoute, (c) => {
      const p = c.req.valid('param')
      return c.json(getRun(deps, p.script, p.runId) as never, 200)
    })
    .openapi(kvRoute, (c) =>
      c.json({ entries: scriptKv(deps, c.req.valid('param').script) } as never, 200),
    )
}
