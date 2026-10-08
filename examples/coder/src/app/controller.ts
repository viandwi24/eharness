/**
 * The application controller: wires workspace, shell, permissions, agents and storage behind the
 * {@link CoderController} contract that the Ink UI and print mode consume.
 */
import type { LanguageModel } from 'ai'
import type { HarnessSession, ModelCatalog, TurnResult } from 'eharness'
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
import { capOutput, createLocalSandbox } from '../shell/index.ts'
import { createWorkspace } from '../workspace/index.ts'
import { type Agents, createAgents } from './agent.ts'
import { loadModelCatalog } from './models.ts'
import { createStorage, latestSessionId, listSessions, newSessionId } from './sessions.ts'

/** Options of {@link createController}. */
export interface CreateControllerOptions {
  config: CoderConfig & { warnings?: string[]; contextWindowExplicit?: boolean }
  /** Model catalog override (tests). Default: the cached models.dev catalog (`app/models.ts`). */
  models?: ModelCatalog
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
    loadProject: config.trusted,
  })
  const catalog = opts.models ?? (await loadModelCatalog(config.userDir)).catalog

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
      ...(catalog ? { models: catalog } : {}),
      contextWindowExplicit: opts.config.contextWindowExplicit === true,
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

  /** Close the handle of a session we leave (never while its turn runs). */
  const closeSessionHandle = async (id: string): Promise<void> => {
    if (controller !== undefined) return
    await (await agentsReady).main.closeSession(id).catch(() => {})
  }

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

    async messagesOf(id: string): Promise<CoderMessage[]> {
      return (await storage.messages.load({ sessionId: id })) as CoderMessage[]
    },

    async compact(): Promise<void> {
      await (await session()).compact()
    },

    async clear(): Promise<void> {
      const old = sessionId
      sessionId = newSessionId()
      await closeSessionHandle(old)
    },

    async resume(id: string): Promise<void> {
      if (id.includes(':agent:')) throw new Error(`cannot resume a subagent session: ${id}`)
      if ((await storage.messages.load({ sessionId: id, limit: 1 })).length === 0)
        throw new Error(`unknown session: ${id}`)
      const old = sessionId
      sessionId = id
      if (old !== id) await closeSessionHandle(old)
    },

    sessions: (): Promise<SessionSummary[]> => listSessions(config),

    async shell(command: string, signal?: AbortSignal) {
      let proc: Awaited<ReturnType<typeof sandbox.spawn>>
      try {
        proc = await sandbox.spawn({ command })
      } catch (error) {
        return {
          output: `could not start the command: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: null,
        }
      }
      let aborted = false
      const onAbort = (): void => {
        aborted = true
        void proc.kill()
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      let output = ''
      const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const dec = new TextDecoder()
        try {
          for await (const bytes of stream) output += dec.decode(bytes, { stream: true })
          output += dec.decode()
        } catch {
          // stream torn down by a kill
        }
      }
      let exitCode: number | null = null
      try {
        const [, , result] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.wait()])
        exitCode = aborted ? null : result.exitCode
      } catch (error) {
        if (!aborted) output += `\n${error instanceof Error ? error.message : String(error)}`
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      return { output: capOutput(output.trimEnd(), 30_000), exitCode }
    },

    /**
     * Rebuilds the agents with the new model (the simplest correct way: respond() continuations
     * and subagents use the agent default too, so a per-send option would not cover them). Call
     * it while idle; the session itself lives in storage and is reopened on the new agent.
     */
    setModel(model: string): void {
      if (typeof model !== 'string' || model.trim() === '') {
        throw new Error('setModel: the model id must be a non-empty string')
      }
      const previousModel = config.model
      const previousOverride = modelOverride
      config.model = model
      modelOverride = undefined
      const old = agentsReady
      const next = makeAgents()
      // swap only once the new agents exist; on failure keep the old ones
      const settled = next.then(
        async () => {
          await old.then((previous) => previous.closeAll()).catch(() => {})
          return next
        },
        (error: unknown) => {
          opts.config.warnings?.push(
            `Could not switch to model "${model}": ${error instanceof Error ? error.message : String(error)}`,
          )
          if (agentsReady === pending) {
            config.model = previousModel
            modelOverride = previousOverride
            agentsReady = old
          }
          return old
        },
      )
      const pending: Promise<Agents> = settled
      agentsReady = pending
      next.catch(() => {})
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
