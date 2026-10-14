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
  /** How many profiles exist (up to 2), and the id when there is exactly one. */
  profileCount(): Promise<{ count: number; only: string | undefined }>
}

/** The profile a connection uses: its choice, or the only profile when it chose none. */
async function profileOf(
  h: BrowserHook,
  settings: unknown,
): Promise<{ id: string } | { error: string }> {
  const chosen = (settings as { profileId?: unknown } | undefined)?.profileId
  if (typeof chosen === 'string' && chosen !== '') return { id: chosen }
  const { count, only } = await h.profileCount()
  if (only !== undefined) return { id: only }
  return {
    error:
      count === 0
        ? 'There is no browser profile yet: create one on the Browser page.'
        : 'Choose a browser profile in this connection (there is more than one).',
  }
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
        .optional()
        .meta({
          title: 'Browser profile',
          description:
            'A profile made on the Browser page. Empty: the only profile, when there is just one. A profile keeps its logins, so give each agent its own.',
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
      const h = hook()
      if (h === undefined)
        return { ok: false, message: 'Browsers are not available on this server.' }
      const picked = await profileOf(h, ctx.settings)
      if ('error' in picked) return { ok: false, message: picked.error }
      const found = await h.describe(picked.id)
      if (found === undefined) {
        return { ok: false, message: 'That browser profile was deleted: choose another one.' }
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
      const picked = await profileOf(h, ctx.settings)
      if ('error' in picked) return []
      const profileId = picked.id
      const found = await h.describe(profileId)
      // a profile that was deleted leaves the tools out (the connection shows it in its test)
      if (found === undefined) return []
      if (found.trusted && ctx.modes.act === 'ask') h.settle(ctx.connection.id, true)
      return h.plugin({ agentId: ctx.agent.id, connectionId: ctx.connection.id, profileId })
    },
  })
}
