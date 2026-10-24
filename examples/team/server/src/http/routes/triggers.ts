import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  type Trigger,
  testTrigger,
  triggerFires,
  updateTrigger,
} from '../../app/triggers.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  TriggerCreateSchema,
  TriggerDryRunSchema,
  TriggerFirePageSchema,
  TriggerFiresQuery,
  TriggerIdParam,
  TriggerListSchema,
  TriggerPatchSchema,
  TriggerSchema,
  TriggerTestSchema,
} from '../schemas/triggers.ts'

const security = [{ Bearer: [] }]
const tags = ['triggers']
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const unknown = jsonError('Unknown trigger')
const params = { params: TriggerIdParam }

const listRoute = createRoute({
  method: 'get',
  path: '/triggers',
  tags,
  summary: 'List triggers',
  description:
    'Event listeners: each one listens to event types in a scope with filters and does one thing (wake an agent, run a program, notify the owner, call a signed webhook).',
  security,
  responses: {
    200: { description: 'Triggers', content: json(TriggerListSchema) },
    ...errorResponses,
  },
})

const createRoute_ = createRoute({
  method: 'post',
  path: '/triggers',
  tags,
  summary: 'Create a trigger',
  security,
  request: { body: { required: true, content: json(TriggerCreateSchema) } },
  responses: {
    201: { description: 'Created', content: json(TriggerSchema) },
    409: jsonError('Too many triggers'),
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/triggers/{id}',
  tags,
  summary: 'A trigger',
  security,
  request: params,
  responses: {
    200: { description: 'The trigger', content: json(TriggerSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/triggers/{id}',
  tags,
  summary: 'Edit a trigger',
  description:
    'Any field; `webhookSecret` replaces the stored secret. Changing the action away from a webhook forgets the secret.',
  security,
  request: { ...params, body: { required: true, content: json(TriggerPatchSchema) } },
  responses: {
    200: { description: 'The trigger', content: json(TriggerSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/triggers/{id}',
  tags,
  summary: 'Delete a trigger and its firing log',
  security,
  request: params,
  responses: { 204: { description: 'Deleted' }, 404: unknown, ...errorResponses },
})

const firesRoute = createRoute({
  method: 'get',
  path: '/triggers/{id}/fires',
  tags,
  summary: 'The firing log of a trigger',
  description:
    'Every firing: the event, the action, the result (`ok`, `skipped` with a reason, `error`), how long it took and the facts of the outcome.',
  security,
  request: { ...params, query: TriggerFiresQuery },
  responses: {
    200: { description: 'Firings, newest first', content: json(TriggerFirePageSchema) },
    404: unknown,
    ...errorResponses,
  },
})

const allFiresRoute = createRoute({
  method: 'get',
  path: '/trigger-fires',
  tags,
  summary: 'The firing log of every trigger',
  security,
  request: { query: TriggerFiresQuery },
  responses: {
    200: { description: 'Firings, newest first', content: json(TriggerFirePageSchema) },
    ...errorResponses,
  },
})

const testRoute = createRoute({
  method: 'post',
  path: '/triggers/{id}/test',
  tags,
  summary: 'Dry run against a past event',
  description:
    'Shows what the trigger would do with the event (the match, the gates as they are now, the text or body it would send) and does nothing: no agent is woken, no program runs, no request is sent.',
  security,
  request: { ...params, body: { required: true, content: json(TriggerTestSchema) } },
  responses: {
    200: { description: 'The dry run', content: json(TriggerDryRunSchema) },
    404: jsonError('Unknown trigger or event'),
    ...errorResponses,
  },
})

export function triggerRoutes(deps: Deps): OpenAPIHono {
  const view = (t: Trigger) => ({ ...t, filteredCount: deps.triggerEngine.filteredCount(t.id) })
  const web = { kind: 'web' as const }
  const zone = (): string => deps.settings.get().timezone
  const time = (at: number): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone(),
        dateStyle: 'short',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(new Date(at))
    } catch {
      return new Date(at).toISOString()
    }
  }
  return new OpenAPIHono()
    .openapi(listRoute, (c) =>
      c.json(
        {
          items: listTriggers(deps).map(view),
          executedLastHour: deps.triggers.executedSince(deps.clock.now() - 3_600_000),
          hourlyCap: deps.settings.get().triggersMaxPerHour,
        } as never,
        200,
      ),
    )
    .openapi(createRoute_, async (c) =>
      c.json(view(await createTrigger(deps, web, c.req.valid('json') as never)) as never, 201),
    )
    .openapi(getRoute, (c) => c.json(view(getTrigger(deps, c.req.valid('param').id)) as never, 200))
    .openapi(patchRoute, async (c) =>
      c.json(
        view(
          await updateTrigger(deps, web, c.req.valid('param').id, c.req.valid('json') as never),
        ) as never,
        200,
      ),
    )
    .openapi(deleteRoute, (c) => {
      deleteTrigger(deps, web, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(firesRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(
        triggerFires(deps, {
          triggerId: c.req.valid('param').id,
          result: q.result,
          before: q.cursor,
          limit: q.limit,
        }) as never,
        200,
      )
    })
    .openapi(allFiresRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(
        triggerFires(deps, { result: q.result, before: q.cursor, limit: q.limit }) as never,
        200,
      )
    })
    .openapi(testRoute, async (c) =>
      c.json(
        (await testTrigger(deps, c.req.valid('param').id, c.req.valid('json').eventId, {
          time,
        })) as never,
        200,
      ),
    )
}
