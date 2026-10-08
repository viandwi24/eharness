/**
 * Builds the main `HarnessAgent` and the subagent agents from the configuration
 * (docs/plans/P30-coder-example.md §3, §6, §7).
 *
 * Tool placement (decided here, it fixes the prompt-cache prefix):
 *
 * - `bash` and `glob` need the app data part `bashOutput` (UI part type `data-bashOutput`). A
 *   plugin's data parts are namespaced (`data-<plugin>.bashOutput`), so the part is registered on
 *   the agent config (`dataParts`) and the app tools sit in the agent `tools` config, which is
 *   also what types `ctx.stream.data('bashOutput', …)`.
 * - Tool order is `[root config tools] → [plugins in order]` (spec 02 §6): `glob`, `bash`,
 *   `agent` (depth permitting), `request_directory_access` (main only), then the `filesystem()`
 *   tools, `todo_write`, MCP tools (source tools, always after static tools) and last the
 *   permissions plugin's `exit_plan_mode`. The order is identical for every session and turn of
 *   an agent, which is what the cache prefix needs; it differs slightly from `TOOL_ORDER` in
 *   contracts.ts, which the core cannot express (it has no per-agent `toolOrder` option).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessWarning,
  type MessageAdapter,
  type StateAdapter,
} from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { mcpServer } from 'eharness/mcp'
import { todos } from 'eharness/todos'
import { createAgentTool } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type CoderConfig,
  type PermissionEngine,
  READ_ONLY_TOOLS,
  type Sandbox,
  TOOL,
  type ToolCallInfo,
  type Workspace,
} from '../contracts.ts'
import { permissionsPlugin } from '../permissions/index.ts'
import { bashOutputPart, createBashTool } from '../shell/index.ts'
import { createDirAccessTool, createGlobTool } from '../workspace/index.ts'
import { loadProjectMemory } from './project-memory.ts'
import {
  projectInstructions,
  STATIC_INSTRUCTIONS,
  subagentInstructions,
  turnReminder,
} from './prompt.ts'

/** Dependencies of {@link createAgents}. */
export interface CreateAgentsDeps {
  config: CoderConfig
  workspace: Workspace
  sandbox: Sandbox
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
  /** Model override for offline tests; wins over `config.model` and every definition. */
  model?: LanguageModel
  onWarning?: (warning: HarnessWarning) => void
}

/** The agents of one app instance. */
export interface Agents {
  main: HarnessAgent
  /** Agent for a subagent definition at nesting depth `depth` (cached by `name:depth`). */
  agentFor(def: AgentDefinition, depth: number): HarnessAgent
  closeAll(): Promise<void>
}

const NON_READ_ONLY_TOOLS: string[] = Object.values(TOOL).filter(
  (name) => !READ_ONLY_TOOLS.includes(name),
)

/**
 * Create the main agent and the subagent factory.
 *
 * Subagent `permissionMode` is deliberately weak: the permission engine has one global mode, so a
 * definition can only make its agent stricter. `plan` removes every non-read-only tool from that
 * agent (added to its `disallowedTools`); any other value is ignored. Subagents never get
 * `exit_plan_mode` (plan approval is the main agent's job) nor `request_directory_access`.
 */
export async function createAgents(deps: CreateAgentsDeps): Promise<Agents> {
  const { config, workspace, permissions } = deps
  const memory = await loadProjectMemory(config.root)
  const projectText = projectInstructions(memory)
  const hasSkills = existsSync(join(config.root, '.coder', 'skills'))
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

  const cache = new Map<string, HarnessAgent>()
  const built: HarnessAgent[] = []

  const toolDeps = {
    definitions: () => deps.definitions,
    agentFor: (def: AgentDefinition, depth: number): HarnessAgent => agentFor(def, depth),
    broker: deps.broker,
    permissions: deps.permissions,
    describe: deps.describe,
  }

  const warnMcp = (message: string): void => {
    deps.onWarning?.({ code: 'W_TOOL_SOURCE_FAILED', message } as HarnessWarning)
  }

  const build = (def: AgentDefinition | undefined, depth: number): HarnessAgent => {
    const isMain = def === undefined
    const instructions = isMain
      ? [STATIC_INSTRUCTIONS, ...(projectText ? [projectText] : []), reminder]
      : [
          subagentInstructions(def),
          ...(projectText && !def.omitProjectMemory ? [projectText] : []),
          reminder,
        ]

    // typed loosely: the tools mix plain tools and tool factories
    const appTools: Record<string, unknown> = {
      [TOOL.glob]: createGlobTool(workspace),
      [TOOL.bash]: createBashTool({ sandbox: deps.sandbox }),
    }
    if (depth < config.maxAgentDepth) appTools[TOOL.agent] = createAgentTool(toolDeps, depth)
    if (isMain) appTools[TOOL.dirAccess] = createDirAccessTool(workspace)

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

    const model: LanguageModel =
      deps.model ?? (def?.model && def.model !== 'inherit' ? def.model : config.model)

    const agent = defineHarnessAgent({
      id: isMain ? 'coder' : `coder-${def.name}-${depth}`,
      model,
      contextWindow: config.contextWindow,
      instructions,
      dataParts: { bashOutput: bashOutputPart },
      tools: appTools as never,
      mcp,
      plugins: [
        filesystem({
          fs: workspace.fs,
          toolOutputs: { dir: '/.coder/tool-outputs' },
          ...(hasSkills ? { skills: { root: '/.coder/skills' } } : {}),
        }),
        todos(),
        permissionsPlugin({
          engine: permissions,
          ...(def ? { agent: def.name } : {}),
          ...(def?.tools ? { allowedTools: def.tools } : {}),
          ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
          auditFile,
        }),
      ],
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
    closeAll: async () => {
      await Promise.allSettled(built.map((a) => a.close()))
    },
  }
}
