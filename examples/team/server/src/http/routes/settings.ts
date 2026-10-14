import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { Deps } from '../../app/ports.ts'
import { getSettings, patchSettings } from '../../app/settings.ts'
import { BrowserInfoSchema } from '../schemas/browser.ts'
import { errorResponses } from '../schemas/common.ts'
import { CodeSandboxSchema, SettingsPatchSchema, SettingsSchema } from '../schemas/settings.ts'

const security = [{ Bearer: [] }]

const getRoute = createRoute({
  method: 'get',
  path: '/settings',
  tags: ['settings'],
  summary: 'Workspace settings',
  security,
  responses: {
    200: {
      description: 'Settings',
      content: { 'application/json': { schema: SettingsSchema } },
    },
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/settings',
  tags: ['settings'],
  summary: 'Change workspace settings',
  description:
    'Stored in the database and read by the agent factory of every instance: the agents are rebuilt on their next use, the budget limit applies to the shared ledger. `budgetUsd: null` removes the limit.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SettingsPatchSchema } },
    },
  },
  responses: {
    200: {
      description: 'The new settings',
      content: { 'application/json': { schema: SettingsSchema } },
    },
    ...errorResponses,
  },
})

const codeRoute = createRoute({
  method: 'get',
  path: '/settings/code',
  tags: ['settings'],
  summary: 'Code sandbox status',
  description:
    'The driver of `run_python` (`off`, `local` or `docker`), the Python version, whether it runs isolated and the package install policy. Set by the `TEAM_CODE_*` variables.',
  security,
  responses: {
    200: {
      description: 'Status',
      content: { 'application/json': { schema: CodeSandboxSchema } },
    },
    ...errorResponses,
  },
})

const browserRoute = createRoute({
  method: 'get',
  path: '/settings/browser',
  tags: ['settings'],
  summary: 'Browser driver status',
  description:
    'The driver of managed browsers (`off` or `local`, `TEAM_BROWSER_DRIVER`), the engines that are downloaded (state, version, size), how many profiles run, and the memory of the server. Set by the `TEAM_BROWSER_*` variables.',
  security,
  responses: {
    200: {
      description: 'Status',
      content: { 'application/json': { schema: BrowserInfoSchema } },
    },
    ...errorResponses,
  },
})

export function settingsRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(getRoute, (c) => c.json(getSettings(deps), 200))
    .openapi(codeRoute, async (c) =>
      c.json(
        (await deps.codeSandbox?.info()) ?? {
          driver: 'off' as const,
          python: null,
          isolated: false,
          install: 'off' as const,
          label: 'Code sandbox is off',
        },
        200,
      ),
    )
    .openapi(browserRoute, async (c) =>
      c.json(
        (await deps.browser?.info()) ?? {
          driver: 'off' as const,
          max: 0,
          xvfb: false,
          system: null,
          runtimes: [],
          running: 0,
          label: 'The browser is not set up',
        },
        200,
      ),
    )
    .openapi(patchRoute, (c) => c.json(patchSettings(deps, c.req.valid('json')), 200))
}
