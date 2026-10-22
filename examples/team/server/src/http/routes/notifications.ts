import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  dismissAllNotifications,
  dismissNotification,
  listNotifications,
} from '../../app/briefings.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  DismissedSchema,
  NotificationListSchema,
  NotificationSchema,
  NotificationsQuerySchema,
} from '../schemas/notifications.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const notificationsRoute = createRoute({
  method: 'get',
  path: '/notifications',
  tags: ['notifications'],
  summary: 'The bell: alerts and the daily digest',
  description:
    'Urgent heartbeat findings (one alert each) and one notification per day with the daily digest. Not the things that wait for a decision or an answer: those are `/decisions` and `/approvals`.',
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
  tags: ['notifications'],
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
  tags: ['notifications'],
  summary: 'Dismiss every notification',
  security,
  responses: {
    200: { description: 'How many were dismissed', content: json(DismissedSchema) },
    ...errorResponses,
  },
})

export function notificationRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
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
