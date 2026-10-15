/**
 * The Browser connector (plan P48, spec 24): a built-in, one workspace connection every agent
 * inherits. The agent lists the profiles of the Browser page and picks one itself
 * (`browser_profiles`, `browser_use`); with a single profile it is used without asking.
 *
 * Capabilities:
 *  - `browse` (read, allowed): open, snapshot, screenshot, read, tabs, and asking a person to
 *    take over;
 *  - `act` (external, asks by default): clicks, typing and forms. Set it to allow on the
 *    connection to let every agent act without asking.
 */

import type { HarnessPlugin } from 'eharness'
import { type AnyConnectorDefinition, defineConnector } from 'eharness/connectors'
import { z } from 'zod'
import { BROWSER_CONNECTOR_ID } from '../../app/browser.ts'

/** What the connector needs from the browser service (late-bound: the hook is set after the deps). */
export interface BrowserHook {
  /** The plugin of one agent's connection. */
  /** `profileId` undefined: the only profile, resolved on every call. */
  plugin(input: {
    agentId: string
    connectionId: string
    profileId: string | undefined
  }): HarnessPlugin
  /** The profile of a connection's settings (name for people), for the test. */
  describe(
    profileId: string,
  ): Promise<{ name: string; adapter: string; mode: string; trusted: boolean } | undefined>
  /** How many profiles exist (up to 2), and the id when there is exactly one. */
  profileCount(): Promise<{ count: number; only: string | undefined }>
}

export const BROWSER_BROWSE_TOOLS = [
  'browser_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_read',
  'browser_tabs',
  'browser_request_human',
  'browser_profiles',
  'browser_use',
] as const
export const BROWSER_ACT_TOOLS = ['browser_act'] as const

export function browserConnector(hook: () => BrowserHook | undefined): AnyConnectorDefinition {
  return defineConnector({
    id: BROWSER_CONNECTOR_ID,
    version: '1',
    name: 'Browser',
    description:
      'Let an agent use a real browser: read pages, click and type, see screenshots. You can watch it live and take over for a login or a CAPTCHA.',
    icon: 'browser',
    category: 'workspace',
    source: 'builtin',
    auth: { type: 'none' },
    scopes: ['workspace'],
    instances: 'single',
    toolPrefix: 'never',
    settings: z.object({}),
    capabilities: [
      {
        id: 'browse',
        title: 'Browse',
        description:
          'Open pages, read them, take screenshots, and ask a person to take over (login, CAPTCHA, 2FA).',
        kind: 'read',
        tools: [...BROWSER_BROWSE_TOOLS],
        defaultMode: 'allow',
      },
      {
        id: 'act',
        title: 'Click and type',
        description: 'Click, fill forms and press keys on pages.',
        kind: 'external',
        tools: [...BROWSER_ACT_TOOLS],
        defaultMode: 'ask',
      },
    ],
    scopeDefaults: { workspace: { label: 'Browser', defaultEnabled: true } },
    test: async () => {
      const h = hook()
      if (h === undefined)
        return { ok: false, message: 'Browsers are not available on this server.' }
      const { count, only } = await h.profileCount()
      if (count === 0) {
        return { ok: true, message: 'No browser profile yet: create one on the Browser page.' }
      }
      const found = only === undefined ? undefined : await h.describe(only)
      return {
        ok: true,
        message:
          found === undefined
            ? 'The agent picks one of the Browser page profiles.'
            : `${found.name} (${found.adapter}, ${found.mode === 'managed' ? 'runs on this server' : 'existing browser'})`,
        accountLabel: found?.name ?? 'Any profile',
      }
    },
    activate: async (ctx) => {
      const h = hook()
      if (h === undefined) return []
      if ((await h.profileCount()).count === 0) return [] // nothing to browse with yet
      // the agent lists the profiles and picks one (the only one is used by itself)
      return h.plugin({
        agentId: ctx.agent.id,
        connectionId: ctx.connection.id,
        profileId: undefined,
      })
    },
  })
}
