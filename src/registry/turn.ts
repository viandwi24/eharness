/**
 * The per-turn registry (internal): system blocks, turn reminder text, the wrapped tool set in
 * stable order, and the step tool set with tool-search discoveries.
 *
 * The resolved set is locked for the turn (spec 02 §7), except tools discovered via tool search.
 * Skills (index block, skill tools) are added by P4; deferral and `tool_search` by P6.
 *
 * @see docs/specs/02-context-registry.md#8-registry-api-internal-but-tested
 */
import type { GenericToolApprovalFunction, Tool, ToolInputRefinement, ToolSet } from 'ai'
import type { ApprovalConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { OpenSession } from '../session/runtime.ts'
import type { NormalizedInstruction } from './static.ts'
import { listSourceTools, type TurnToolEntry } from './tools.ts'
import { buildApproval, buildRefinement, type ToolWrapDeps, wrapTool } from './wrap.ts'

/** Everything the model can see and call in one turn. */
export interface TurnRegistry {
  /** System block 1: static instructions (+ static skills index, P4). */
  block1: string | undefined
  /** System block 2: session-refresh instructions (+ dynamic skills index, P4). */
  block2: string | undefined
  /** Turn-refresh instructions, sent as the turn reminder. */
  turnReminder: string | undefined
  /** Wrapped tools with owners, in stable order (spec 02 §6 rule 1). */
  entries: TurnToolEntry[]
  /** Number of leading static tools in `entries`. */
  staticCount: number
  /** Wrapped tool set (insertion order = stable order). */
  tools: ToolSet
  /** Stable order passed to AI SDK as `toolOrder`. */
  toolOrder: string[]
  /** Names of tools without `execute` (client tools, spec 09 §6). */
  clientTools: ReadonlySet<string>
  refine: ToolInputRefinement<ToolSet> | undefined
  approval: GenericToolApprovalFunction<ToolSet, never, unknown> | undefined
  /** Tool set for one step: deferred tools in `discovered` become non-deferred copies. */
  toolsForStep(discovered: ReadonlySet<string>): ToolSet
}

async function evaluate(
  instructions: readonly NormalizedInstruction[],
  select: (entry: NormalizedInstruction) => boolean,
  contextOf: (owner: string) => HarnessContext,
): Promise<string | undefined> {
  const texts: string[] = []
  for (const entry of instructions) {
    if (!select(entry)) continue
    const text = entry.kind === 'static' ? entry.text : await entry.fn(contextOf(entry.owner))
    if (typeof text === 'string' && text.trim().length > 0) texts.push(text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * Resolve the registry of one turn: system blocks (block 2 cached for the session), turn
 * reminder, static tools + source tools, wrapping, refinement and approval.
 */
export async function resolveTurnRegistry(args: {
  open: OpenSession
  approval: ApprovalConfig | undefined
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
  status: (toolName: string) => void
}): Promise<TurnRegistry> {
  const { open, contextOf } = args
  const block1 = await evaluate(open.instructions, (e) => e.kind === 'static', contextOf)
  if (open.sessionBlock === undefined) {
    open.sessionBlock =
      (await evaluate(
        open.instructions,
        (e) => e.kind === 'dynamic' && e.refresh === 'session',
        contextOf,
      )) ?? ''
  }
  const block2 = open.sessionBlock === '' ? undefined : open.sessionBlock
  const turnReminder = await evaluate(
    open.instructions,
    (e) => e.kind === 'dynamic' && e.refresh === 'turn',
    contextOf,
  )

  const deps: ToolWrapDeps = {
    hooks: open.hooks,
    contextOf,
    warn: args.warn,
    status: args.status,
  }
  const raw: TurnToolEntry[] = open.tools.map((t) => ({
    owner: t.owner,
    name: t.name,
    tool: t.tool,
  }))
  const staticCount = raw.length
  raw.push(
    ...(await listSourceTools({
      sources: open.toolSources,
      cache: open.sourceCache,
      taken: new Set(raw.map((t) => t.name)),
      contextOf,
      warn: args.warn,
    })),
  )
  const entries = raw.map((entry) => ({ ...entry, tool: wrapTool(entry.name, entry.tool, deps) }))
  const tools: ToolSet = {}
  const clientTools = new Set<string>()
  for (const entry of entries) {
    tools[entry.name] = entry.tool
    if (typeof entry.tool.execute !== 'function' && entry.tool.type !== 'provider') {
      clientTools.add(entry.name)
    }
  }
  const toolOrder = entries.map((e) => e.name)
  return {
    block1,
    block2,
    turnReminder,
    entries,
    staticCount,
    tools,
    toolOrder,
    clientTools,
    refine: buildRefinement(toolOrder, deps),
    approval: buildApproval(args.approval, deps),
    toolsForStep(discovered) {
      let changed = false
      const out: ToolSet = {}
      for (const [name, tool] of Object.entries(tools)) {
        if ((tool as Tool).deferLoading === true && discovered.has(name)) {
          out[name] = { ...(tool as Tool), deferLoading: false } as Tool
          changed = true
        } else {
          out[name] = tool
        }
      }
      return changed ? out : tools
    },
  }
}
