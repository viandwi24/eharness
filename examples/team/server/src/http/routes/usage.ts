import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import { workspaceUsage } from '../../app/usage.ts'
import { errorResponses } from '../schemas/common.ts'
import { WorkspaceUsageSchema } from '../schemas/usage.ts'

const usageRoute = createRoute({
  method: 'get',
  path: '/usage',
  tags: ['settings'],
  summary: 'Usage of the whole workspace, by agent and by source',
  description:
    'Tokens and cost of every agent: chats (all threads), tasks, delegated work, routine runs and program runs. Chat usage is the cumulative usage of the thread sessions; the others come from the task rows.',
  security: [{ Bearer: [] }],
  responses: {
    200: {
      description: 'Usage',
      content: { 'application/json': { schema: WorkspaceUsageSchema } },
    },
    ...errorResponses,
  },
})

export function usageRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono().openapi(usageRoute, async (c) => c.json(await workspaceUsage(deps), 200))
}
