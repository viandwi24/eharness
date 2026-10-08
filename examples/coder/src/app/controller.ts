/**
 * The application controller: wires workspace, shell, permissions, agents and storage behind the
 * {@link CoderController} contract that the Ink UI and print mode consume.
 */
import { access } from 'node:fs/promises'
import type { LanguageModel } from 'ai'
import { type HarnessSession, type ModelCatalog, type TurnResult, version } from 'eharness'
import { driveTurn, loadAgentDefinitions } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type CoderConfig,
  type CoderController,
  type CoderMessage,
  type ContextCategory,
  type ContextDetails,
  type ModelOption,
  type RunHooks,
  type SessionSummary,
  type StatusInfo,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ToolCallInfo,
  type UsageSummary,
} from '../contracts.ts'
import { createBroker, createPermissionEngine, describeApproval } from '../permissions/index.ts'
import { capOutput, createLocalSandbox } from '../shell/index.ts'
import { createWorkspace } from '../workspace/index.ts'
import { type Agents, createAgents } from './agent.ts'
import type { ModelState } from './model-switch.ts'
import { loadProviderModels } from './models.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import { loadProjectMemory } from './project-memory.ts'
import { createModelResolver } from './provider.ts'
import { createStorage, latestSessionId, listSessions, newSessionId } from './sessions.ts'

/** Options of {@link createController}. */
export interface CreateControllerOptions {
  config: CoderConfig & {
    warnings?: string[]
    contextWindowExplicit?: boolean
    /** The model came from a flag, settings or `CODER_MODEL`: a saved preference does not override it. */
    modelExplicit?: boolean
  }
  /** Model catalog override (tests). Default: the cached catalog of the provider (`app/models.ts`). */
  models?: ModelCatalog
  /** Model override (offline tests): every agent uses it whatever `setModel()` says. */
  model?: LanguageModel
  /** Model id → model (tests); default: per provider (`app/provider.ts`). Ignored with `model`. */
  resolveModel?: (id: string) => LanguageModel
  /** Initial thinking level (`--thinking`); wins over the saved preference. */
  thinking?: ThinkingLevel
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
  const prefs = await loadPreferences(config.projectDataDir)
  if (
    opts.config.modelExplicit !== true &&
    prefs.model !== undefined &&
    prefs.provider === config.provider
  ) {
    config.model = prefs.model
  }
  const modelState: ModelState = {
    provider: config.provider,
    model: config.model,
    thinking: opts.thinking ?? prefs.thinking ?? 'provider-default',
  }
  const resolveModel = opts.resolveModel ?? createModelResolver(config.provider)
  // preference writes are serialized so the last choice wins
  let saving: Promise<void> = Promise.resolve()
  const persist = (): void => {
    const snapshot = { ...modelState }
    saving = saving.then(() => savePreferences(config.projectDataDir, snapshot))
  }
  let turnMs = 0
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
  const loaded = opts.models ? undefined : await loadProviderModels(config.provider, config.userDir)
  const catalog = opts.models ?? loaded?.catalog
  const modelOptions: ModelOption[] = loaded?.options ?? []

  // invalid agent files: reported next to the config warnings
  opts.config.warnings?.push(...warnings)

  const agents: Promise<Agents> = createAgents({
    config,
    workspace,
    sandbox,
    permissions,
    broker,
    describe,
    definitions,
    storage,
    modelState,
    resolveModel,
    ...(opts.model ? { model: opts.model } : {}),
    ...(catalog ? { models: catalog } : {}),
    contextWindowExplicit: opts.config.contextWindowExplicit === true,
  })
  const agentsReady = agents
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
      const began = Date.now()
      try {
        return await driveTurn(s.send(text, { abortSignal: active.signal }), {
          session: s,
          broker,
          permissions,
          describe,
          signal: active.signal,
          stopOnBareDeny: true,
          onRun: hooks.onRun,
        })
      } finally {
        turnMs += Date.now() - began
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

    /** The agents read the model state at the start of every turn: nothing is rebuilt. */
    setModel(model: string): void {
      if (typeof model !== 'string' || model.trim() === '') {
        throw new Error('setModel: the model id must be a non-empty string')
      }
      modelState.model = model.trim()
      config.model = modelState.model
      persist()
    },

    get model(): string {
      return modelState.model
    },
    get provider() {
      return modelState.provider
    },
    get thinking(): ThinkingLevel {
      return modelState.thinking
    },

    setThinking(level: ThinkingLevel): void {
      if (!THINKING_LEVELS.includes(level)) {
        throw new Error(
          `setThinking: invalid level "${String(level)}". Use one of: ${THINKING_LEVELS.join(', ')}`,
        )
      }
      modelState.thinking = level
      persist()
    },

    async models(): Promise<ModelOption[]> {
      return modelOptions
    },

    async contextDetails(): Promise<ContextDetails> {
      const s = await session()
      const [stats, info, messages] = await Promise.all([
        s.stats(),
        (await agentsReady).contextInfo(),
        s.messages(),
      ])
      const sorted = [...info.tools].sort((a, b) => b.tokens - a.tokens)
      const builtinTokens = sorted.reduce((n, t) => n + t.tokens, 0)
      // the core reports one calibrated tool total; what the app cannot itemise is MCP
      const mcpTokens = info.hasMcp ? Math.max(0, stats.tools - builtinTokens) : 0
      const toolTokens = stats.tools - mcpTokens
      const scale = builtinTokens > 0 && toolTokens > 0 ? toolTokens / builtinTokens : 1
      const memory = Math.min(info.memoryTokens, stats.instructions)
      const skills = Math.min(info.skillsTokens, stats.instructions - memory)
      const categories: ContextCategory[] = [
        { key: 'system', label: 'System prompt', tokens: stats.instructions - memory - skills },
        { key: 'memory', label: 'Memory files', tokens: memory },
        { key: 'skills', label: 'Skills', tokens: skills },
        { key: 'tools', label: 'Tools', tokens: toolTokens },
        { key: 'mcp', label: 'MCP tools', tokens: mcpTokens },
        { key: 'messages', label: 'Messages', tokens: stats.messages },
      ]
      let user = 0
      let assistant = 0
      let toolCalls = 0
      for (const m of messages) {
        if (m.metadata?.eharness?.kind !== undefined) continue
        if (m.role === 'user') user++
        else if (m.role === 'assistant') assistant++
        for (const part of m.parts) if (part.type.startsWith('tool-')) toolCalls++
      }
      return {
        model: modelState.model,
        provider: modelState.provider,
        window: stats.window,
        used: stats.tokens,
        free: Math.max(0, stats.window - stats.tokens),
        summarizeAt: stats.summarizeAt,
        hardLimit: stats.hardLimit,
        autocompactBuffer: Math.max(0, stats.window - stats.summarizeAt),
        categories,
        tools: sorted.map((t) => ({
          name: t.name,
          tokens: Math.round(t.tokens * scale),
          source: 'builtin' as const,
        })),
        memoryFiles: info.memoryFiles,
        messages: { count: user + assistant, user, assistant, toolCalls },
        ...(stats.lastCompaction
          ? {
              lastCompaction: {
                before: stats.lastCompaction.before,
                after: stats.lastCompaction.after,
                at: stats.lastCompaction.at,
              },
            }
          : {}),
        ...(stats.pruned ? { pruned: stats.pruned } : {}),
      }
    },

    async usage(): Promise<UsageSummary> {
      const state = await storage.state.get(sessionId)
      const usage = state?.core.usage
      let cached = 0
      for (const m of await (await session()).messages()) {
        cached += m.metadata?.eharness?.usage?.cachedInputTokens ?? 0
      }
      return {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        ...(cached > 0 ? { cachedInputTokens: cached } : {}),
        turns: usage?.turns ?? 0,
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        durationMs: turnMs,
      }
    },

    async status(): Promise<StatusInfo> {
      const memory = await loadProjectMemory(config.root)
      const settingsFiles = await Promise.all(
        Object.values(config.settingsFiles).map(async (path) => ({
          path,
          exists: await access(path).then(
            () => true,
            () => false,
          ),
        })),
      )
      return {
        version: '0.0.0',
        eharnessVersion: version,
        cwd: config.root,
        provider: modelState.provider,
        model: modelState.model,
        thinking: modelState.thinking,
        mode: permissions.mode,
        sessionId,
        mounts: workspace.mounts(),
        trusted: config.trusted,
        untrusted: config.untrusted,
        ...(memory.file !== undefined ? { memoryFile: memory.file } : {}),
        mcpServers: Object.keys(config.mcpServers),
        agents: definitions.length,
        settingsFiles,
      }
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
      await saving
    },
  }
}
