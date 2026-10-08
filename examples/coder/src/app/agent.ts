/**
 * Builds the main `HarnessAgent` and the subagent agents from the configuration
 * (docs/plans/P30-coder-example.md §3, §6, §7).
 *
 * Tool placement (decided here, it fixes the prompt-cache prefix):
 *
 * - `bash` needs the app data part `bashOutput` (UI part type `data-bashOutput`). A
 *   plugin's data parts are namespaced (`data-<plugin>.bashOutput`), so the part is registered on
 *   the agent config (`dataParts`) and the app tools sit in the agent `tools` config, which is
 *   also what types `ctx.stream.data('bashOutput', …)`.
 * - Tool order is `[root config tools] → [plugins in order]` (spec 02 §6): `bash`,
 *   `agent` (depth permitting), `request_directory_access` (main only), then the `filesystem()`
 *   tools, `todo_write`, MCP tools (source tools, always after static tools) and last the
 *   permissions plugin's `exit_plan_mode`. The order is identical for every session and turn of
 *   an agent, which is what the cache prefix needs; it differs slightly from `TOOL_ORDER` in
 *   contracts.ts, which the core cannot express (it has no per-agent `toolOrder` option).
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LanguageModel, Tool } from 'ai'
import {
  defineHarnessAgent,
  type definePlugin,
  type HarnessAgent,
  type HarnessRun,
  type HarnessWarning,
  lookupModel,
  type MessageAdapter,
  type ModelCatalog,
  type StateAdapter,
} from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { mcpServer } from 'eharness/mcp'
import { todos } from 'eharness/todos'
import { createAgentTool, createAskTool } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type CoderConfig,
  type CoderMessage,
  type PermissionEngine,
  READ_ONLY_TOOLS,
  type Sandbox,
  TOOL,
  type ToolCallInfo,
  type Workspace,
} from '../contracts.ts'
import type { LspManager } from '../lsp/index.ts'
import { createLspTools } from '../lsp/index.ts'
import {
  domainSpecifierMatches,
  parseRule,
  permissionsPlugin,
  ruleToolMatches,
} from '../permissions/index.ts'
import { bashOutputPart, createBashTool, type LocalSandbox } from '../shell/index.ts'
import { createDirAccessTool } from '../workspace/index.ts'
import { createBackgroundBashTools, withBackgroundOption } from './background-bash.ts'
import { type ModelState, modelSwitchPlugin } from './model-switch.ts'
import { loadProjectMemory } from './project-memory.ts'
import {
  projectInstructions,
  STATIC_INSTRUCTIONS,
  subagentInstructions,
  turnReminder,
} from './prompt.ts'
import type { TaskInject, TaskManager } from './tasks.ts'
import { buildTools, estimateTokens, estimateTool, pluginStaticTools } from './tool-inventory.ts'
import {
  createWebFetchTool,
  createWebSearchTool,
  type SearchFn,
  type WebFetchDeps,
} from './web-tools.ts'

/** Dependencies of {@link createAgents}. */
export interface CreateAgentsDeps {
  config: CoderConfig
  workspace: Workspace
  sandbox: Sandbox | LocalSandbox
  permissions: PermissionEngine
  broker: ApprovalBroker
  /** Title/detail/suggested rule of a tool call, for approval prompts. */
  describe: (
    call: ToolCallInfo,
  ) => Promise<{ title: string; detail?: string; suggestedRule?: string }>
  /** Subagent definitions (built-in, project, user, CLI). */
  definitions: AgentDefinition[]
  /** Storage shared by the main agent and every child. */
  storage: { messages: MessageAdapter; state: StateAdapter }
  /** Model override for offline tests; wins over the model state and every definition. */
  model?: LanguageModel
  /**
   * The current model and thinking level, shared with the controller (default: from `config`).
   * Every agent reads it at the start of each turn (`app/model-switch.ts`).
   */
  modelState?: ModelState
  /** Model id → model (default: the id itself, resolved by the AI Gateway). */
  resolveModel?: (id: string) => LanguageModel
  /** models.dev (or custom) catalog: context window and cost of the models it lists. */
  models?: ModelCatalog
  /** `config.contextWindow` was set in a settings file: it then beats the catalog. */
  contextWindowExplicit?: boolean
  /** Web search of the `web_search` tool; absent = `ERROR: web search is not available`. */
  search?: SearchFn
  /** Overrides of `web_fetch` internals (tests): `fetch`, host resolution, timeout. */
  webFetch?: Partial<Pick<WebFetchDeps, 'fetch' | 'resolve' | 'timeoutMs'>>
  /** Cap of concurrent subagents per nesting depth (default 8). */
  maxConcurrentAgents?: number
  /**
   * Plugins added to EVERY agent, after the permissions plugin (checkpoints, settings hooks).
   * They must not add tools: tool order is the prompt-cache prefix. Called once per agent built.
   */
  extraPlugins?: (agent: { main: boolean }) => Array<ReturnType<typeof definePlugin>>
  /** Plugins of the MAIN agent only (compact focus). */
  mainPlugins?: Array<ReturnType<typeof definePlugin>>
  /** User memory text (`~/.coder/AGENTS.md`), a SESSION instruction after the project memory. */
  userMemory?: () => Promise<string | undefined>
  /**
   * Text of the active output style, a SESSION instruction of the main agent. Evaluated when the
   * session opens: the controller closes the session handle after a style change so the next turn
   * re-evaluates it (the prompt cache is rebuilt from that block on).
   */
  outputStyle?: () => Promise<string | undefined>
  /** Background tasks: `bash` gets `run_in_background`, `bash_output`/`kill_shell` are added, `agent` can run in background. */
  background?: {
    tasks: TaskManager
    inject: TaskInject
    onWake: (run: HarnessRun<CoderMessage>) => void
  }
  /** `lsp` tool for every agent when the manager has a server. */
  lsp?: LspManager
  onWarning?: (warning: HarnessWarning) => void
}

/** The agents of one app instance. */
export interface Agents {
  main: HarnessAgent
  /** Agent for a subagent definition at nesting depth `depth` (cached by `name:depth`). */
  agentFor(def: AgentDefinition, depth: number): HarnessAgent
  /** Sizes of what the main agent puts into its context besides messages (for `/context`). */
  contextInfo(): Promise<AgentContextInfo>
  closeAll(): Promise<void>
}

/** Estimated context contributions of the main agent. */
export interface AgentContextInfo {
  /** Static tool definitions (own tools and the static tools of plugins), by size. */
  tools: Array<{ name: string; tokens: number }>
  /** Project memory text in the instructions. */
  memoryTokens: number
  memoryFiles: Array<{ path: string; tokens: number }>
  /** Skill index in the instructions. */
  skillsTokens: number
  skillCount: number
  /** Whether the main agent has MCP servers configured. */
  hasMcp: boolean
}

/** Frontmatter `name` and `description` of the skills under `<root>/.coder/skills`. */
async function skillIndexTokens(root: string): Promise<{ tokens: number; count: number }> {
  let tokens = 0
  let count = 0
  try {
    const base = join(root, '.coder', 'skills')
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const text = await readFile(join(base, entry.name, 'SKILL.md'), 'utf8')
        const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
        tokens += estimateTokens(`${entry.name}\n${front}`) + 4
        count++
      } catch {
        // not a skill
      }
    }
  } catch {
    // no skills directory
  }
  return { tokens, count }
}

type LooseTool = { description?: string } & Record<string, unknown>

/**
 * Append whether bash is sandboxed to the tool description. The description is resolved when a
 * session opens, so a live `sandbox.enabled` toggle reaches the model at the next session open
 * (the controller reopens the session handle after the toggle).
 */
function withSandboxNote(base: unknown, sandbox: Sandbox | LocalSandbox): unknown {
  const state = (sandbox as Partial<LocalSandbox>).sandboxState?.bind(sandbox)
  if (state === undefined) return base
  return (ctx: unknown): unknown => {
    const inner = (
      typeof base === 'function' ? (base as (c: unknown) => unknown)(ctx) : base
    ) as LooseTool
    const s = state()
    const note = s.enabled
      ? `\n\nSandbox: ON (${s.kind}). Commands can write only inside the project, the extra directories and temp dirs; network access is ${s.network ? 'allowed' : 'blocked'}. "Operation not permitted" / "Read-only file system" errors usually come from the sandbox: do not retry them, tell the user.`
      : '\n\nSandbox: off. Commands run with the full privileges of the user.'
    return { ...inner, description: `${inner.description ?? ''}${note}` }
  }
}

/** Removed from `plan` subagents; `bash` stays, its commands are restricted to read-only ones. */
const NON_READ_ONLY_TOOLS: string[] = Object.values(TOOL).filter(
  (name) =>
    !READ_ONLY_TOOLS.includes(name) &&
    name !== TOOL.bash &&
    name !== TOOL.webFetch &&
    name !== TOOL.webSearch,
)

/** Does an allow rule name this host (`WebFetch(domain:host)`)? Only then private hosts are fetched. */
function hostAllowedBy(permissions: PermissionEngine, host: string): boolean {
  return permissions.rules().allow.some((raw) => {
    const rule = parseRule(raw)
    return (
      rule?.specifier !== undefined &&
      ruleToolMatches(rule.tool, TOOL.webFetch) &&
      domainSpecifierMatches(rule.specifier, host)
    )
  })
}

/**
 * Create the main agent and the subagent factory.
 *
 * Subagent `permissionMode` is deliberately weak: the permission engine has one global mode, so a
 * definition can only make its agent stricter. `plan` removes every non-read-only tool from that
 * agent (added to its `disallowedTools`) and runs its bash read-only whatever the session's mode
 * is (a per-agent `mode: 'plan'` on its permissions plugin); any other value is ignored. Subagents never get
 * `exit_plan_mode` (plan approval is the main agent's job) nor `request_directory_access`.
 */
export async function createAgents(deps: CreateAgentsDeps): Promise<Agents> {
  const { config, workspace, permissions } = deps
  const memory = await loadProjectMemory(config.root)
  const projectText = projectInstructions(memory)
  // project skills are repo content: only loaded once the project is trusted
  const hasSkills = config.trusted && existsSync(join(config.root, '.coder', 'skills'))
  const auditFile = join(config.projectDataDir, 'audit.jsonl')
  const reminder = {
    text: turnReminder({
      root: config.root,
      mode: () => permissions.mode,
      extraDirs: () =>
        workspace
          .mounts()
          .filter((m) => m.virtual.startsWith('/@dirs/'))
          .map((m) => `${m.virtual} (${m.real})`),
    }),
    refresh: 'turn' as const,
  }

  const modelState: ModelState = deps.modelState ?? {
    provider: config.provider,
    model: config.model,
    thinking: 'provider-default',
  }
  const resolveModel = deps.resolveModel ?? ((id: string): LanguageModel => id)
  const contextInfo: { tools: Record<string, unknown>; plugins: unknown[] } = {
    tools: {},
    plugins: [],
  }

  const cache = new Map<string, HarnessAgent>()
  const built: HarnessAgent[] = []

  const toolDeps = {
    definitions: () => deps.definitions,
    agentFor: (def: AgentDefinition, depth: number): HarnessAgent => agentFor(def, depth),
    broker: deps.broker,
    permissions: deps.permissions,
    describe: deps.describe,
    ...(deps.maxConcurrentAgents !== undefined ? { maxConcurrent: deps.maxConcurrentAgents } : {}),
    ...(deps.background
      ? {
          tasks: deps.background.tasks,
          inject: deps.background.inject,
          onWake: deps.background.onWake,
        }
      : {}),
  }

  const warnMcp = (message: string): void => {
    deps.onWarning?.({ code: 'W_TOOL_SOURCE_FAILED', message } as HarnessWarning)
  }

  const build = (def: AgentDefinition | undefined, depth: number): HarnessAgent => {
    const isMain = def === undefined
    // Order = prompt order. Strings are the static block; functions are SESSION instructions
    // (block 2, evaluated at the first turn of a session, then cached): user memory, then the
    // output style. The turn reminder is the only per-turn text.
    const userMemory = deps.userMemory
    const userMemoryText = userMemory
      ? (): Promise<string | undefined> =>
          userMemory().then((text) =>
            text === undefined
              ? undefined
              : `# User instructions (~/.coder/AGENTS.md)\n\nThe user wrote these personal instructions for every project. Follow them.\n\n${text.trim()}`,
          )
      : undefined
    const instructions = isMain
      ? [
          STATIC_INSTRUCTIONS,
          ...(projectText ? [projectText] : []),
          ...(userMemoryText ? [userMemoryText] : []),
          ...(deps.outputStyle ? [deps.outputStyle] : []),
          reminder,
        ]
      : [
          subagentInstructions(def),
          ...(projectText && !def.omitProjectMemory ? [projectText] : []),
          ...(userMemoryText && !def.omitProjectMemory ? [userMemoryText] : []),
          reminder,
        ]

    // typed loosely: the tools mix plain tools and tool factories
    const bash = withSandboxNote(createBashTool({ sandbox: deps.sandbox }), deps.sandbox)
    const appTools: Record<string, unknown> = {
      [TOOL.bash]: deps.background
        ? withBackgroundOption(bash as never, { sandbox: deps.sandbox, ...deps.background })
        : bash,
      [TOOL.webFetch]: createWebFetchTool({
        isHostAllowed: (host) => hostAllowedBy(permissions, host),
        ...deps.webFetch,
      }),
      [TOOL.webSearch]: createWebSearchTool({ ...(deps.search ? { search: deps.search } : {}) }),
    }
    if (deps.lsp?.available) Object.assign(appTools, createLspTools(deps.lsp))
    if (deps.background) {
      // not model-visible for agents whose `tools` allowlist omits them (read-only subagents)
      Object.assign(
        appTools,
        createBackgroundBashTools({ sandbox: deps.sandbox, ...deps.background }).tools,
      )
    }
    if (depth < config.maxAgentDepth) appTools[TOOL.agent] = createAgentTool(toolDeps, depth)
    if (isMain) {
      appTools[TOOL.dirAccess] = createDirAccessTool(workspace)
      appTools[TOOL.ask] = createAskTool()
    }

    const disallowed = [...(def?.disallowedTools ?? [])]
    if (def !== undefined) {
      disallowed.push(TOOL.exitPlan)
      if (def.permissionMode === 'plan') disallowed.push(...NON_READ_ONLY_TOOLS)
    }

    const mcp = isMain
      ? Object.entries(config.mcpServers).flatMap(([name, transport]) => {
          try {
            return [mcpServer({ name, transport: transport as never })]
          } catch (error) {
            warnMcp(
              `Skipping MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
            )
            return []
          }
        })
      : []

    // a subagent that pins a model keeps it; everything else follows the model state per turn
    const pinned = def?.model && def.model !== 'inherit' ? def.model : undefined
    const follows = deps.model === undefined && pinned === undefined
    const model: LanguageModel = deps.model ?? resolveModel(pinned ?? modelState.model)

    const plugins = [
      filesystem({
        fs: workspace.fs,
        toolOutputs: { dir: '/.coder/tool-outputs' },
        ...(hasSkills ? { skills: { root: '/.coder/skills' } } : {}),
      }),
      todos(),
      permissionsPlugin({
        engine: permissions,
        ...(def ? { agent: def.name } : {}),
        ...(def?.permissionMode === 'plan' ? { mode: 'plan' as const } : {}),
        ...(def?.tools ? { allowedTools: def.tools } : {}),
        ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
        auditFile,
      }),
      modelSwitchPlugin({ state: modelState, ...(follows ? { resolve: resolveModel } : {}) }),
      ...(deps.extraPlugins?.({ main: isMain }) ?? []),
      ...(isMain ? (deps.mainPlugins ?? []) : []),
    ]
    if (isMain) {
      contextInfo.tools = appTools
      contextInfo.plugins = plugins
    }

    const agent = defineHarnessAgent({
      id: isMain ? 'coder' : `coder-${def.name}-${depth}`,
      model,
      // an explicit setting wins; otherwise the catalog, with the config default as fallback
      contextWindow: deps.contextWindowExplicit
        ? config.contextWindow
        : (m: LanguageModel) =>
            lookupModel(deps.models, follows ? modelState.model : m)?.contextWindow ??
            config.contextWindow,
      ...(deps.models ? { models: deps.models } : {}),
      instructions,
      dataParts: { bashOutput: bashOutputPart },
      // pasted images arrive as data: URLs only, at most 5 MB each (never fetched URLs)
      ...(isMain ? { inputFiles: { protocols: ['data:'], maxBytes: 5 * 1024 * 1024 } } : {}),
      tools: appTools as never,
      mcp,
      plugins,
      storage: deps.storage,
      loop: { maxSteps: isMain ? config.maxSteps : (def.maxTurns ?? 50) },
      compaction: { summarizeAt: 0.8, prune: {} },
      toolOutput: { maxChars: 30_000, strategy: 'evict' },
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    }) as unknown as HarnessAgent
    built.push(agent)
    return agent
  }

  const agentFor = (def: AgentDefinition, depth: number): HarnessAgent => {
    const key = `${def.name}:${depth}`
    let agent = cache.get(key)
    if (agent === undefined) {
      agent = build(def, depth)
      cache.set(key, agent)
    }
    return agent
  }

  const main = build(undefined, 0)
  return {
    main,
    agentFor,
    async contextInfo(): Promise<AgentContextInfo> {
      const tools: AgentContextInfo['tools'] = []
      const all: Record<string, Tool> = buildTools(contextInfo.tools)
      for (const plugin of contextInfo.plugins) Object.assign(all, await pluginStaticTools(plugin))
      for (const [name, tool] of Object.entries(all)) {
        if (typeof tool !== 'object' || tool === null) continue
        tools.push({ name, tokens: await estimateTool(name, tool) })
      }
      const skills = hasSkills ? await skillIndexTokens(config.root) : { tokens: 0, count: 0 }
      const userText = await deps.userMemory?.().catch(() => undefined)
      const memoryTokens = estimateTokens(projectText ?? '') + estimateTokens(userText ?? '')
      return {
        tools,
        memoryTokens,
        memoryFiles: [
          ...(memory.file !== undefined && memory.text !== undefined
            ? [{ path: `/${memory.file}`, tokens: estimateTokens(memory.text) }]
            : []),
          ...(userText !== undefined
            ? [{ path: '~/.coder/AGENTS.md', tokens: estimateTokens(userText) }]
            : []),
        ],
        skillsTokens: skills.tokens,
        skillCount: skills.count,
        hasMcp: Object.keys(config.mcpServers).length > 0,
      }
    },
    closeAll: async () => {
      await Promise.allSettled(built.map((a) => a.close()))
    },
  }
}
