/**
 * Tool resolution per turn (internal): static tools resolved at session open, then tool source
 * listings with `refresh` caching, name validation and shadowing.
 *
 * Deferral (`defer`, `deferLoading`) and the automatic `tool_search` tool are added by P6.
 *
 * @see docs/specs/02-context-registry.md#3-tools
 * @see docs/specs/09-tools-and-mcp.md#2-toolsource
 */
import type { Tool, ToolSet } from 'ai'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import { TOOL_NAME_PATTERN } from './static.ts'
import { RESERVED_TOOL_NAMES, type ToolSource } from './types.ts'

/** A tool of the turn with its owner, in stable order (spec 02 §6 rule 1). */
export interface TurnToolEntry {
  owner: string
  name: string
  tool: Tool
  /** Set for tools listed by a source. */
  source?: string
}

/**
 * List the tools of every source (plugin order, then `list()` order) for one turn.
 *
 * - `refresh: 'session'` (default) sources are listed once per session (cached in `cache`),
 *   `'turn'` sources before every turn.
 * - A failing `list()` contributes nothing for this turn and is retried next turn
 *   (`W_TOOL_SOURCE_FAILED`).
 * - Invalid names are skipped (`W_INVALID_TOOL_NAME`); reserved names and names already taken
 *   (static tools, earlier sources) are skipped (`W_SHADOWED`).
 */
export async function listSourceTools(args: {
  sources: ReadonlyArray<{ owner: string; source: ToolSource }>
  cache: Map<ToolSource, Array<{ name: string; tool: Tool }>>
  taken: Set<string>
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
}): Promise<TurnToolEntry[]> {
  const out: TurnToolEntry[] = []
  for (const { owner, source } of args.sources) {
    let listed = source.refresh === 'turn' ? undefined : args.cache.get(source)
    if (listed === undefined) {
      let set: ToolSet
      try {
        set = await source.list(args.contextOf(owner))
      } catch (error) {
        args.warn(
          {
            code: 'W_TOOL_SOURCE_FAILED',
            message: `Tool source '${source.id}' failed to list its tools: ${error instanceof Error ? error.message : String(error)}`,
            details: { source: source.id, owner },
          },
          source.id,
        )
        continue
      }
      listed = Object.entries(set ?? {}).map(([name, tool]) => ({ name, tool }))
      if (source.refresh !== 'turn') args.cache.set(source, listed)
    }
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
