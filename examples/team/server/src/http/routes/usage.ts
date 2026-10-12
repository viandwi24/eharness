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
    'Tokens and cost of every agent by source: chats (all threads), tasks, delegated work, routine runs, program runs, the heartbeat, test runs and other calls. `month` (spend and budget) comes from the budget ledger, which is not pruned. The breakdown (`total`, `bySource`, `agents`) comes from the model call log, the rows of the Logs page: `calls` counts model calls (a turn or a run makes several), `count` counts turns (chat, heartbeat) or runs. The log is kept for a limited time and number of rows, so the breakdown covers from `since` (the oldest call kept) and can be lower than `month`.',
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
