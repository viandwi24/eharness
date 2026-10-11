import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  dismissAllNotifications,
  dismissNotification,
  getBriefing,
  listBriefings,
  listNotifications,
  markBriefingSeen,
} from '../../app/briefings.ts'
import type { Deps } from '../../app/ports.ts'
import {
  BriefingListSchema,
  BriefingSchema,
  BriefingsQuerySchema,
  DismissedSchema,
  NotificationListSchema,
  NotificationSchema,
  NotificationsQuerySchema,
} from '../schemas/briefings.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const briefingsRoute = createRoute({
  method: 'get',
  path: '/briefings',
  tags: ['briefings'],
  summary: 'Briefings (the daily digest), newest day first',
  description:
    'The digest is a page, not a chat message: one entry per local day, built from data. A quiet day has none.',
  security,
  request: { query: BriefingsQuerySchema },
  responses: {
    200: { description: 'Briefings', content: json(BriefingListSchema) },
    ...errorResponses,
  },
})

const briefingRoute = createRoute({
  method: 'get',
  path: '/briefings/{id}',
  tags: ['briefings'],
  summary: 'A briefing',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The briefing', content: json(BriefingSchema) },
    404: jsonError('Unknown briefing'),
    ...errorResponses,
  },
})

const seenRoute = createRoute({
  method: 'post',
  path: '/briefings/{id}/seen',
  tags: ['briefings'],
  summary: 'Mark a briefing as seen (clears its bell notification)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The briefing', content: json(BriefingSchema) },
    404: jsonError('Unknown briefing'),
    ...errorResponses,
  },
})

const notificationsRoute = createRoute({
  method: 'get',
  path: '/notifications',
  tags: ['briefings'],
  summary: 'The bell: alerts and "briefing ready"',
  description:
    'Urgent heartbeat findings (one alert each) and one notification per briefing. Not the things that wait for a decision or an answer: those are `/decisions` and `/approvals`.',
  security,
  request: { query: NotificationsQuerySchema },
  responses: {
    200: { description: 'Notifications, newest first', content: json(NotificationListSchema) },
    ...errorResponses,
  },
})

const dismissRoute = createRoute({
  method: 'post',
  path: '/notifications/{id}/dismiss',
  tags: ['briefings'],
  summary: 'Dismiss a notification',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The notification', content: json(NotificationSchema) },
    404: jsonError('Unknown notification'),
    ...errorResponses,
  },
})

const dismissAllRoute = createRoute({
  method: 'post',
  path: '/notifications/dismiss-all',
  tags: ['briefings'],
  summary: 'Dismiss every notification',
  security,
  responses: {
    200: { description: 'How many were dismissed', content: json(DismissedSchema) },
    ...errorResponses,
  },
})

export function briefingRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(briefingsRoute, (c) =>
      c.json({ briefings: listBriefings(deps, c.req.valid('query').limit) }, 200),
    )
    .openapi(briefingRoute, (c) => c.json(getBriefing(deps, c.req.valid('param').id), 200))
    .openapi(seenRoute, (c) => {
      const { id } = c.req.valid('param')
      markBriefingSeen(deps, id)
      return c.json(getBriefing(deps, id), 200)
    })
    .openapi(notificationsRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(
        listNotifications(deps, {
          ...(q.all === 'true' ? { all: true } : {}),
          ...(q.limit === undefined ? {} : { limit: q.limit }),
        }),
        200,
      )
    })
    .openapi(dismissAllRoute, (c) => c.json({ dismissed: dismissAllNotifications(deps) }, 200))
    .openapi(dismissRoute, (c) => c.json(dismissNotification(deps, c.req.valid('param').id), 200))
}
