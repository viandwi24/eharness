import { z } from '@hono/zod-openapi'

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({
        example: 'NOT_FOUND',
        description: 'Stable machine-readable code (eharness codes pass through).',
      }),
      message: z.string().openapi({ example: 'agent not found: abc' }),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error')

/** Error responses every route can return. */
export const errorResponses = {
  400: { description: 'Invalid request', content: { 'application/json': { schema: ErrorSchema } } },
  401: {
    description: 'Missing or wrong bearer token',
    content: { 'application/json': { schema: ErrorSchema } },
  },
} as const

export const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
})

/** Which chat thread of the agent a per-chat route is about (default: the newest thread). */
export const ThreadQuery = z.object({
  thread: z.string().optional().openapi({
    description:
      'Thread id (`GET /agents/{id}/threads`); without it the thread with the newest activity.',
  }),
})

export const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '0198f0a2-0000-7000-8000-000000000000',
      description: 'Agent id or slug.',
    }),
})
