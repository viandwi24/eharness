import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { BOOT_ID } from '../boot.ts'
import { HealthSchema } from '../schemas/health.ts'

const route = createRoute({
  method: 'get',
  path: '/health',
  tags: ['system'],
  summary: 'Liveness probe (no auth)',
  responses: {
    200: {
      description: 'The server is up',
      content: { 'application/json': { schema: HealthSchema } },
    },
  },
})

export function healthRoutes(now: () => number): OpenAPIHono {
  return new OpenAPIHono().openapi(route, (c) =>
    c.json({ ok: true as const, name: 'eharness-team-server', time: now(), boot: BOOT_ID }, 200),
  )
}
