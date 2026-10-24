import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { EVENT_CATALOG } from '../../app/catalog.ts'
import { getEvent, listEvents } from '../../app/event-stream.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  EventCatalogSchema,
  EventIdParam,
  EventListQuery,
  EventPageSchema,
  StreamEventSchema,
} from '../schemas/events.ts'

const security = [{ Bearer: [] }]
const tags = ['events']
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const listRoute = createRoute({
  method: 'get',
  path: '/events',
  tags,
  summary: 'The event stream',
  description:
    'One view over what happens: the events of the chat connections (messages, reactions, members, join requests, chat changes) and of the app (alarms, programs, tasks, settings). Newest first, cursor paged. Message bodies are never in it.',
  security,
  request: { query: EventListQuery },
  responses: {
    200: { description: 'A page of events', content: json(EventPageSchema) },
    ...errorResponses,
  },
})

const catalogRoute = createRoute({
  method: 'get',
  path: '/events/catalog',
  tags,
  summary: 'Event types and what each platform delivers',
  security,
  responses: {
    200: { description: 'The catalog', content: json(EventCatalogSchema) },
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/events/{id}',
  tags,
  summary: 'One event',
  security,
  request: { params: EventIdParam },
  responses: {
    200: { description: 'The event', content: json(StreamEventSchema) },
    404: jsonError('Unknown event'),
    ...errorResponses,
  },
})

export function eventRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, async (c) => {
      const q = c.req.valid('query')
      const types = q.type
        ?.split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '')
      return c.json(
        (await listEvents(deps, {
          ...(q.source === undefined ? {} : { source: q.source }),
          ...(q.connectionId === undefined ? {} : { connectionId: q.connectionId }),
          ...(types === undefined || types.length === 0 ? {} : { types }),
          ...(q.chat === undefined ? {} : { chat: q.chat }),
          ...(q.actor === undefined ? {} : { actor: q.actor }),
          ...(q.from === undefined ? {} : { from: q.from }),
          ...(q.to === undefined ? {} : { to: q.to }),
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          limit: q.limit,
        })) as never,
        200,
      )
    })
    .openapi(catalogRoute, async (c) =>
      c.json(
        { types: [...EVENT_CATALOG], connections: await deps.eventStream.sources() } as never,
        200,
      ),
    )
    .openapi(getRoute, async (c) =>
      c.json((await getEvent(deps, c.req.valid('param').id)) as never, 200),
    )
}
