/**
 * The activation side of the Browser connector: the `browser()` plugin of one agent's
 * connection, the takeover that becomes a Decision Center card, and the trust sync.
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
  /** Make the connection's `act` default follow a trusted profile (fire and forget). */
  settle: (connectionId: string, trusted: boolean) => void
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
    settle: deps.settle,
    plugin({ agentId, profileId }): HarnessPlugin {
      return browser({
        manager,
        profile: profileId,
        images: () => deps.images?.(agentId) ?? true,
        requestHuman: async ({ reason, sessionId, waitId }): Promise<WaitStart | undefined> => {
          const profile = await profiles.get(profileId)
          const { id } = deps.takeover({
            agentId,
            sessionId,
            waitId,
            profileId,
            profileName: profile?.name ?? profileId,
            reason,
          })
          return { correlationId: id, payload: { decisionId: id } }
        },
      })
    },
  }
}
