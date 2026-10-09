/**
 * Registry inventory (internal): the tool entries of a turn (static, skill, source, `tool_search`),
 * the explicit `toolOrder`, the public tool listing (`session.tools()`) and the per-owner /
 * per-source splits of `ContextStats`.
 *
 * @see docs/specs/02-context-registry.md#3-tools
 * @see docs/specs/06-compaction.md#2-token-accounting
 */
import { asSchema, type JSONSchema7, type Tool } from 'ai'
import { type CountTokens, toolTokens } from '../compaction/tokens.ts'
import type { HarnessWarning } from '../errors.ts'
import type { InstructionBlockStats, ToolSourceStats } from '../messages/types.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { OpenSession } from '../session/runtime.ts'
import { resolveTurnSkills, type TurnSkills } from '../skills/registry.ts'
import { createSkillTools } from '../skills/tools.ts'
import { listSourceTools, type TurnToolEntry, withToolSearch } from './tools.ts'

/**
 * One tool the model sees, as listed by `session.tools()` (spec 02 §3.4).
 *
 * @see docs/specs/02-context-registry.md#34-session-tool-listing
 */
export interface SessionToolInfo {
  name: string
  description?: string
  /** JSON Schema of the input (`{}` for a tool without one, e.g. some provider tools). */
  inputSchema: JSONSchema7
  /**
   * Where the tool comes from: `'app'` (agent config), `plugin:<name>`, `source:<id>` (a tool
   * source, e.g. an MCP server) or `'core'` (skill tools, `tool_search`).
   */
  source: 'app' | 'core' | `plugin:${string}` | `source:${string}`
  /** Hidden from the model until discovered through `tool_search` (spec 02 §3.3). */
  deferred: boolean
  /** Estimated tokens of the definition (name, description, schema), calibrated like `ContextStats.tools`. */
  tokens: number
}

/** The text of one instruction block of a turn, with its owner and refresh class. */
export interface InstructionBlock {
  owner: string
  refresh: 'static' | 'session' | 'turn'
  text: string
}

/** Label of the source of a tool entry (`SessionToolInfo.source`). */
export function toolSourceLabel(entry: TurnToolEntry): SessionToolInfo['source'] {
  if (entry.source !== undefined) return `source:${entry.source}`
  if (entry.owner === 'app') return 'app'
  if (entry.owner === 'eh') return 'core'
  return `plugin:${entry.owner}`
}

/** What {@link collectToolEntries} found. */
export interface CollectedTools {
  /** Unwrapped entries in default order (static → skill → source → `tool_search`). */
  entries: TurnToolEntry[]
  /** Number of leading static tools. */
  staticCount: number
}

/**
 * The tool entries of a turn in the default order (spec 02 §6 rule 1): static tools, skill tools,
 * source tools (listed per their `refresh`), `tool_search` when any tool is deferred.
 */
export async function collectToolEntries(args: {
  open: OpenSession
  skills: TurnSkills
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
  /** `config.deferTools` (spec 02 §3.3). */
  deferTools?: readonly string[] | undefined
}): Promise<CollectedTools> {
  const { open } = args
  const raw: TurnToolEntry[] = open.tools.map((t) => ({
    owner: t.owner,
    name: t.name,
    tool: t.tool,
  }))
  const staticCount = raw.length
  for (const { name, tool } of createSkillTools({
    skills: args.skills,
    hooks: open.hooks,
    contextOf: args.contextOf,
    warn: args.warn,
  })) {
    raw.push({ owner: 'eh', name, tool })
  }
  raw.push(
    ...(await listSourceTools({
      sources: open.toolSources,
      cache: open.sourceCache,
      taken: new Set(raw.map((t) => t.name)),
      contextOf: args.contextOf,
      warn: args.warn,
    })),
  )
  const defer = new Set(args.deferTools ?? [])
  const marked =
    defer.size === 0
      ? raw
      : raw.map((entry) =>
          defer.has(entry.name) && entry.tool.deferLoading !== true
            ? { ...entry, tool: { ...entry.tool, deferLoading: true } as Tool }
            : entry,
        )
  return { entries: withToolSearch(marked), staticCount }
}

/** Skills of a turn (shared by the turn registry and the idle inspection). */
export function turnSkills(
  open: OpenSession,
  contextOf: (owner: string) => HarnessContext,
  warn: (warning: HarnessWarning, key?: string) => void,
): Promise<TurnSkills> {
  return resolveTurnSkills({ skills: open.skills, contextOf, warn })
}

/**
 * Apply `config.toolOrder` (spec 02 §6): listed names first in the listed order, the rest after in
 * their default order. Names that match no tool are ignored and reported once per session
 * (`W_TOOL_ORDER`); `reserved` names (the per-turn output tool) are not reported.
 */
export function applyToolOrder<T extends { name: string }>(
  entries: T[],
  order: readonly string[] | undefined,
  warn: (warning: HarnessWarning, key?: string) => void,
  warned: Set<string>,
  reserved: readonly string[] = [],
): T[] {
  if (order === undefined || order.length === 0) return entries
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const first: T[] = []
  const placed = new Set<string>()
  const unknown: string[] = []
  for (const name of order) {
    const entry = byName.get(name)
    if (entry === undefined) {
      if (!reserved.includes(name) && !warned.has(name)) unknown.push(name)
      continue
    }
    if (placed.has(name)) continue
    placed.add(name)
    first.push(entry)
  }
  if (unknown.length > 0) {
    for (const name of unknown) warned.add(name)
    warn(
      {
        code: 'W_TOOL_ORDER',
        message: `config.toolOrder names tools that do not exist in this session: ${unknown.map((n) => `'${n}'`).join(', ')}; ignored.`,
        details: { tools: unknown },
      },
      `tool-order:${unknown.join(',')}`,
    )
  }
  return [...first, ...entries.filter((entry) => !placed.has(entry.name))]
}

/** `session.tools()`: one {@link SessionToolInfo} per entry, in request order. */
export async function describeTools(
  entries: readonly TurnToolEntry[],
  count: CountTokens,
  calibrate: (tokens: number) => number,
): Promise<SessionToolInfo[]> {
  const out: SessionToolInfo[] = []
  for (const entry of entries) {
    let inputSchema: JSONSchema7 = {}
    try {
      const input = (entry.tool as { inputSchema?: unknown }).inputSchema
      if (input !== undefined) {
        inputSchema = (await asSchema(input as Parameters<typeof asSchema>[0])
          .jsonSchema) as JSONSchema7
      }
    } catch {
      inputSchema = {}
    }
    out.push({
      name: entry.name,
      ...(typeof entry.tool.description === 'string'
        ? { description: entry.tool.description }
        : {}),
      inputSchema,
      source: toolSourceLabel(entry),
      deferred: entry.tool.deferLoading === true,
      tokens: calibrate(await toolTokens(entry.name, entry.tool, count)),
    })
  }
  return out
}

/** `ContextStats.toolSources`: tools and tokens per source, in order of first appearance. */
export async function toolSourceStats(
  entries: readonly TurnToolEntry[],
  count: CountTokens,
  calibrate: (tokens: number) => number,
): Promise<ToolSourceStats[]> {
  const out = new Map<string, ToolSourceStats>()
  for (const entry of entries) {
    const source = toolSourceLabel(entry)
    const stats = out.get(source) ?? { source, tools: 0, tokens: 0 }
    stats.tools++
    // deferred tools are not sent until discovered (spec 02 §3.3)
    if (entry.tool.deferLoading !== true) {
      stats.tokens += calibrate(await toolTokens(entry.name, entry.tool, count))
    }
    out.set(source, stats)
  }
  return [...out.values()]
}

/**
 * `ContextStats.instructionBlocks`: one entry per (owner, refresh) in prompt order, with the
 * calibrated tokens of the owner's text.
 */
export function instructionBlockStats(
  blocks: readonly InstructionBlock[],
  count: CountTokens,
  calibrate: (tokens: number) => number,
): InstructionBlockStats[] {
  const merged = new Map<
    string,
    { owner: string; refresh: InstructionBlock['refresh']; text: string[] }
  >()
  for (const block of blocks) {
    if (block.text.length === 0) continue
    const key = `${block.refresh}\0${block.owner}`
    const entry = merged.get(key) ?? { owner: block.owner, refresh: block.refresh, text: [] }
    entry.text.push(block.text)
    merged.set(key, entry)
  }
  return [...merged.values()].map((entry) => ({
    owner: entry.owner,
    refresh: entry.refresh,
    tokens: calibrate(count(entry.text.join('\n\n'))),
  }))
}
