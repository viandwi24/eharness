/**
 * The turn's `tool_search` tool (internal): AI SDK's `toolSearch()` with a search function that
 * understands `select:<name>[,<name>]`, says why a name cannot be loaded, and stops loops; and the
 * short readable error for a call to a tool the step does not offer (spec 02 §3.3).
 *
 * @see docs/specs/02-context-registry.md#33-deferred-tools-and-tool-search
 */
import { type Tool, type ToolSet, toolSearch } from 'ai'

const SELECT = /^\s*select:\s*(.+)$/i

/** Words of a name or text, like AI SDK's own default tool search ranks them. */
function tokens(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/** Names from `names` that look like `name` (shared words or a substring), best first. */
export function closeMatches(name: string, names: readonly string[], limit = 3): string[] {
  const words = new Set(tokens(name))
  const low = name.toLowerCase()
  return names
    .map((n) => {
      const hit = tokens(n).filter((w) => words.has(w)).length
      const sub = n.toLowerCase().includes(low) || low.includes(n.toLowerCase()) ? 2 : 0
      return { n, score: hit + sub }
    })
    .filter((m) => m.score > 0 && m.n !== name)
    .sort((a, b) => b.score - a.score || (a.n < b.n ? -1 : 1))
    .slice(0, limit)
    .map((m) => m.n)
}

/** The names a `select:` query asks for, or undefined for a keyword query. */
export function selectedNames(query: string): string[] | undefined {
  const m = SELECT.exec(query)
  if (m === null) return undefined
  return (m[1] as string)
    .split(/[\s,]+/)
    .map((n) => n.trim())
    .filter((n) => n !== '')
}

/** Why a tool of this name is not loadable, from the tool sources that know (`ToolSourceDef.explain`). */
export type ExplainTool = (name: string) => Promise<string | undefined>

export interface ToolSearchArgs {
  /** Every tool of the turn (wrapped), deferred or not. */
  tools: () => ToolSet
  /** Names discovered so far in the turn (the loop's set; it grows between steps). */
  discovered: () => ReadonlySet<string>
  explain?: ExplainTool | undefined
}

/** `tool_search` for one turn. The base tool's description is kept (prompt-cache prefix). */
export function buildToolSearch(args: ToolSearchArgs): Tool {
  const base = toolSearch() as Tool
  /** Sentence per missing `select:` name, set by the search, read when the model output is built. */
  const reasons = new Map<string, string>()
  const seen = new Set<string>()
  const search = async (options: {
    query: string
    tools: Array<{ name: string; description?: string }>
  }): Promise<string[]> => {
    const key = options.query.trim().toLowerCase()
    // the same search again finds nothing new: its matches are loaded, or there were none
    if (seen.has(key)) return []
    seen.add(key)
    const wanted = selectedNames(options.query)
    const deferred = new Map(options.tools.map((t) => [t.name, t]))
    if (wanted !== undefined) {
      const out: string[] = []
      for (const name of wanted) {
        if (deferred.has(name)) {
          out.push(name)
          // only read when the same search comes back empty
          reasons.set(name, `${name} is already loaded: call it directly.`)
          continue
        }
        const all = args.tools()
        const known = all[name] as Tool | undefined
        if (known !== undefined && (known.deferLoading !== true || args.discovered().has(name))) {
          reasons.set(name, `${name} is already loaded: call it directly.`)
          continue
        }
        let why: string | undefined
        try {
          why = await args.explain?.(name)
        } catch {
          why = undefined
        }
        if (why !== undefined && why !== '') {
          reasons.set(name, `${name} is not available: ${why}`)
          continue
        }
        const close = closeMatches(name, [...deferred.keys()])
        reasons.set(
          name,
          `${name} is not available in this session (no such tool, or it is switched off for you).${close.length > 0 ? ` Close matches: ${close.join(', ')}.` : ''}`,
        )
      }
      return out
    }
    const terms = [...new Set(tokens(options.query))]
    return options.tools
      .map(({ name, description }) => {
        const n = tokens(name)
        const d = tokens(description ?? '')
        return {
          name,
          score: terms.reduce((s, t) => s + (n.includes(t) ? 2 : 0) + (d.includes(t) ? 1 : 0), 0),
        }
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.name)
  }
  const custom = toolSearch({ search }) as Tool
  return {
    ...custom,
    description: base.description,
    toModelOutput: ({ input, output }: { input: unknown; output: unknown }) => {
      const found = (output as { tools?: unknown[] } | undefined)?.tools
      if (Array.isArray(found) && found.length > 0) return { type: 'json', value: output }
      const query = String((input as { query?: unknown } | undefined)?.query ?? '')
      const wanted = selectedNames(query)
      const stop =
        'Do not search for it again: tell the person plainly what you cannot do, or use a tool you already have.'
      if (wanted !== undefined) {
        const lines = wanted.map((name) => {
          const text = reasons.get(name) ?? `${name} is not available in this session.`
          return /[.!?]$/.test(text) ? text : `${text}.`
        })
        return { type: 'text', value: `No new tool was loaded. ${lines.join(' ')} ${stop}` }
      }
      return {
        type: 'text',
        value: `No new tool matches "${query}" (tools found by earlier searches are already loaded: call them). Do not repeat this search; try different keywords once at most, or ${stop.charAt(0).toLowerCase()}${stop.slice(1)}`,
      }
    },
  } as Tool
}

/**
 * The error text of a call to a tool this step does not offer. It keeps the "unavailable tool"
 * words AI SDK's own text has, and drops its list of every available tool.
 */
export function noSuchToolText(name: string, tools: ToolSet): string {
  const own = Object.hasOwn(tools, name) ? (tools[name] as Tool) : undefined
  const head = `Model tried to call unavailable tool '${name}'`
  if (own !== undefined && own.deferLoading === true) {
    return `${head}: it was not loaded yet (call tool_search with select:${name} first). It is loaded now: call it again.`
  }
  if (own !== undefined) {
    return `${head}: it exists but is not offered in this step. Use another tool, or answer without it.`
  }
  const close = closeMatches(name, Object.keys(tools))
  const search = Object.hasOwn(tools, 'tool_search')
    ? ' Find deferred tools with tool_search (select:<name> or keywords).'
    : ''
  return `${head}: no tool has that name.${close.length > 0 ? ` Close matches: ${close.join(', ')}.` : ''}${search}`
}
