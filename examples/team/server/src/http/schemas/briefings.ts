import { z } from '@hono/zod-openapi'

export const BriefingItemSchema = z
  .object({
    kind: z.enum(['run', 'decision', 'waiting', 'noticed', 'cost']),
    title: z.string(),
    detail: z.string(),
    link: z.string().nullable(),
  })
  .openapi('BriefingItem')

export const BriefingSchema = z
  .object({
    id: z.string(),
    day: z.string().openapi({ example: '2026-10-12', description: 'Local day (digest timezone).' }),
    title: z.string(),
    body: z.string().openapi({ description: 'The digest as markdown.' }),
    items: z.array(BriefingItemSchema),
    createdAt: z.number().int(),
  })
  .openapi('Briefing')

export const BriefingListSchema = z
  .object({ briefings: z.array(BriefingSchema) })
  .openapi('BriefingList')

export const NotificationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['alert', 'briefing']),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable().openapi({ description: 'App path it opens.' }),
    agentId: z.string().nullable(),
    createdAt: z.number().int(),
    dismissedAt: z.number().int().nullable(),
  })
  .openapi('Notification')

export const NotificationListSchema = z
  .object({ notifications: z.array(NotificationSchema), open: z.number().int() })
  .openapi('NotificationList')

export const NotificationsQuerySchema = z.object({
  all: z.enum(['true', 'false']).optional().openapi({ description: 'Include dismissed ones.' }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const BriefingsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

export const DismissedSchema = z.object({ dismissed: z.number().int() }).openapi('Dismissed')
