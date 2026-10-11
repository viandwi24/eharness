/**
 * The resolved configuration of one `subagent()` plugin (`Env`) and the state of one session's
 * instance of it (`Scope`). Every phase of the plugin (directory, routing, the four execution
 * modes) is a module-level function over these two values; nothing lives in a closure.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { errorText, HarnessError, type SessionOptions, type SessionPeek } from '../index.ts'
import { createSemaphore, type Semaphore } from './child-run.ts'
import {
  AGENT_STOP_TOOL,
  type AgentDirectory,
  type AgentEntry,
  type AgentSender,
  DIRECTORY_RUNTIME_KEY,
  resolveLimits,
  SEND_MESSAGE_TOOL,
} from './messaging.ts'
import type { SubagentTaskRegistry } from './tasks.ts'
import {
  AGENT_OUTPUT_TOOL,
  AGENT_REPORT_MAX_CHARS,
  AGENT_TOOL,
  type AgentInput,
  type AnyAgent,
  type Ctx,
  type SubagentChildInfo,
  type SubagentDefinition,
  type SubagentOptions,
} from './types.ts'

/** Where a report goes: the `inject` of some session (ADR-0038). */
export type Reporter = (text: string, data: Record<string, unknown>) => Promise<void>

/** The plugin options, resolved once, plus the helpers that derive session options from them. */
export interface Env {
  readonly options: SubagentOptions
  readonly toolName: string
  readonly maxDepth: number
  readonly maxConcurrent: number
  /** `approvals: 'park'`. */
  readonly park: boolean
  readonly backgroundOn: boolean
  readonly backgroundDefault: boolean
  readonly backgroundInChildren: boolean
  readonly messaging: boolean
  readonly messageToolName: string
  readonly limits: ReturnType<typeof resolveLimits>
  readonly outputEnabled: boolean
  readonly outputToolName: string
  readonly stopEnabled: boolean
  readonly stopToolName: string
  readonly reportMax: number
  /**
   * One semaphore per nesting depth: a child holds its slot while it waits for its own children,
   * so a single shared cap could be filled by waiting parents and starve their children.
   */
  semaphoreFor(depth: number): Semaphore
  childIdOf(parentId: string, toolCallId: string): string
  /** Session options that hand the root's directory to a child session (no module-level state). */
  directoryOptions(dir: AgentDirectory | undefined): { runtime?: Record<string, unknown> }
  /** `childSession` options of an open (never `parent`), merged over `base`. */
  childOptions(info: SubagentChildInfo, base?: SessionOptions): SessionOptions
  /** Options to open the child of a directory entry. */
  entryOptions(entry: AgentEntry, base?: SessionOptions): SessionOptions
  /** Options to open a parent / root session (`parentSession`). */
  parentOptions(sessionId: string): SessionOptions
  /** Storage override of `parentSession` for a read handle. */
  parentPeek(sessionId: string): Pick<SessionOptions, 'storage'>
  /** Read handle of a child (storage override of `childSession`, nothing else is needed). */
  peekOf(agent: AnyAgent, id: string, info: SubagentChildInfo): SessionPeek
  /** Does this `agent` call run in the background (`run_in_background`, `background.default`)? */
  isBackgroundCall(input: Partial<AgentInput>, canBackground: boolean): boolean
}

/** Everything one session's plugin instance needs to start, address and resume children. */
export interface Scope {
  env: Env
  ctx: Ctx
  registry: SubagentTaskRegistry
  dir: AgentDirectory | undefined
  depth: number
  defs(): Record<string, SubagentDefinition>
  rebuilt: boolean
  isRoot: boolean
  /** `'park'`: when the directory was last rebuilt from storage (epoch ms). */
  rebuiltAt: number
  /** `'park'`: this session's name as its launcher gave it (read once from the parent). */
  selfName?: Promise<string | undefined>
  /** `maxChildren`: ids of the children this session object started. */
  spawned?: Set<string>
  /** Start a new turn on a finished child (ADR-0038); resolves to the text for the sender. */
  resume(entry: AgentEntry, text: string, sender: AgentSender): Promise<string>
}

const nameOf = (v: boolean | { name?: string } | undefined, fallback: string): string =>
  typeof v === 'object' && v.name !== undefined ? v.name : fallback

/** Validate and resolve the options of `subagent()`. */
export function createEnv(options: SubagentOptions): Env {
  if (options.approvals === 'inline' && options.answer === undefined) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      "subagent({ approvals: 'inline' }) needs an `answer` callback.",
    )
  }
  const backgroundOn = options.background === true || typeof options.background === 'object'
  const messaging = options.messageTool !== false
  const maxConcurrent = options.maxConcurrent ?? 8
  const park = options.approvals === 'park'
  const semaphores = new Map<number, Semaphore>()
  const env: Env = {
    options,
    toolName: options.toolName ?? AGENT_TOOL,
    maxDepth: options.maxDepth ?? 2,
    maxConcurrent,
    park,
    backgroundOn,
    backgroundDefault:
      typeof options.background === 'object' && options.background.default === true,
    backgroundInChildren:
      typeof options.background === 'object' && options.background.inChildren === true,
    messaging,
    messageToolName: nameOf(options.messageTool, SEND_MESSAGE_TOOL),
    limits: resolveLimits(options.messageLimits),
    outputEnabled:
      options.outputTool !== false &&
      (options.outputTool !== undefined || backgroundOn || messaging),
    outputToolName: nameOf(options.outputTool, AGENT_OUTPUT_TOOL),
    stopEnabled:
      options.stopTool !== false && (options.stopTool !== undefined || backgroundOn || messaging),
    stopToolName: nameOf(options.stopTool, AGENT_STOP_TOOL),
    reportMax: Math.max(1, options.maxReportChars ?? AGENT_REPORT_MAX_CHARS),
    semaphoreFor(depth) {
      let s = semaphores.get(depth)
      if (s === undefined) {
        s = createSemaphore(maxConcurrent)
        semaphores.set(depth, s)
      }
      return s
    },
    childIdOf: (parentId, toolCallId) =>
      options.childSessionId?.(parentId, toolCallId) ?? `${parentId}:agent:${toolCallId}`,
    directoryOptions(dir) {
      if (dir === undefined || park) return {}
      return { runtime: { [DIRECTORY_RUNTIME_KEY]: dir } }
    },
    childOptions(info, base = {}) {
      const extra = options.childSession?.(info)
      if (extra === undefined) return base
      const { parent: _ignored, ...rest } = extra as SessionOptions
      return {
        ...rest,
        ...base,
        ...(rest.runtime === undefined && base.runtime === undefined
          ? {}
          : { runtime: { ...rest.runtime, ...base.runtime } }),
      }
    },
    entryOptions: (entry, base = {}) =>
      env.childOptions(
        {
          parentSessionId: entry.parentInfo.sessionId,
          agent: entry.agent,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          depth: entry.parentInfo.depth,
        },
        base,
      ),
    parentOptions: (sessionId) => options.parentSession?.(sessionId) ?? {},
    parentPeek(sessionId) {
      const storage = env.parentOptions(sessionId).storage
      return storage === undefined ? {} : { storage }
    },
    peekOf(agent, id, info) {
      const storage = env.childOptions(info).storage
      return agent.peek(id, storage === undefined ? {} : { storage }) as unknown as SessionPeek
    },
    isBackgroundCall: (input, canBackground) =>
      backgroundOn && canBackground && (input.run_in_background ?? env.backgroundDefault),
  }
  return env
}

/**
 * `'park'` background children: running children of this session counted from the stored child
 * index (an approximation across instances: no shared counter exists). `undefined` to go on, or
 * the refusal text.
 */
export async function claimSlot(scope: Scope): Promise<string | undefined> {
  const { env, ctx } = scope
  const { options, maxConcurrent } = env
  if (options.selfAgent === undefined) return undefined
  try {
    const self = options.selfAgent().peek(ctx.session.id, env.parentOptions(ctx.session.id))
    const children = await self.children()
    if (children.length < maxConcurrent) return undefined
    const defs = scope.defs()
    let running = 0
    for (const info of children.slice(-100)) {
      const def = defs[info.agent ?? ''] ?? Object.values(defs)[0]
      if (def === undefined) continue
      const stats = await env
        .peekOf(def.agent, info.sessionId, {
          parentSessionId: ctx.session.id,
          agent: info.agent ?? '',
          depth: scope.depth + 1,
        })
        .stats()
      if (stats.activeTurn !== null || stats.pending !== null) running++
    }
    if (running >= maxConcurrent) {
      return `ERROR: ${running} background subagents are already running (limit ${maxConcurrent}). Wait for a report, or stop one${env.stopEnabled ? ` with ${env.stopToolName}` : ''}, then start this one again.`
    }
  } catch (error) {
    ctx.log.warn('subagent: could not count the running children', { error: errorText(error) })
  }
  return undefined
}

/** Spawn cap (`maxChildren`): `undefined` to go on, or the refusal text. */
export async function claimSpawn(
  scope: Scope,
  childSessionId: string,
): Promise<string | undefined> {
  const { env } = scope
  const { options } = env
  const max = options.maxChildren
  if (max === undefined) return undefined
  const mine = scope.spawned ?? new Set<string>()
  scope.spawned = mine
  if (mine.has(childSessionId)) return undefined
  const known = new Set(mine)
  if (env.park && options.selfAgent !== undefined) {
    try {
      const stored = await options
        .selfAgent()
        .peek(scope.ctx.session.id, env.parentOptions(scope.ctx.session.id))
        .children()
      for (const c of stored) known.add(c.sessionId)
    } catch (error) {
      scope.ctx.log.warn('subagent: could not read the child index', { error: errorText(error) })
    }
  }
  if (known.has(childSessionId)) return undefined
  if (known.size >= max) {
    return `ERROR: this session already started ${known.size} subagents and may not start more (limit ${max}). Continue the work yourself, or message an existing agent.`
  }
  mine.add(childSessionId)
  return undefined
}
