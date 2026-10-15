/**
 * The activation side of the Browser connector: the `browser()` plugin of one agent's
 * connection, the takeover that becomes a Decision Center card,.
 *
 * `browser_request_human` parks the turn on an external wait; `requestHuman` gets the wait id the
 * decision card needs (the answer resolves that wait).
 */
import type { HarnessPlugin, WaitStart } from 'eharness'
import { browser } from 'eharness/browser'
import type { BrowserHook } from './connector.ts'
import type { BrowserService } from './index.ts'

export interface TakeoverRequest {
  agentId: string
  sessionId: string
  waitId: string
  profileId: string
  profileName: string
  reason: string
}

export interface BrowserHookDeps {
  service: Pick<BrowserService, 'manager' | 'profiles'>
  /** The Decision Center card of a takeover (plan P48); returns the decision id. */
  takeover: (request: TakeoverRequest) => { id: string }
  /** Does the agent's model accept images (spec 12)? Default true. */
  images?: (agentId: string) => boolean
}

export function createBrowserHook(deps: BrowserHookDeps): BrowserHook {
  const { manager, profiles } = deps.service
  return {
    async describe(profileId) {
      const p = await profiles.get(profileId)
      return p === null
        ? undefined
        : { name: p.name, adapter: p.adapter, mode: p.mode, trusted: p.trusted === true }
    },
    async profileCount() {
      const page = await profiles.list({ limit: 2 })
      return {
        count: page.items.length,
        only: page.items.length === 1 ? page.items[0]?.id : undefined,
      }
    },
    plugin({ agentId, profileId }): HarnessPlugin {
      // no choice in the connection: the only profile, looked up on every call (profiles change
      // while a session is open: one deleted, another created)
      const only = async (): Promise<string | undefined> => {
        const page = await profiles.list({ limit: 2 })
        return page.items.length === 1 ? page.items[0]?.id : undefined
      }
      return browser({
        manager,
        profile: profileId ?? only,
        // no profile fixed by an admin: the agent may see every profile and pick one
        ...(profileId !== undefined
          ? {}
          : {
              choose: {
                list: async () => {
                  const [page, status] = await Promise.all([
                    profiles.list({ limit: 100 }),
                    manager.status().catch(() => []),
                  ])
                  const running = new Set(status.map((s) => s.profileId))
                  return page.items.map((p) => ({
                    id: p.id,
                    name: p.name,
                    adapter: p.adapter,
                    mode: p.mode,
                    running: running.has(p.id),
                    trusted: p.trusted === true,
                  }))
                },
              },
            }),
        images: () => deps.images?.(agentId) ?? true,
        requestHuman: async (args): Promise<WaitStart | undefined> => {
          const { reason, sessionId, waitId } = args
          const used = args.profileId ?? profileId ?? (await only())
          if (used === undefined) return undefined
          const profile = await profiles.get(used)
          const { id } = deps.takeover({
            agentId,
            sessionId,
            waitId,
            profileId: used,
            profileName: profile?.name ?? used,
            reason,
          })
          return { correlationId: id, payload: { decisionId: id } }
        },
      })
    },
  }
}
