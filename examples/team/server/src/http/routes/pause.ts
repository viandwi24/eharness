import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { pauseView, pauseWorkspace, resumeWorkspace } from '../../app/pause.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses } from '../schemas/common.ts'
import { PauseRequestSchema, PauseViewSchema } from '../schemas/pause.ts'

const security = [{ Bearer: [] }]

const ok = {
  200: {
    description: 'The state of the workspace pause',
    content: { 'application/json': { schema: PauseViewSchema } },
  },
  ...errorResponses,
}

const getRoute = createRoute({
  method: 'get',
  path: '/workspace/pause',
  tags: ['workspace'],
  summary: 'Pause all: state',
  description:
    'Whether the workspace is paused and what a pause holds right now (active programs, routines, reminders, the heartbeat, the digest, queued tasks, running turns).',
  security,
  responses: ok,
})

const pauseRoute = createRoute({
  method: 'post',
  path: '/workspace/pause',
  tags: ['workspace'],
  summary: 'Pause everything automatic',
  description:
    'One durable gate: scheduled slots are skipped (reason `paused`, never replayed), queued tasks stay queued, retries and early heartbeat wakes wait, and with `holdChannels` chat messages are kept without waking an agent (with `answerHeldOnResume`, Resume answers the ones that addressed the agent, up to 12 hours old). Nothing changes status, and the owner\'s chat, "Run now" and approvals keep working. Idempotent: pausing again updates the note and keeps `pausedAt`.',
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: PauseRequestSchema } } },
  },
  responses: ok,
})

const resumeRoute = createRoute({
  method: 'post',
  path: '/workspace/resume',
  tags: ['workspace'],
  summary: 'Resume after Pause all',
  description:
    'Opens the gate: programs, routines, reminders and the heartbeat continue from their next slot (skipped slots are not replayed) and queued tasks start now.',
  security,
  responses: ok,
})

export function pauseRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(getRoute, (c) => c.json(pauseView(deps), 200))
    .openapi(pauseRoute, async (c) => c.json(await pauseWorkspace(deps, c.req.valid('json')), 200))
    .openapi(resumeRoute, (c) => c.json(resumeWorkspace(deps), 200))
}
