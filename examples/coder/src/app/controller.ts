/**
 * The application controller: wires workspace, shell, permissions, agents and storage behind the
 * {@link CoderController} contract that the Ink UI and print mode consume.
 */
import { access } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  type HarnessRun,
  type HarnessSession,
  type ModelCatalog,
  type TurnResult,
  version,
} from 'eharness'
import { driveTurn, loadAgentDefinitions } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type CoderConfig,
  type CoderController,
  type CoderMessage,
  type ContextCategory,
  type ContextDetails,
  type CustomCommand,
  type DiffResult,
  type ModelOption,
  type RunHooks,
  type SessionSummary,
  type StatusInfo,
  type SteerResult,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ToolCallInfo,
  type UsageSummary,
} from '../contracts.ts'
import { createBroker, createPermissionEngine, describeApproval } from '../permissions/index.ts'
import { capOutput, createLocalSandbox } from '../shell/index.ts'
import { createWorkspace } from '../workspace/index.ts'
import { type Agents, createAgents } from './agent.ts'
import { expandBody, expandSkill, type LoadedCommand, loadCommands } from './commands.ts'
import { computeDiff } from './diff.ts'
import { addHistory, readHistory } from './history.ts'
import type { ModelState } from './model-switch.ts'
import { loadProviderModels } from './models.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import { loadProjectMemory } from './project-memory.ts'
import { createModelResolver, KEY_ENV } from './provider.ts'
import { createStorage, latestSessionId, listSessions, newSessionId } from './sessions.ts'
import { createSearchFn, type SearchFn, type WebFetchDeps } from './web-tools.ts'

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
  /** Web search of the `web_search` tool (tests). Default: the provider's search; none for scripted models. */
  search?: SearchFn
  /** Overrides of `web_fetch` internals (tests): `fetch`, host resolution, timeout. */
  webFetch?: Partial<Pick<WebFetchDeps, 'fetch' | 'resolve' | 'timeoutMs'>>
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
  const commandsWarned = new Set<string>()
  const readCommands = async (): Promise<LoadedCommand[]> => {
    const { commands, warnings: found } = await loadCommands({
      root: config.root,
      userDir: config.userDir,
      trusted: config.trusted,
    })
    for (const w of found) {
      if (!commandsWarned.has(w)) {
        commandsWarned.add(w)
        opts.config.warnings?.push(w)
      }
    }
    return commands
  }
  await readCommands()
  const loaded = opts.models ? undefined : await loadProviderModels(config.provider, config.userDir)
  const catalog = opts.models ?? loaded?.catalog
  const modelOptions: ModelOption[] = loaded?.options ?? []

  // invalid agent files: reported next to the config warnings
  opts.config.warnings?.push(...warnings)

  // web search needs a real provider call: scripted/offline models have none
  const search: SearchFn | undefined =
    opts.search ??
    (opts.model === undefined && process.env[KEY_ENV[config.provider]]
      ? createSearchFn({ provider: config.provider, resolveModel })
      : undefined)

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
    ...(search ? { search } : {}),
    ...(opts.webFetch ? { webFetch: opts.webFetch } : {}),
  })
  const agentsReady = agents
  await agentsReady

  let sessionId: string =
    opts.sessionId ??
    (typeof config.resume === 'string' ? config.resume : undefined) ??
    (config.continueLast ? await latestSessionId(config) : undefined) ??
    newSessionId()

  let controller: AbortController | undefined

  /** The turn `run()` / `steer()` is driving: lets a steer that missed it join the drive loop. */
  interface ActiveTurn {
    /** Resolves once the first `send()` returned (a steer waits for it). */
    started: Promise<void>
    /** Turn ids already driven. */
    seen: Set<string>
    /** Runs a steer started that nothing drives yet (it arrived as the turn ended). */
    pending: Array<HarnessRun<CoderMessage>>
    /** Steers that found no running turn (it waits for an approval) or were dropped by one. */
    deferred: string[]
  }
  let active: ActiveTurn | undefined

  /** Texts of steers the core dropped because the turn stopped `tool-pending`. */
  const watchDropped = (s: HarnessSession<CoderMessage>, into: string[]): (() => void) => {
    let reader: ReadableStreamDefaultReader<unknown> | undefined
    try {
      reader = (s.events() as ReadableStream<unknown>).getReader()
    } catch {
      return () => {}
    }
    const r = reader
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await r.read()
          if (done) return
          const e = value as { type?: string; reason?: string; text?: string }
          if (e.type === 'input-dropped' && e.reason === 'tool-pending' && e.text) into.push(e.text)
        }
      } catch {
        // the stream was cancelled or the session closed
      }
    })()
    return () => void r.cancel().catch(() => {})
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /**
   * Run one prompt to its end: drive the turn, then every turn that follows it without the user
   * (a steer that became a queued turn, a steer dropped by an approval stop). Nothing the session
   * starts runs undriven, so no approval stays unanswered.
   */
  const execute = async (text: string, hooks: RunHooks): Promise<TurnResult<CoderMessage>> => {
    const abort = new AbortController()
    controller = abort
    const turn: ActiveTurn = {
      started: Promise.resolve(),
      seen: new Set(),
      pending: [],
      deferred: [],
    }
    let markStarted: () => void = () => {}
    turn.started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    active = turn
    const began = Date.now()
    let stopWatching: () => void = () => {}
    try {
      const s = await session()
      stopWatching = watchDropped(s, turn.deferred)
      const driveOptions = {
        session: s,
        broker,
        permissions,
        describe,
        signal: abort.signal,
        stopOnBareDeny: true,
        onRun: (run: HarnessRun<CoderMessage>) => {
          turn.seen.add(run.turnId)
          hooks.onRun(run)
        },
      }
      const first = s.send(text, { abortSignal: abort.signal })
      turn.seen.add(first.turnId)
      markStarted()
      let result = await driveTurn(first, driveOptions)
      for (;;) {
        if (abort.signal.aborted || result.stop === 'aborted') break
        await tick()
        await tick()
        const next =
          turn.pending.shift() ??
          (() => {
            const queued = s.attach() as HarnessRun<CoderMessage> | undefined
            return queued !== undefined && !turn.seen.has(queued.turnId) ? queued : undefined
          })() ??
          (turn.deferred.length > 0
            ? s.send(turn.deferred.splice(0).join('\n\n'), { abortSignal: abort.signal })
            : undefined)
        if (next === undefined) break
        result = await driveTurn(next, driveOptions)
      }
      return result
    } finally {
      markStarted()
      stopWatching()
      turnMs += Date.now() - began
      if (controller === abort) controller = undefined
      if (active === turn) active = undefined
    }
  }

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

    run: (text: string, hooks: RunHooks): Promise<TurnResult<CoderMessage>> => execute(text, hooks),

    async steer(text: string, hooks: RunHooks): Promise<SteerResult> {
      const turn = active
      if (turn !== undefined) {
        await turn.started
        const s = await session()
        // still running (nothing awaits between this check and the send)
        if (active === turn && controller !== undefined) {
          // no running turn = it stopped for an approval: a send would auto-deny that approval
          if (s.attach() === undefined) {
            turn.deferred.push(text)
            return { delivered: 'step' }
          }
          const run = s.send(text, { ifBusy: 'steer' })
          // a run of a turn nobody drives (the turn had just ended): the drive loop takes it over
          if (!turn.seen.has(run.turnId)) turn.pending.push(run)
          return { delivered: 'step' }
        }
      }
      return { delivered: 'turn', result: await execute(text, hooks) }
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

    history: (q?: { allProjects?: boolean; limit?: number }): Promise<string[]> =>
      readHistory(config.userDir, config.root, q),

    addHistory: (text: string): Promise<void> => addHistory(config.userDir, config.root, text),

    async diff(): Promise<DiffResult> {
      const toRoot = (virtualPath: string): string | null => {
        let best: { virtual: string; real: string } | undefined
        const probe = `${virtualPath.replace(/\/+$/, '')}/`
        for (const m of workspace.mounts()) {
          if (
            probe.startsWith(m.virtual) &&
            (best === undefined || m.virtual.length > best.virtual.length)
          ) {
            best = m
          }
        }
        if (best === undefined) return null
        const real = join(best.real, probe.slice(best.virtual.length).replace(/\/+$/, ''))
        const rel = relative(config.root, real)
        return rel === '' || rel.startsWith('..') || isAbsolute(rel)
          ? null
          : rel.split('\\').join('/')
      }
      return computeDiff({
        root: config.root,
        messages: await (await session()).messages(),
        toRoot,
      })
    },

    async commands(): Promise<CustomCommand[]> {
      return (await readCommands()).map(({ body: _body, ...command }) => command)
    },

    async expandCommand(name: string, args: string): Promise<string> {
      const command = (await readCommands()).find((c) => c.name === name)
      if (command === undefined) throw new Error(`unknown command: /${name}`)
      return command.source === 'skill' || command.body === undefined
        ? expandSkill(command.name, args)
        : expandBody(command.body, args)
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
