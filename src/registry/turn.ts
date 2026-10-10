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
import type { ApprovalConfig, ToolErrorTextFn, ToolOutputConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { neutralizeTags } from '../messages/framing.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { OpenSession } from '../session/runtime.ts'
import type { SkillIndexEntry } from '../skills/registry.ts'
import { type ExternalToolMeta, externalOf } from './external.ts'
import {
  applyToolOrder,
  collectToolEntries,
  type InstructionBlock,
  turnSkills,
} from './inventory.ts'
import type { ToolOutputSink } from './output-limits.ts'
import {
  type BuiltRequestTools,
  buildRequestTools,
  type ClientToolsOptions,
  type PageContextOptions,
  type RequestToolMeta,
  renderPageContext,
} from './request-tools.ts'
import type { NormalizedInstruction } from './static.ts'
import type { TurnToolEntry } from './tools.ts'
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
  /** Instruction blocks by owner and refresh class, in prompt order (`ContextStats`). */
  instructionBlocks: InstructionBlock[]
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
  /** `externalTool()`s of the turn by name, with their owner (also listed in `clientTools`). */
  externals: ReadonlyMap<string, { owner: string; meta: ExternalToolMeta }>
  /**
   * Request-scoped client tools of the turn (spec 11 §7.1) by name, with their timeout; also
   * listed in `clientTools`. Empty when the request declared none.
   */
  requestTools: ReadonlyMap<string, RequestToolMeta>
  /** Signature of the request tool declarations ('' = none): cache-bust detection per session. */
  requestToolsSignature: string
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

/** The non-empty texts of the selected instructions, with their owners (prompt order). */
async function evaluateParts(
  instructions: readonly NormalizedInstruction[],
  select: (entry: NormalizedInstruction) => boolean,
  contextOf: (owner: string) => HarnessContext,
): Promise<Array<{ owner: string; text: string }>> {
  const parts: Array<{ owner: string; text: string }> = []
  for (const entry of instructions) {
    if (!select(entry)) continue
    const text = entry.kind === 'static' ? entry.text : await entry.fn(contextOf(entry.owner))
    if (typeof text === 'string' && text.trim().length > 0) parts.push({ owner: entry.owner, text })
  }
  return parts
}

function joinParts(parts: ReadonlyArray<{ text: string }>): string | undefined {
  return parts.length === 0 ? undefined : parts.map((p) => p.text).join('\n\n')
}

/**
 * The session block (session-refresh instructions) of an open session, evaluated once and cached
 * on the session (`sessionBlock` as one text, `sessionParts` by owner).
 */
export async function ensureSessionBlock(
  open: OpenSession,
  contextOf: (owner: string) => HarnessContext,
): Promise<Array<{ owner: string; text: string }>> {
  if (open.sessionBlock === undefined) {
    const parts = await evaluateParts(
      open.instructions,
      (e) => e.kind === 'dynamic' && e.refresh === 'session',
      contextOf,
    )
    open.sessionParts = parts
    open.sessionBlock = joinParts(parts) ?? ''
  }
  return (
    open.sessionParts ??
    (open.sessionBlock === '' ? [] : [{ owner: 'app', text: open.sessionBlock }])
  )
}

/**
 * Turn reminder listing the deferred tools by name (spec 02 §3.3), so the model knows they exist
 * and can load them with `tool_search`. Undefined when no tool is deferred.
 */
export function deferredToolsReminder(entries: readonly TurnToolEntry[]): string | undefined {
  const lines = entries
    .filter((entry) => entry.tool.deferLoading === true)
    .map((entry) => {
      const description = typeof entry.tool.description === 'string' ? entry.tool.description : ''
      const first = neutralizeTags(description.split('\n')[0]?.trim() ?? '', [
        'system-reminder',
        'untrusted-content',
        'event',
        'agent-message',
      ]).replace(/[\r\n]+/g, ' ')
      const short = first.length > 100 ? `${first.slice(0, 99)}…` : first
      return short === '' ? `- ${entry.name}` : `- ${entry.name}: ${short}`
    })
  if (lines.length === 0) return undefined
  return [
    'Deferred tools: these tools exist but their schemas are not loaded. Load one with `tool_search` (for example `select:<name>`, or keywords) before calling it.',
    ...lines,
  ].join('\n')
}

/** The model-visible context of an idle session, resolved like a turn would (no request tools). */
export interface RegistryInspection {
  /** The three instruction texts of a request (blocks 1–2 and the turn reminder). */
  block1: string | undefined
  block2: string | undefined
  turnReminder: string | undefined
  instructionBlocks: InstructionBlock[]
  /** Unwrapped tool entries in request order (`config.toolOrder` applied). */
  entries: TurnToolEntry[]
}

/**
 * Resolve what the next request would carry — instructions (turn-refresh ones evaluated), skills,
 * tools in request order — without running a turn (`session.tools()`, `session.stats()`). It lists
 * tool sources like a turn does: `refresh: 'turn'` sources are listed again on every call.
 */
export async function inspectRegistry(args: {
  open: OpenSession
  toolOrder?: readonly string[] | undefined
  deferTools?: readonly string[] | undefined
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
}): Promise<RegistryInspection> {
  const { open, contextOf } = args
  const staticParts = await evaluateParts(open.instructions, (e) => e.kind === 'static', contextOf)
  const sessionParts = await ensureSessionBlock(open, contextOf)
  const skills = await turnSkills(open, contextOf, args.warn)
  const turnParts = await evaluateParts(
    open.instructions,
    (e) => e.kind === 'dynamic' && e.refresh === 'turn',
    contextOf,
  )
  const collected = await collectToolEntries({
    open,
    skills,
    contextOf,
    warn: args.warn,
    deferTools: args.deferTools,
  })
  const deferredText = deferredToolsReminder(collected.entries)
  open.toolOrderWarned ??= new Set()
  return {
    block1: appendBlock(joinParts(staticParts), skills.staticText),
    block2: appendBlock(
      open.sessionBlock === '' ? undefined : open.sessionBlock,
      skills.dynamicText,
    ),
    turnReminder: appendBlock(joinParts(turnParts), deferredText),
    instructionBlocks: [
      ...staticParts.map((p): InstructionBlock => ({ ...p, refresh: 'static' })),
      ...(skills.staticText === undefined
        ? []
        : [{ owner: 'core:skills', refresh: 'static' as const, text: skills.staticText }]),
      ...sessionParts.map((p): InstructionBlock => ({ ...p, refresh: 'session' })),
      ...(skills.dynamicText === undefined
        ? []
        : [{ owner: 'core:skills', refresh: 'session' as const, text: skills.dynamicText }]),
      ...turnParts.map((p): InstructionBlock => ({ ...p, refresh: 'turn' })),
      ...(deferredText === undefined
        ? []
        : [{ owner: 'core:tools', refresh: 'turn' as const, text: deferredText }]),
    ],
    entries: applyToolOrder(collected.entries, args.toolOrder, args.warn, open.toolOrderWarned),
  }
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
  /** `config.toolOrder` (spec 02 §6). */
  toolOrder?: readonly string[] | undefined
  /** `config.deferTools` (spec 02 §3.3). */
  deferTools?: readonly string[] | undefined
  /** `config.toolErrorText` (spec 10 §1.1). */
  toolErrorText?: ToolErrorTextFn | undefined
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
  status: (toolName: string) => void
  /** Session approval grants (spec 11 §3.1). */
  grants?: ApprovalGrants
  /** `SendOptions.clientTools` / `clientToolsOptions` (spec 11 §7.1); untrusted, validated here. */
  clientTools?: unknown
  clientToolsOptions?: ClientToolsOptions | undefined
  /** `SendOptions.pageContext` / `pageContextOptions` (spec 11 §7.1 rule 6). */
  pageContext?: unknown
  pageContextOptions?: PageContextOptions | undefined
  /** Tool names the server keeps for itself this turn (the output tool): never declarable. */
  reservedNames?: readonly string[]
}): Promise<TurnRegistry> {
  const { open, contextOf } = args
  const staticParts = await evaluateParts(open.instructions, (e) => e.kind === 'static', contextOf)
  const sessionParts = await ensureSessionBlock(open, contextOf)
  const skills = await turnSkills(open, contextOf, args.warn)
  const block1 = appendBlock(joinParts(staticParts), skills.staticText)
  const block2 = appendBlock(
    open.sessionBlock === '' ? undefined : open.sessionBlock,
    skills.dynamicText,
  )
  const turnParts = await evaluateParts(
    open.instructions,
    (e) => e.kind === 'dynamic' && e.refresh === 'turn',
    contextOf,
  )
  const collected = await collectToolEntries({
    open,
    skills,
    contextOf,
    warn: args.warn,
    deferTools: args.deferTools,
  })
  const deferredText = deferredToolsReminder(collected.entries)
  const instructionReminder = appendBlock(joinParts(turnParts), deferredText)
  // page context: data from the client, after the plugins' reminders, never stored (rule 6)
  const pageContext = renderPageContext(args.pageContext, args.pageContextOptions, args.warn)
  const turnReminder = appendBlock(instructionReminder, pageContext)
  const instructionBlocks: InstructionBlock[] = [
    ...staticParts.map((p): InstructionBlock => ({ ...p, refresh: 'static' })),
    ...(skills.staticText === undefined
      ? []
      : [{ owner: 'core:skills', refresh: 'static' as const, text: skills.staticText }]),
    ...sessionParts.map((p): InstructionBlock => ({ ...p, refresh: 'session' })),
    ...(skills.dynamicText === undefined
      ? []
      : [{ owner: 'core:skills', refresh: 'session' as const, text: skills.dynamicText }]),
    ...turnParts.map((p): InstructionBlock => ({ ...p, refresh: 'turn' })),
    ...(deferredText === undefined
      ? []
      : [{ owner: 'core:tools', refresh: 'turn' as const, text: deferredText }]),
    ...(pageContext === undefined
      ? []
      : [{ owner: 'core:page-context', refresh: 'turn' as const, text: pageContext }]),
  ]

  const deps: ToolWrapDeps = {
    hooks: open.hooks,
    contextOf,
    warn: args.warn,
    status: args.status,
    ...(args.toolErrorText === undefined ? {} : { toolErrorText: args.toolErrorText }),
    limits: {
      config: args.toolOutput,
      // looked up by name without throwing: absent when no plugin provides it (spec 09 §4)
      toolOutputs: open.services.get('toolOutputs') as ToolOutputSink | undefined,
    },
  }
  let raw: TurnToolEntry[] = collected.entries
  let staticCount = collected.staticCount
  // request-scoped client tools come after `tool_search` (last of the static prefix) and before
  // the output tool, sorted by name (spec 02 §6 rule 1)
  const requestBuilt: BuiltRequestTools | undefined = buildRequestTools(
    args.clientTools,
    new Set([...raw.map((entry) => entry.name), ...(args.reservedNames ?? [])]),
    args.clientToolsOptions,
  )
  if (requestBuilt !== undefined) {
    for (const { name, tool } of requestBuilt.tools) raw.push({ owner: 'eh', name, tool })
  }
  // `config.toolOrder` (spec 02 §6): explicit names first, the rest in the default order
  const configuredOrder = args.toolOrder
  if (configuredOrder !== undefined && configuredOrder.length > 0) {
    const staticNames = new Set(raw.slice(0, staticCount).map((entry) => entry.name))
    open.toolOrderWarned ??= new Set()
    raw = applyToolOrder(raw, configuredOrder, args.warn, open.toolOrderWarned, args.reservedNames)
    // the cache breakpoint stays on the last tool of the (reordered) static prefix
    let last = -1
    for (const [i, entry] of raw.entries()) if (staticNames.has(entry.name)) last = i
    staticCount = last + 1
  }
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
  // no prototype: a plugin or client tool name can never reach `Object.prototype` (`__proto__`)
  const tools: ToolSet = Object.create(null) as ToolSet
  const clientTools = new Set<string>()
  const externals = new Map<string, { owner: string; meta: ExternalToolMeta }>()
  for (const entry of entries) {
    tools[entry.name] = entry.tool
    if (typeof entry.tool.execute !== 'function' && entry.tool.type !== 'provider') {
      clientTools.add(entry.name)
      const meta = externalOf(entry.tool)
      if (meta !== undefined) externals.set(entry.name, { owner: entry.owner, meta })
    }
  }
  const toolOrder = entries.map((e) => e.name)
  return {
    block1,
    block2,
    turnReminder,
    instructionBlocks,
    entries,
    staticCount,
    tools,
    toolOrder,
    clientTools,
    externals,
    requestTools: requestBuilt?.meta ?? new Map(),
    requestToolsSignature: requestBuilt?.signature ?? '',
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
