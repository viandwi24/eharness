import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  createProfile,
  deleteProfile,
  describeProviders,
  listProfileModels,
  probeProfileTools,
  testProfile,
  updateProfile,
} from '../../app/providers.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  ModelListSchema,
  ModelsQuery,
  ProfileCreateSchema,
  ProfileIdParam,
  ProfilePatchSchema,
  ProfileSchema,
  ProvidersSchema,
  TestResultSchema,
  ToolProbeResultSchema,
  ToolProbeSchema,
} from '../schemas/providers.ts'

const security = [{ Bearer: [] }]
const content = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const list = createRoute({
  method: 'get',
  path: '/providers',
  tags: ['providers'],
  summary: 'Provider definitions and their saved profiles',
  description:
    'Each definition carries the fields of its settings form (and the JSON Schema they came from), so a client renders the form without knowing the provider. Profiles are redacted: a secret is `{ set, hint }`. Profiles with `source: "env"` come from environment variables and are read-only.',
  security,
  responses: {
    200: { description: 'Definitions and profiles', content: content(ProvidersSchema) },
    ...errorResponses,
  },
})

const create = createRoute({
  method: 'post',
  path: '/providers/profiles',
  tags: ['providers'],
  summary: 'Create a provider profile',
  description:
    'Several profiles of the same provider can exist (for example two OpenRouter keys). Secrets are encrypted at rest and never returned.',
  security,
  request: { body: { required: true, content: content(ProfileCreateSchema) } },
  responses: {
    201: { description: 'The new profile, redacted', content: content(ProfileSchema) },
    409: jsonError('A profile with this id exists'),
    ...errorResponses,
  },
})

const patch = createRoute({
  method: 'patch',
  path: '/providers/profiles/{id}',
  tags: ['providers'],
  summary: 'Edit a provider profile',
  description:
    'Keep-secret semantics: a secret omitted, `""` or `{ "keep": true }` keeps the stored value. Environment profiles cannot be edited (409).',
  security,
  request: {
    params: ProfileIdParam,
    body: { required: true, content: content(ProfilePatchSchema) },
  },
  responses: {
    200: { description: 'The profile, redacted', content: content(ProfileSchema) },
    404: jsonError('Unknown profile'),
    409: jsonError('Read-only environment profile'),
    ...errorResponses,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/providers/profiles/{id}',
  tags: ['providers'],
  summary: 'Delete a provider profile',
  description:
    'Refused (409) for environment profiles and while an agent or the workspace default still uses the profile.',
  security,
  request: { params: ProfileIdParam },
  responses: {
    204: { description: 'Deleted' },
    404: jsonError('Unknown profile'),
    409: jsonError('Read-only, or still in use'),
    ...errorResponses,
  },
})

const test = createRoute({
  method: 'post',
  path: '/providers/profiles/{id}/test',
  tags: ['providers'],
  summary: 'Test the connection of a profile',
  description:
    'Never fails with an error status for a bad key: `ok: false` carries the reason (secrets scrubbed).',
  security,
  request: { params: ProfileIdParam },
  responses: {
    200: { description: 'Result', content: content(TestResultSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const probe = createRoute({
  method: 'post',
  path: '/providers/profiles/{id}/probe',
  tags: ['providers'],
  summary: 'Check that a model can call tools',
  description:
    'Sends the model one small request with one tool and checks it calls the tool with the right input. Agents need that: a model that answers in text instead (or a server without tool calling turned on) cannot run an agent. Costs one model call (on the Logs page). A model error is `ok: false`, never an error status.',
  security,
  request: {
    params: ProfileIdParam,
    body: { required: true, content: content(ToolProbeSchema) },
  },
  responses: {
    200: { description: 'Result', content: content(ToolProbeResultSchema) },
    404: jsonError('Unknown or disabled profile'),
    ...errorResponses,
  },
})

const models = createRoute({
  method: 'get',
  path: '/providers/profiles/{id}/models',
  tags: ['providers'],
  summary: 'Models of a profile with their metadata',
  description:
    'Merged from the profile policy (`extra`), the live listing of the provider and the public catalogs (OpenRouter, models.dev): context window, prices per 1M tokens, reasoning and tool support. Works without a key from the cached catalog.',
  security,
  request: { params: ProfileIdParam, query: ModelsQuery },
  responses: {
    200: { description: 'Models', content: content(ModelListSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

export function providerRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(list, async (c) => c.json(await describeProviders(deps), 200))
    .openapi(create, async (c) => c.json(await createProfile(deps, c.req.valid('json')), 201))
    .openapi(patch, async (c) =>
      c.json(await updateProfile(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(remove, async (c) => {
      await deleteProfile(deps, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(test, async (c) => c.json(await testProfile(deps, c.req.valid('param').id), 200))
    .openapi(probe, async (c) =>
      c.json(
        await probeProfileTools(deps, c.req.valid('param').id, c.req.valid('json').modelId),
        200,
      ),
    )
    .openapi(models, async (c) => {
      const query = c.req.valid('query')
      return c.json(
        {
          models: await listProfileModels(
            deps,
            c.req.valid('param').id,
            query.refresh === 'true',
            query.all === 'true',
          ),
        },
        200,
      )
    })
}
