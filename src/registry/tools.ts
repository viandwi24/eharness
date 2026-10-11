/**
 * Tool resolution per turn (internal): static tools resolved at session open, then tool source
 * listings with `refresh` caching, name validation, shadowing and deferral (`defer` →
 * `deferLoading`), and the automatic `tool_search` tool when deferred tools exist.
 *
 * @see docs/specs/02-context-registry.md#3-tools
 * @see docs/specs/09-tools-and-mcp.md#2-toolsource
 */
import { type Tool, type ToolSet, toolSearch } from 'ai'
import type { HarnessWarning } from '../errors.ts'
import { runHook } from '../internal/hook-run.ts'
import { type Observer, observeCount } from '../internal/observe.ts'
import { errorText } from '../internal/util.ts'
import type { HarnessContext } from '../plugin/types.ts'
import { TOOL_NAME_PATTERN } from './static.ts'
import { withToolFields } from './tool-copy.ts'
import { RESERVED_TOOL_NAMES, type ToolSource } from './types.ts'

/** Marker: the source failed recently and is still in its backoff (not an error to report). */
class SourceBackoff extends Error {}

/** A tool of the turn with its owner, in stable order (spec 02 §6 rule 1). */
export interface TurnToolEntry {
  owner: string
  name: string
  tool: Tool
  /** Set for tools listed by a source. */
  source?: string
}

/** Limits of source listing (`config.toolSources`). */
export interface SourceListingOptions {
  /** Backstop for a `list()` that never settles. Default {@link DEFAULT_SOURCE_LIST_TIMEOUT_MS}. */
  timeoutMs?: number | undefined
  /**
   * After a failed `list()` the source is not asked again for this long, doubling per consecutive
   * failure up to {@link MAX_SOURCE_RETRY_MS}. Default {@link DEFAULT_SOURCE_RETRY_MS}; 0 retries
   * at the next turn.
   */
  retryAfterMs?: number | undefined
  /** Clock (tests). Default `Date.now`. */
  now?: (() => number) | undefined
}

/** Default backstop for one source `list()`. */
export const DEFAULT_SOURCE_LIST_TIMEOUT_MS = 30_000
/** Default wait before a failed source is asked again. */
export const DEFAULT_SOURCE_RETRY_MS = 5_000
/** Upper bound of the doubling retry wait. */
export const MAX_SOURCE_RETRY_MS = 60_000

/** Negative cache entry of a failed source. */
export interface SourceFailure {
  failures: number
  retryAt: number
}

/**
 * List the tools of every source (plugin order, then `list()` order) for one turn.
 *
 * - `refresh: 'session'` (default) sources are listed once per session (cached in `cache`),
 *   `'turn'` sources before every turn.
 * - Sources are listed concurrently; the result order is the source order (`toolOrder` and the
 *   prompt-cache prefix stay stable). A `list()` that does not settle in `timeoutMs` fails.
 * - A failing `list()` contributes nothing for this turn (`W_TOOL_SOURCE_FAILED`) and is not
 *   asked again until its backoff (`retryAfterMs`, doubling) elapsed (`failures`).
 * - Invalid names are skipped (`W_INVALID_TOOL_NAME`); reserved names and names already taken
 *   (static tools, earlier sources) are skipped (`W_SHADOWED`).
 * - `defer: true` sources return their tools with `deferLoading: true`.
 */
export async function listSourceTools(args: {
  sources: ReadonlyArray<{ owner: string; source: ToolSource }>
  cache: Map<ToolSource, Array<{ name: string; tool: Tool }>>
  /** Negative cache; omitted = failed sources are retried every turn. */
  failures?: Map<ToolSource, SourceFailure> | undefined
  options?: SourceListingOptions | undefined
  taken: Set<string>
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
  /** `config.observe`: a source skipped by its backoff is `tool-source.backoff`. */
  observe?: Observer | undefined
  sessionId?: string | undefined
}): Promise<TurnToolEntry[]> {
  const now = args.options?.now ?? Date.now
  const timeoutMs = args.options?.timeoutMs ?? DEFAULT_SOURCE_LIST_TIMEOUT_MS
  const retryBase = args.options?.retryAfterMs ?? DEFAULT_SOURCE_RETRY_MS
  const settled = await Promise.allSettled(
    args.sources.map(async ({ owner, source }): Promise<Array<{ name: string; tool: Tool }>> => {
      const cached = source.refresh === 'turn' ? undefined : args.cache.get(source)
      if (cached !== undefined) return cached
      const failure = args.failures?.get(source)
      if (failure !== undefined && now() < failure.retryAt) throw new SourceBackoff()
      const set: ToolSet = await runHook(() => source.list(args.contextOf(owner)), {
        hook: `toolSource.list(${source.id})`,
        owner,
        timeoutMs,
      })
      const listed = Object.entries(set ?? {}).map(([name, tool]) => ({
        name,
        // `defer: true` marks every tool of the source deferred (spec 02 §3.3)
        tool: source.defer === true ? withToolFields(tool, { deferLoading: true }) : tool,
      }))
      if (source.refresh !== 'turn') args.cache.set(source, listed)
      args.failures?.delete(source)
      return listed
    }),
  )
  const out: TurnToolEntry[] = []
  for (const [index, { owner, source }] of args.sources.entries()) {
    const result = settled[index] as PromiseSettledResult<Array<{ name: string; tool: Tool }>>
    if (result.status === 'rejected') {
      const error: unknown = result.reason
      if (error instanceof SourceBackoff) {
        // asked recently and failed; warned then
        observeCount(args.observe, 'tool-source.backoff', {
          sessionId: args.sessionId,
          source: source.id,
          owner,
        })
        continue
      }
      if (args.failures !== undefined) {
        const failures = (args.failures.get(source)?.failures ?? 0) + 1
        const wait = Math.min(MAX_SOURCE_RETRY_MS, retryBase * 2 ** (failures - 1))
        args.failures.set(source, { failures, retryAt: now() + wait })
      }
      args.warn(
        {
          code: 'W_TOOL_SOURCE_FAILED',
          message: `Tool source '${source.id}' failed to list its tools: ${errorText(error)}`,
          details: { source: source.id, owner },
        },
        source.id,
      )
      continue
    }
    const listed = result.value
    for (const { name, tool } of listed) {
      if (!TOOL_NAME_PATTERN.test(name)) {
        args.warn(
          {
            code: 'W_INVALID_TOOL_NAME',
            message: `Tool source '${source.id}' returned the invalid tool name '${name}'; skipped.`,
            details: { source: source.id, tool: name },
          },
          `${source.id}:${name}`,
        )
        continue
      }
      if (RESERVED_TOOL_NAMES.includes(name) || args.taken.has(name)) {
        args.warn(
          {
            code: 'W_SHADOWED',
            message: `Tool '${name}' from source '${source.id}' is hidden by an earlier tool with the same name.`,
            details: { source: source.id, tool: name },
          },
          `${source.id}:${name}`,
        )
        continue
      }
      args.taken.add(name)
      out.push({ owner, name, tool, source: source.id })
    }
  }
  return out
}

/** Reserved name of the automatic tool search tool. */
export const TOOL_SEARCH_NAME = 'tool_search'

/**
 * Append AI SDK's `toolSearch()` as `tool_search` (last, spec 02 §6 rule 1) when at least one tool
 * of the turn is deferred (spec 02 §3.3). Returns `entries` unchanged otherwise.
 */
export function withToolSearch(entries: TurnToolEntry[]): TurnToolEntry[] {
  if (!entries.some((entry) => entry.tool.deferLoading === true)) return entries
  return [...entries, { owner: 'eh', name: TOOL_SEARCH_NAME, tool: toolSearch() }]
}
