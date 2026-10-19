import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import { ackAlarm, listAlarms } from '../../app/alarms.ts'
import type { Deps } from '../../app/ports.ts'
import { AlarmListSchema, AlarmSchema, AlarmsQuerySchema } from '../schemas/alarms.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const listRoute = createRoute({
  method: 'get',
  path: '/alarms',
  tags: ['health'],
  summary: 'Alarms: failures of scheduled and background work',
  description:
    'One alarm per incident, raised by the server with no model call: a program or routine run that ended failed, interrupted or timed out for good, a run stopped for showing no activity, a routine that paused itself, an approval nobody answered, a connection in error or needing sign-in, a failed startup or health step. Open ones (not acknowledged) are the "Needs attention" list of the Health page; they are also pushed to the owner. Acknowledged ones stay as history with `all=true`.',
  security,
  request: { query: AlarmsQuerySchema },
  responses: {
    200: { description: 'Alarms, newest first', content: json(AlarmListSchema) },
    ...errorResponses,
  },
})

const ackRoute = createRoute({
  method: 'post',
  path: '/alarms/{id}/ack',
  tags: ['health'],
  summary: 'Acknowledge an alarm',
  description:
    'Takes it off "Needs attention"; the record stays. Alarms also clear on their own when the cause is gone.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The alarm', content: json(AlarmSchema) },
    404: jsonError('Unknown alarm'),
    ...errorResponses,
  },
})

export function alarmRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => {
      const q = c.req.valid('query')
      return c.json(listAlarms(deps, { all: q.all === 'true', limit: q.limit }), 200)
    })
    .openapi(ackRoute, (c) => c.json(ackAlarm(deps, c.req.valid('param').id), 200))
}
