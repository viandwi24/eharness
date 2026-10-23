/**
 * Warm tools. Tools of connected apps are deferred (found with `tool_search`) when an agent has
 * many of them, but a discovery changes the provider-visible tool list and resets the WHOLE prompt
 * cache (spec 02 §3.3, §6): in a long chat one question that needs three discoveries pays three
 * full misses. An agent uses the same connectors every day, so deferring what it uses saves
 * little and costs a lot. The app records which tools an agent calls (`toolUsage` plugin, table
 * `tool_usage`) and `warmTools` loads the ones used in the last N days up front.
 *
 * The warm set of a chat is fixed when its first turn lists the tools: a tool called (or found)
 * later in the same chat never changes the list, only the next chat does. A discovery of the
 * core stays in the session's loaded context; this only covers what the agent is known to use.
 */
import type { Database } from 'bun:sqlite'
import {
  definePlugin,
  type HarnessContext,
  type HarnessPlugin,
  type ToolSource,
  withToolFields,
} from 'eharness'

const DAY_MS = 24 * 60 * 60 * 1000
/** Chats whose warm set is remembered (oldest are forgotten: a resumed chat recomputes once). */
const SESSIONS_KEPT = 2000

export interface ToolUsageStore {
  /** A call of `tool` by the agent settled (successfully or not). */
  record(agentId: string, tool: string, at: number): void
  /** Tools the agent called at or after `since`. */
  usedSince(agentId: string, since: number): string[]
}

export function sqliteToolUsage(sqlite: Database): ToolUsageStore {
  return {
    record(agentId, tool, at) {
      sqlite
        .query(
          `INSERT INTO tool_usage (agent_id, tool, last_used_at, calls) VALUES (?, ?, ?, 1)
           ON CONFLICT (agent_id, tool) DO UPDATE SET
             last_used_at = max(last_used_at, excluded.last_used_at), calls = calls + 1`,
        )
        .run(agentId, tool, at)
    },
    usedSince(agentId, since) {
      return sqlite
        .query<{ tool: string }, [string, number]>(
          'SELECT tool FROM tool_usage WHERE agent_id = ? AND last_used_at >= ?',
        )
        .all(agentId, since)
        .map((r) => r.tool)
    },
  }
}

/** Records every tool call that settles. Never breaks a turn. */
export function toolUsage(options: {
  store: ToolUsageStore
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf(slug: string): { id: string } | undefined
  now?: () => number
  log?: (message: string) => void
}): HarnessPlugin<'tool-usage'> {
  const now = options.now ?? Date.now
  return definePlugin({
    name: 'tool-usage',
    setup: () => ({
      hooks: {
        'tool.after': (_ctx: HarnessContext, e: { toolName: string }): undefined => {
          try {
            const agent = options.agentOf(_ctx.agent.id)
            if (agent !== undefined) options.store.record(agent.id, e.toolName, now())
          } catch (error) {
            options.log?.(`tool usage not recorded: ${String(error)}`)
          }
          return undefined
        },
      },
    }),
  })
}

export interface WarmTools {
  /** The tools of `agentId` that load up front in chat `sessionId` (fixed at the first call). */
  warmFor(agentId: string, sessionId: string): ReadonlySet<string>
  /** The source with its warm tools not deferred. */
  wrap(agentId: string, source: ToolSource): ToolSource
}

export function warmTools(options: {
  store: ToolUsageStore
  /** Days of use that count; 0 = off. Read when a chat lists its tools for the first time. */
  days: () => number
  now?: () => number
}): WarmTools {
  const now = options.now ?? Date.now
  const sets = new Map<string, ReadonlySet<string>>()
  const none: ReadonlySet<string> = new Set()

  const warmFor: WarmTools['warmFor'] = (agentId, sessionId) => {
    const key = `${agentId}\u0000${sessionId}`
    const known = sets.get(key)
    if (known !== undefined) return known
    const days = options.days()
    let set = none
    if (days > 0) {
      try {
        set = new Set(options.store.usedSince(agentId, now() - days * DAY_MS))
      } catch {
        set = none
      }
    }
    sets.set(key, set)
    if (sets.size > SESSIONS_KEPT) {
      const oldest = sets.keys().next().value
      if (oldest !== undefined) sets.delete(oldest)
    }
    return set
  }

  const wrap: WarmTools['wrap'] = (agentId, source) => {
    const { defer, list, ...rest } = source
    const deferAll = defer === true
    const wrapped: ToolSource = {
      ...rest,
      list: async (ctx) => {
        const tools = await list.call(source, ctx)
        const warm = warmFor(agentId, ctx.session.id)
        if (warm.size === 0 && !deferAll) return tools
        const out: typeof tools = {}
        for (const [name, tool] of Object.entries(tools)) {
          const deferred = deferAll || tool.deferLoading === true
          if (!deferred) out[name] = tool
          else out[name] = withToolFields(tool, { deferLoading: !warm.has(name) })
        }
        return out
      },
    }
    return wrapped
  }

  return { warmFor, wrap }
}
