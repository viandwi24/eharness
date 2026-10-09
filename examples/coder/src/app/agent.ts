/**
 * Builds the main `HarnessAgent` and the subagent agents from the configuration
 * (docs/plans/P30-coder-example.md §3, §6, §7).
 *
 * Every capability is a library plugin (`eharness/shell`, `subagent`, `filesystem`, `todos`,
 * `web`, `ask`, `permissions`, `mcp`); this file only decides which agent gets which plugin and
 * with what policy. Tool placement fixes the prompt-cache prefix: the order is
 * `[root config tools] → [plugins in order]` (spec 02 §6) and identical for every session and
 * turn of an agent: the app tools (`lsp`, `request_directory_access`), `bash` (+ `bash_output`,
 * `kill_shell` on the main agent), `agent`, the `filesystem()` tools, `todo_write`, `web_fetch`,
 * `web_search`, `ask_user_question` (main only), MCP tools (source tools, after the static ones)
 * and the permissions plugin's `exit_plan_mode` among the session tools.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  defineHarnessAgent,
  type definePlugin,
  type HarnessAgent,
  type HarnessWarning,
  lookupModel,
  type MessageAdapter,
  type ModelCatalog,
  type StateAdapter,
} from 'eharness'
import { askUser } from 'eharness/ask'
import {
  type CheckpointStore,
  filesystem,
  loadProjectInstructions,
  projectInstructions,
} from 'eharness/filesystem'
import { mcpServer } from 'eharness/mcp'
import { domainSpecifierMatches, parseRule, permissionsPlugin } from 'eharness/permissions'
import { type LocalSandbox, shell } from 'eharness/shell'
import { type SubagentDefinition, subagents } from 'eharness/subagent'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import { subagentAnswer } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type CoderConfig,
  READ_ONLY_TOOLS,
  TOOL,
  type ToolCallInfo,
  type Workspace,
} from '../contracts.ts'
import type { LspManager } from '../lsp/index.ts'
import { createLspTools } from '../lsp/index.ts'
import { auditLog, type CoderPermissionEngine } from '../permissions/index.ts'
import { createDirAccessTool } from '../workspace/index.ts'
import { PROJECT_INSTRUCTIONS_OPTIONS } from './memory-files.ts'
import { type ModelState, modelSwitchPlugin } from './model-switch.ts'
import { STATIC_INSTRUCTIONS, subagentInstructions, turnReminder } from './prompt.ts'
import type { TaskHub } from './tasks.ts'
import { htmlToMarkdown, resolveHost, type SearchFn } from './web-search.ts'

/** Dependencies of {@link createAgents}. */
export interface CreateAgentsDeps {
  config: CoderConfig
  workspace: Workspace
  sandbox: LocalSandbox
  permissions: CoderPermissionEngine
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
  /** Web search of the `web_search` tool; absent = `ERROR: web search failed: …not available`. */
  search?: SearchFn
  /** Overrides of `web_fetch` internals (tests): `fetch`, host resolution, timeout. */
  webFetch?: {
    fetch?: typeof fetch
    resolveHost?: (host: string) => Promise<string[]>
    timeoutMs?: number
  }
  /** File checkpoints (`/rewind`): every agent's `filesystem()` records into it. */
  checkpoints?: CheckpointStore
  /** Cap of concurrent subagents per nesting depth (default 8). */
  maxConcurrentAgents?: number
  /**
   * Plugins added to EVERY agent, after the permissions plugin (settings hooks).
   * They must not add tools: tool order is the prompt-cache prefix. Called once per agent built.
   */
  extraPlugins?: (agent: { main: boolean }) => Array<ReturnType<typeof definePlugin>>
  /** Plugins of the MAIN agent only (compact focus). */
  mainPlugins?: Array<ReturnType<typeof definePlugin>>
  /** User memory text (`~/.coder/AGENTS.md`), a SESSION instruction (the project memory is a static one). */
  userMemory?: () => Promise<{ name: string; text: string } | undefined>
  /**
   * Text of the active output style, a SESSION instruction of the main agent. Evaluated when the
   * session opens: the controller closes the session handle after a style change so the next turn
   * re-evaluates it (the prompt cache is rebuilt from that block on).
   */
  outputStyle?: () => Promise<string | undefined>
  /** Background tasks: the main agent's `bash` gets `run_in_background` and its `agent` tool too; the hub lists them. */
  taskHub?: TaskHub
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

/**
 * Memory text in the main agent's instructions. The core cannot tell the memory blocks from the
 * rest of the `app` instruction block, so `/context` subtracts this estimate from it.
 */
export interface AgentContextInfo {
  /** User memory text in the `app` instruction block (estimated). */
  memoryTokens: number
  /** Project memory text (owned by the `project-instructions` plugin; estimated). */
  projectMemoryTokens: number
  memoryFiles: Array<{ path: string; tokens: number }>
}

/** `ceil(chars / 4)`, the core's default counter. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Removed from `plan` subagents; `bash` stays, its commands are restricted to read-only ones. */
const NON_READ_ONLY_TOOLS: string[] = Object.values(TOOL).filter(
  (name) =>
    !READ_ONLY_TOOLS.includes(name) &&
    name !== TOOL.bash &&
    name !== TOOL.webFetch &&
    name !== TOOL.webSearch,
)

/**
 * Built-ins that are loaded on demand with `tool_search` when `deferTools` is on (the core tools
 * read/edit/bash/agent/todo/ask/skills stay loaded). Names an agent does not have are ignored.
 */
export const DEFERRED_BUILTIN_TOOLS: readonly string[] = [
  TOOL.webFetch,
  TOOL.webSearch,
  TOOL.lsp,
  'agent_output',
  'agent_stop',
  'bash_output',
  'kill_shell',
  TOOL.dirAccess,
]

/** Does an allow rule name this host (`WebFetch(domain:host)`)? Only then private hosts are fetched. */
function hostAllowedBy(permissions: CoderPermissionEngine, host: string): boolean {
  return permissions.rules().allow.some((raw) => {
    const rule = parseRule(raw)
    return (
      rule?.specifier !== undefined &&
      permissions.expandRuleTool(rule.tool).includes(TOOL.webFetch) &&
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

  const cache = new Map<string, HarnessAgent>()
  const built: HarnessAgent[] = []

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
          userMemory().then((memory) =>
            memory === undefined
              ? undefined
              : `# User instructions (~/.coder/${memory.name})\n\nThe user wrote these personal instructions for every project. Follow them.\n\n${memory.text.trim()}`,
          )
      : undefined
    const instructions = isMain
      ? [
          STATIC_INSTRUCTIONS,
          ...(userMemoryText ? [userMemoryText] : []),
          ...(deps.outputStyle ? [deps.outputStyle] : []),
          reminder,
        ]
      : [
          subagentInstructions(def),
          ...(userMemoryText && !def.omitProjectMemory ? [userMemoryText] : []),
          reminder,
        ]

    // typed loosely: the tools mix plain tools and tool factories
    const appTools: Record<string, unknown> = {}
    if (deps.lsp?.available) Object.assign(appTools, createLspTools(deps.lsp))
    if (isMain) appTools[TOOL.dirAccess] = createDirAccessTool(workspace)

    const disallowed = [...(def?.disallowedTools ?? [])]
    if (def !== undefined) {
      disallowed.push(TOOL.exitPlan)
      if (def.permissionMode === 'plan') disallowed.push(...NON_READ_ONLY_TOOLS)
    }

    // an allow list keeps `tool_search` when it allows a deferred tool, or the tool could never be loaded
    const withToolSearch = (tools: string[]): string[] =>
      config.deferTools &&
      tools.some((t) =>
        [...permissions.expandRuleTool(t)].some((name) => DEFERRED_BUILTIN_TOOLS.includes(name)),
      )
        ? [...tools, 'tool_search']
        : tools

    const mcp = isMain
      ? Object.entries(config.mcpServers).flatMap(([name, transport]) => {
          try {
            // a server entry may carry its own `defer`; the setting is the default
            const { defer, ...rest } =
              typeof transport === 'object' && transport !== null
                ? (transport as { defer?: unknown })
                : { defer: undefined }
            return [
              mcpServer({
                name,
                transport: (typeof transport === 'object' && transport !== null
                  ? rest
                  : transport) as never,
                defer: typeof defer === 'boolean' ? defer : config.deferTools,
              }),
            ]
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

    // every agent gets the same tools plugins; the main agent adds what only it needs
    const background = isMain && deps.taskHub !== undefined
    const search: SearchFn =
      deps.search ??
      (async () => {
        throw new Error('web search is not available')
      })
    const self: { agent?: HarnessAgent } = {}
    const plugins = [
      shell({
        sandbox: deps.sandbox,
        ...(background ? { background: true } : {}),
      }),
      // always installed: at `maxDepth` the plugin drops the `agent` tool and keeps `send_message`,
      // so even a leaf agent can report to `main` (ADR-0038)
      subagents({
        agents: () => subagentCatalog(depth),
        approvals: 'inline',
        answer: subagentAnswer({
          broker: deps.broker,
          permissions,
          describe: deps.describe,
        }),
        maxDepth: config.maxAgentDepth,
        ...(deps.maxConcurrentAgents !== undefined
          ? { maxConcurrent: deps.maxConcurrentAgents }
          : {}),
        // a child's own background reports would die with its session: main agent only
        ...(background
          ? { background: true, backgroundByDefault: config.print === undefined }
          : {}),
        // rebuilds agent names and finished agents when a stored session is reopened
        selfAgent: () => self.agent as HarnessAgent,
      }),
      // after `shell()` and `subagents()`: it reads their task services
      ...(isMain && deps.taskHub ? [deps.taskHub.plugin] : []),
      filesystem({
        fs: workspace.fs,
        ...(deps.checkpoints ? { checkpoints: deps.checkpoints } : {}),
        ...(hasSkills ? { skills: { root: '/.coder/skills' } } : {}),
      }),
      // right after `filesystem()` (it reads the `fs` service); a static instruction (block 1)
      ...(def?.omitProjectMemory === true
        ? []
        : [projectInstructions(PROJECT_INSTRUCTIONS_OPTIONS)]),
      todos(),
      webFetch({
        allow: (host) => hostAllowedBy(permissions, host),
        toMarkdown: htmlToMarkdown,
        resolveHost,
        ...deps.webFetch,
      }),
      webSearch({ search }),
      ...(isMain ? [askUser()] : []),
      permissionsPlugin({
        engine: permissions,
        ...(def?.permissionMode === 'plan' ? { mode: 'plan' as const } : {}),
        ...(def?.tools ? { allowedTools: withToolSearch(def.tools) } : {}),
        ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
        onDecision: auditLog(auditFile, def?.name),
      }),
      modelSwitchPlugin({ state: modelState, ...(follows ? { resolve: resolveModel } : {}) }),
      ...(deps.extraPlugins?.({ main: isMain }) ?? []),
      ...(isMain ? (deps.mainPlugins ?? []) : []),
    ]

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
      // pasted images arrive as data: URLs only, at most 5 MB each (never fetched URLs)
      ...(isMain ? { inputFiles: { protocols: ['data:'], maxBytes: 5 * 1024 * 1024 } } : {}),
      tools: appTools as never,
      // hidden until `tool_search` finds them; the core lists their names in the turn reminder
      ...(config.deferTools ? { deferTools: [...DEFERRED_BUILTIN_TOOLS] } : {}),
      mcp,
      plugins,
      storage: deps.storage,
      loop: { maxSteps: isMain ? config.maxSteps : (def.maxTurns ?? 50) },
      compaction: { summarizeAt: 0.8, prune: {} },
      toolOutput: { maxChars: 30_000, strategy: 'evict' },
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    }) as unknown as HarnessAgent
    self.agent = agent
    built.push(agent)
    return agent
  }

  /**
   * The subagent types an agent at `depth` can start. The agent of each type is built on first
   * use (a getter), so unused types cost nothing.
   */
  const subagentCatalog = (depth: number): Record<string, SubagentDefinition> =>
    Object.fromEntries(
      deps.definitions.map((def) => [
        def.name,
        {
          get agent(): HarnessAgent {
            return agentFor(def, depth + 1)
          },
          description: def.description,
          ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
          ...(def.resumable !== undefined ? { resumable: def.resumable } : {}),
        },
      ]),
    )

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
      const user = await deps.userMemory?.().catch(() => undefined)
      const project = (await loadProjectInstructions(workspace.fs, PROJECT_INSTRUCTIONS_OPTIONS))
        .root
      return {
        // the user memory sits in the `app` instruction block; the project file has its own owner
        memoryTokens: estimateTokens(user?.text ?? ''),
        projectMemoryTokens: estimateTokens(project?.content ?? ''),
        memoryFiles: [
          ...(project !== undefined
            ? [{ path: project.path, tokens: estimateTokens(project.content) }]
            : []),
          ...(user !== undefined
            ? [{ path: `~/.coder/${user.name}`, tokens: estimateTokens(user.text) }]
            : []),
        ],
      }
    },
    closeAll: async () => {
      await Promise.allSettled(built.map((a) => a.close()))
    },
  }
}
