/**
 * The per-turn registry (internal): system blocks, turn reminder text, the wrapped tool set in
 * stable order, and the step tool set with tool-search discoveries.
 *
 * The resolved set is locked for the turn (spec 02 §7), except tools discovered via tool search.
 * Skills: the index is appended to block 1 (static skills) / block 2 (dynamic sources), and the
 * skill tools follow the static tools (spec 02 §6 rule 1); source tools follow, and `tool_search`
 * comes last when any tool is deferred.
 *
 * @see docs/specs/02-context-registry.md#8-registry-api-internal-but-tested
 */
import type { GenericToolApprovalFunction, Tool, ToolInputRefinement, ToolSet } from 'ai'
import type { ApprovalConfig, ToolOutputConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { OpenSession } from '../session/runtime.ts'
import { resolveTurnSkills, type SkillIndexEntry } from '../skills/registry.ts'
import { createSkillTools } from '../skills/tools.ts'
import type { ToolOutputSink } from './output-limits.ts'
import type { NormalizedInstruction } from './static.ts'
import { listSourceTools, type TurnToolEntry, withToolSearch } from './tools.ts'
import {
  type ApprovalGrants,
  buildApproval,
  buildRefinement,
  type ToolWrapDeps,
  wrapTool,
} from './wrap.ts'

/** Everything the model can see and call in one turn. */
export interface TurnRegistry {
  /** System block 1: static instructions + static skills index. */
  block1: string | undefined
  /** System block 2: session-refresh instructions + dynamic skills index. */
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
  /** Skills of the turn (locked), sorted by name. */
  skills: SkillIndexEntry[]
}

function appendBlock(block: string | undefined, text: string | undefined): string | undefined {
  if (text === undefined) return block
  return block === undefined ? text : `${block}\n\n${text}`
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
  /** `config.toolOutput` (spec 09 §4). */
  toolOutput?: ToolOutputConfig | undefined
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
  status: (toolName: string) => void
  /** Session approval grants (spec 11 §3.1). */
  grants?: ApprovalGrants
}): Promise<TurnRegistry> {
  const { open, contextOf } = args
  const instructions1 = await evaluate(open.instructions, (e) => e.kind === 'static', contextOf)
  if (open.sessionBlock === undefined) {
    open.sessionBlock =
      (await evaluate(
        open.instructions,
        (e) => e.kind === 'dynamic' && e.refresh === 'session',
        contextOf,
      )) ?? ''
  }
  const skills = await resolveTurnSkills({ skills: open.skills, contextOf, warn: args.warn })
  const block1 = appendBlock(instructions1, skills.staticText)
  const block2 = appendBlock(
    open.sessionBlock === '' ? undefined : open.sessionBlock,
    skills.dynamicText,
  )
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
    limits: {
      config: args.toolOutput,
      // looked up by name without throwing: absent when no plugin provides it (spec 09 §4)
      toolOutputs: open.services.get('toolOutputs') as ToolOutputSink | undefined,
    },
  }
  let raw: TurnToolEntry[] = open.tools.map((t) => ({
    owner: t.owner,
    name: t.name,
    tool: t.tool,
  }))
  const staticCount = raw.length
  const skillTools = createSkillTools({
    skills,
    hooks: open.hooks,
    contextOf,
    warn: args.warn,
  })
  for (const { name, tool } of skillTools) raw.push({ owner: 'eh', name, tool })
  raw.push(
    ...(await listSourceTools({
      sources: open.toolSources,
      cache: open.sourceCache,
      taken: new Set(raw.map((t) => t.name)),
      contextOf,
      warn: args.warn,
    })),
  )
  raw = withToolSearch(raw)
  for (const entry of raw) {
    if (entry.tool.needsApproval !== undefined) {
      args.warn(
        {
          code: 'W_DEPRECATED',
          message: `Tool '${entry.name}' sets the deprecated \`needsApproval\`; use \`approval.policy\` or a \`tool.approve\` hook (AI SDK still evaluates it).`,
          details: { tool: entry.name, api: 'needsApproval' },
        },
        `needsApproval:${entry.name}`,
      )
    }
  }
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
    approval: buildApproval(args.approval, deps, args.grants),
    skills: skills.entries,
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
