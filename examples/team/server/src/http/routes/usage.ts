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
    'Tokens and cost of every agent by source: chats (all threads), tasks, delegated work, routine runs, program runs, the heartbeat, test runs and other calls. One source of truth: the model call log (the rows of the Logs page and the daily digest), so the numbers agree; `calls` counts model calls (a turn or a run makes several), `count` counts turns (chat, heartbeat) or runs. The log is kept for a limited time and number of rows, `since` is the start of the oldest call in it.',
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
  return new OpenAPIHono().openapi(usageRoute, async (c) => c.json(workspaceUsage(deps), 200))
}
