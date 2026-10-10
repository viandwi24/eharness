import { z } from '@hono/zod-openapi'

export const HealthSchema = z
  .object({
    ok: z.literal(true),
    name: z.string().openapi({ example: 'eharness-team-server' }),
    time: z.number().int().openapi({ description: 'Server time, ms since epoch.' }),
  })
  .openapi('Health')
