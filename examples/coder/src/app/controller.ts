/**
 * The application controller: wires workspace, shell, permissions, agents and storage behind the
 * {@link CoderController} contract that the Ink UI and print mode consume.
 */
import type { LanguageModel } from 'ai'
import type { HarnessSession, TurnResult } from 'eharness'
import { driveTurn, loadAgentDefinitions } from '../agents/index.ts'
import type {
  AgentDefinition,
  ApprovalBroker,
  CoderConfig,
  CoderController,
  CoderMessage,
  RunHooks,
  SessionSummary,
  ToolCallInfo,
} from '../contracts.ts'
import { createBroker, createPermissionEngine, describeApproval } from '../permissions/index.ts'
import { createLocalSandbox } from '../shell/index.ts'
import { createWorkspace } from '../workspace/index.ts'
import { type Agents, createAgents } from './agent.ts'
import { createStorage, latestSessionId, listSessions, newSessionId } from './sessions.ts'

/** Options of {@link createController}. */
export interface CreateControllerOptions {
  config: CoderConfig & { warnings?: string[] }
  /** Model override (offline tests); a later `setModel()` replaces it. */
  model?: LanguageModel
  /** Default: an interactive broker. Print mode passes `createDenyingBroker()`. */
  broker?: ApprovalBroker
  /** Start on this session id (wins over `config.resume` and `config.continueLast`). */
  sessionId?: string
}

/**
 * Build the controller. `config.resume === true` (picker) is resolved by the UI: until then a
 * fresh session id is used.
 */
export async function createController(opts: CreateControllerOptions): Promise<CoderController> {
  // mutable copy: `setModel` changes `model`
  const config: CoderConfig = { ...opts.config }
  const workspace = await createWorkspace(config)
  const sandbox = createLocalSandbox(config.root)
  const permissions = createPermissionEngine({ config, mounts: () => workspace.mounts() })
  const broker = opts.broker ?? createBroker()
  const describe = (call: ToolCallInfo) => describeApproval(call, workspace.fs, permissions)
  const storage = createStorage(config)
  const { definitions, warnings } = await loadAgentDefinitions({
    root: config.root,
    userDir: config.userDir,
    cliAgents: config.cliAgents,
  })

  // invalid agent files: reported next to the config warnings
  opts.config.warnings?.push(...warnings)

  let modelOverride = opts.model
  const makeAgents = (): Promise<Agents> =>
    createAgents({
      config,
      workspace,
      sandbox,
      permissions,
      broker,
      describe,
      definitions,
      storage,
      model: modelOverride,
    })
  // a promise: `setModel` is synchronous but rebuilding reads the project memory file
  let agentsReady: Promise<Agents> = makeAgents()
  await agentsReady

  let sessionId: string =
    opts.sessionId ??
    (typeof config.resume === 'string' ? config.resume : undefined) ??
    (config.continueLast ? await latestSessionId(config) : undefined) ??
    newSessionId()

  let controller: AbortController | undefined

  const session = async (): Promise<HarnessSession<CoderMessage>> =>
    (await agentsReady).main.session(sessionId) as unknown as HarnessSession<CoderMessage>

  return {
    config,
    permissions,
    broker,
    workspace,
    get sessionId(): string {
      return sessionId
    },

    async run(text: string, hooks: RunHooks): Promise<TurnResult<CoderMessage>> {
      const active = new AbortController()
      controller = active
      const s = await session()
      try {
        return await driveTurn(s.send(text, { abortSignal: active.signal }), {
          session: s,
          broker,
          permissions,
          describe,
          signal: active.signal,
          onRun: hooks.onRun,
        })
      } finally {
        if (controller === active) controller = undefined
      }
    },

    abort(): void {
      controller?.abort()
      void session().then((s) => s.abort())
    },

    messages: async () => (await session()).messages(),

    async compact(): Promise<void> {
      await (await session()).compact()
    },

    async clear(): Promise<void> {
      sessionId = newSessionId()
    },

    async resume(id: string): Promise<void> {
      sessionId = id
    },

    sessions: (): Promise<SessionSummary[]> => listSessions(config),

    /**
     * Rebuilds the agents with the new model (the simplest correct way: respond() continuations
     * and subagents use the agent default too, so a per-send option would not cover them). Call
     * it while idle; the session itself lives in storage and is reopened on the new agent.
     */
    setModel(model: string): void {
      config.model = model
      modelOverride = undefined
      const old = agentsReady
      agentsReady = makeAgents()
      void old.then((previous) => previous.closeAll())
    },

    agents: (): AgentDefinition[] => definitions,

    async stats() {
      const s = await (await session()).stats()
      const state = await storage.state.get(sessionId)
      const costUsd = state?.core.usage?.costUsd
      return {
        contextTokens: s.tokens,
        contextWindow: s.window,
        ...(costUsd !== undefined ? { costUsd } : {}),
      }
    },

    async close(): Promise<void> {
      controller?.abort()
      await (await agentsReady).closeAll()
    },
  }
}
