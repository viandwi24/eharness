/**
 * The Browser connector (plan P48, spec 24): one connection per agent (or one shared) naming a
 * browser profile; activation adds the `browser()` plugin of `eharness/browser` for that profile.
 *
 * Capabilities:
 *  - `browse` (read, allowed): open, snapshot, screenshot, read, tabs, and asking a person to
 *    take over;
 *  - `act` (external, asks by default): clicks, typing and forms. A profile an admin marks
 *    trusted makes the connections that name it allow it (`syncTrust`, `app/browser.ts`).
 */

import type { HarnessPlugin } from 'eharness'
import { type AnyConnectorDefinition, defineConnector } from 'eharness/connectors'
import { ehMeta } from 'eharness/providers'
import { z } from 'zod'
import { BROWSER_CONNECTOR_ID } from '../../app/browser.ts'

/** What the connector needs from the browser service (late-bound: the hook is set after the deps). */
export interface BrowserHook {
  /** The plugin of one agent's connection. */
  plugin(input: { agentId: string; connectionId: string; profileId: string }): HarnessPlugin
  /** The profile of a connection's settings (name for people), for the test. */
  describe(
    profileId: string,
  ): Promise<{ name: string; adapter: string; mode: string; trusted: boolean } | undefined>
  /** Make the default mode of `act` follow the profile's trust (never lowers a choice). */
  settle(connectionId: string, trusted: boolean): void
}

export const BROWSER_BROWSE_TOOLS = [
  'browser_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_read',
  'browser_tabs',
  'browser_request_human',
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
    // curated, not built-in: a connection needs a profile, so none is created on its own
    source: 'curated',
    auth: { type: 'none' },
    scopes: ['workspace', 'agent'],
    // one browser per agent by default; the tool names are fixed
    instances: 'single',
    toolPrefix: 'never',
    settings: z.object({
      profileId: z
        .string()
        .min(1)
        .meta({
          title: 'Browser profile',
          description:
            'The id of a profile made on the Browser page. A profile keeps its logins, so give each agent its own.',
          ...ehMeta({ group: 'endpoint' }),
        }),
    }),
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
        description:
          'Click, fill forms and press keys on pages. A trusted profile lets the agent do this without asking.',
        kind: 'external',
        tools: [...BROWSER_ACT_TOOLS],
        defaultMode: 'ask',
      },
    ],
    scopeDefaults: { workspace: { defaultEnabled: false } },
    test: async (ctx) => {
      const found = await hook()?.describe((ctx.settings as { profileId: string }).profileId)
      if (found === undefined) {
        return { ok: false, message: 'There is no browser profile with this id (Browser page).' }
      }
      return {
        ok: true,
        message: `${found.name} (${found.adapter}, ${found.mode === 'managed' ? 'runs on this server' : 'existing browser'})`,
        accountLabel: found.name,
      }
    },
    activate: async (ctx) => {
      const h = hook()
      if (h === undefined) return []
      const profileId = (ctx.settings as { profileId: string }).profileId
      const found = await h.describe(profileId)
      // a profile that was deleted leaves the tools out (the connection shows it in its test)
      if (found === undefined) return []
      if (found.trusted && ctx.modes.act === 'ask') h.settle(ctx.connection.id, true)
      return h.plugin({ agentId: ctx.agent.id, connectionId: ctx.connection.id, profileId })
    },
  })
}
