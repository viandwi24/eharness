import { z } from '@hono/zod-openapi'
import { ALARM_KINDS } from '../../app/catalog.ts'

export const AlarmSchema = z
  .object({
    id: z.string(),
    kind: z.enum(ALARM_KINDS),
    subject: z.string().openapi({
      description:
        'What it is about: `program:<id>`, `routine:<id>`, `connection:<id>`, `system:<step>`.',
    }),
    agentId: z.string().nullable(),
    text: z.string().openapi({
      description: 'Plain short text: what failed, why, and the one next step.',
    }),
    refs: z.array(z.string()).openapi({
      description: 'App paths that open the evidence or the fix (the first is the primary one).',
    }),
    createdAt: z.number().int(),
    ackedAt: z.number().int().nullable(),
    ackedBy: z.enum(['owner', 'auto']).nullable().openapi({
      description:
        '`owner` pressed Ack; `auto` the cause cleared (the next run succeeded, the connection works again).',
    }),
    deliveredAt: z.number().int().nullable().openapi({
      description:
        'When it reached the owner (chat message or bell); null while it waits for the rate limit.',
    }),
  })
  .openapi('Alarm')

export const AlarmListSchema = z
  .object({ alarms: z.array(AlarmSchema), open: z.number().int() })
  .openapi('AlarmList')

export const AlarmsQuerySchema = z.object({
  all: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Include acknowledged ones (history).' }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
