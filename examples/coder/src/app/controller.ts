/**
 * The application controller: wires workspace, shell, permissions, agents and storage behind the
 * {@link CoderController} contract that the Ink UI and print mode consume.
 */
import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { FileUIPart, LanguageModel } from 'ai'
import {
  type HarnessRun,
  type HarnessSession,
  type ModelCatalog,
  type TurnResult,
  version,
} from 'eharness'
import { nodeCheckpointStore } from 'eharness/filesystem/node'
import { capOutput, detectOsSandbox, localSandbox } from 'eharness/shell'
import { driveTurn, loadAgentDefinitions } from '../agents/index.ts'
import {
  type AgentDefinition,
  type ApprovalBroker,
  type BackgroundTask,
  type CoderConfig,
  type CoderController,
  type CoderMessage,
  type CoderSettings,
  type CompactSummary,
  type ContextCategory,
  type ContextDetails,
  type CustomCommand,
  type DiffResult,
  type DoctorCheck,
  type ModelOption,
  type PermissionMode,
  type RewindPoint,
  type RewindResult,
  type RunHooks,
  type SessionSummary,
  type SettingView,
  type StatusInfo,
  type SteerResult,
  THINKING_LEVELS,
  type ThinkingLevel,
  type ToolCallInfo,
  type UsageSummary,
} from '../contracts.ts'
import { createLspManager } from '../lsp/index.ts'
import { createBroker, createPermissionEngine, describeApproval } from '../permissions/index.ts'
import { createWorkspace } from '../workspace/index.ts'
import { type Agents, type CreateAgentsDeps, createAgents } from './agent.ts'
import { createCheckpoints } from './checkpoints.ts'
import { expandBody, expandSkill, type LoadedCommand, loadCommands } from './commands.ts'
import { mergeSettings, readSettingsLayers } from './config.ts'
import { computeDiff } from './diff.ts'
import { runDoctor } from './doctor.ts'
import { addHistory, readHistory } from './history.ts'
import { createHookRunner, hasHooks, hooksPlugin } from './hooks.ts'
import { addDirectory, listMemoryFiles, loadUserMemory } from './memory-files.ts'
import type { ModelState } from './model-switch.ts'
import { loadProviderModels } from './models.ts'
import { createOutputStyles } from './output-styles.ts'
import { loadPreferences, savePreferences } from './preferences.ts'
import { loadProjectMemory } from './project-memory.ts'
import { createModelResolver, KEY_ENV } from './provider.ts'
import { createRecap } from './recap.ts'
import { createSessionTools } from './session-tools.ts'
import { createStorage, latestSessionId, listSessions, newSessionId } from './sessions.ts'
import { createSettingsManager } from './settings.ts'
import { createSideQuestion } from './side-question.ts'
import { createStatusLine } from './status-line.ts'
import { createTaskHub } from './tasks.ts'
import { createSearchFn, type SearchFn } from './web-search.ts'

/** Options of {@link createController}. */
export interface CreateControllerOptions {
  config: CoderConfig & {
    warnings?: string[]
    contextWindowExplicit?: boolean
    /** The model came from a flag, settings or `CODER_MODEL`: a saved preference does not override it. */
    modelExplicit?: boolean
    /** Merged settings files (`LoadedConfig.settings`); `{}` when absent. */
    settings?: CoderSettings
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
  webFetch?: CreateAgentsDeps['webFetch']
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
  const persist = (...keys: Array<keyof ModelState>): void => {
    // only the named fields are written: a session-only change must not leak into the saved patch
    const snapshot: Partial<ModelState> = { provider: modelState.provider }
    for (const key of keys) Object.assign(snapshot, { [key]: modelState[key] })
    saving = saving.then(() => savePreferences(config.projectDataDir, snapshot))
  }
  let turnMs = 0
  const startSettings: CoderSettings = opts.config.settings ?? {}
  const warn = (message: string): void => {
    opts.config.warnings?.push(message)
  }
  const workspace = await createWorkspace(config)
  const osProblem = probeOsSandbox(startSettings.sandbox?.enabled === true)
  if (osProblem !== undefined) warn(osProblem)
  const sandbox = localSandbox(config.root, {
    os: osOptions(startSettings.sandbox, osProblem === undefined),
  })
  const permissions = createPermissionEngine({
    config,
    mounts: () => workspace.mounts(),
    // the classifier follows the session's model unless `autoMode.model` / CODER_AUTO_MODEL names one
    classifierModel: () =>
      config.autoModel !== undefined
        ? resolveModel(config.autoModel)
        : (opts.model ?? resolveModel(modelState.model)),
  })
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

  // ─── session state shared by the feature modules ───
  let sessionId: string =
    opts.sessionId ??
    (typeof config.resume === 'string' ? config.resume : undefined) ??
    (config.continueLast ? await latestSessionId(config) : undefined) ??
    newSessionId()
  const currentModel = (): LanguageModel => opts.model ?? resolveModel(modelState.model)
  let api: CoderController
  /** The session handle must be reopened (the output style changed): see `refreshSession`. */
  let sessionStale = false

  // ─── settings, output styles ───
  const outputStyles = createOutputStyles({
    root: config.root,
    userDir: config.userDir,
    trusted: config.trusted,
  })
  const settingsMgr = createSettingsManager({
    config: {
      ...config,
      settings: startSettings,
      modelExplicit: opts.config.modelExplicit === true,
    },
    current: () => ({
      provider: modelState.provider,
      model: modelState.model,
      thinking: modelState.thinking,
      mode: permissions.mode,
    }),
    outputStyleNames: async () => (await outputStyles.styles()).map((x) => x.name),
    apply: async (key, value) => {
      switch (key) {
        case 'permissions.defaultMode':
          if (value === 'auto' && !permissions.autoAvailable) {
            warn('auto mode is not available (disabled by autoMode.enabled).')
            break
          }
          permissions.setMode(value as PermissionMode)
          break
        case 'model':
          if (typeof value === 'string' && value.trim() !== '') api.setModel(value)
          break
        case 'thinking':
          api.setThinking(value as ThinkingLevel)
          break
        case 'sandbox.enabled':
        case 'sandbox.network': {
          const wanted = settingsMgr.setting('sandbox')
          const problem = probeOsSandbox(wanted?.enabled === true)
          if (problem !== undefined) warn(problem)
          sandbox.setOs(osOptions(wanted, problem === undefined))
          // the bash description states the sandbox: reopen the session so it is re-resolved
          sessionStale = true
          await refreshSession()
          break
        }
        case 'outputStyle':
          sessionStale = true // a session instruction: re-evaluated when the session reopens
          await refreshSession()
          break
        default:
      }
    },
  })

  // ─── hooks (settings.hooks) ───
  const hookNotices: string[] = []
  const hookRunner = hasHooks(startSettings.hooks)
    ? createHookRunner({
        hooks: startSettings.hooks ?? {},
        root: config.root,
        onNotify: (message) => {
          hookNotices.push(message)
          if (hookNotices.length > 50) hookNotices.shift()
          warn(`hook: ${message}`)
        },
      })
    : undefined
  const baseBroker = opts.broker ?? createBroker()
  /** Fires the `Notification` hooks when the user is needed: a prompt or a question is shown. */
  const broker: ApprovalBroker = hookRunner?.has('Notification')
    ? {
        ask(request, signal) {
          void hookRunner.notification(`Permission needed: ${request.title}`, sessionId)
          return baseBroker.ask(request, signal)
        },
        pending: () => baseBroker.pending(),
        answer: (id, answer) => baseBroker.answer(id, answer),
        question(request, signal) {
          const first = request.questions[0]
          void hookRunner.notification(
            `Question: ${first?.question ?? first?.header ?? 'the agent needs an answer'}`,
            sessionId,
          )
          return baseBroker.question(request, signal)
        },
        pendingQuestions: () => baseBroker.pendingQuestions(),
        answerQuestion: (id, result) => baseBroker.answerQuestion(id, result),
        subscribe: (listener) => baseBroker.subscribe(listener),
      }
    : baseBroker

  // ─── sessions, checkpoints, side calls ───
  const sessionTools = await createSessionTools({
    config,
    storage,
    sessionId: () => sessionId,
  })
  const checkpointStore = nodeCheckpointStore(join(config.projectDataDir, 'checkpoints'))
  const checkpoints = createCheckpoints({
    store: checkpointStore,
    storage,
    fs: workspace.fs,
    session: () => session(),
  })
  const sideQuestion = createSideQuestion({
    storage,
    sessionId: () => sessionId,
    model: currentModel,
  })
  const recap = createRecap({ storage, sessionId: () => sessionId, model: currentModel })

  // ─── background tasks ───
  const taskHub = createTaskHub({ session: () => sessionId })
  // ─── LSP ───
  const lsp = createLspManager({
    servers: startSettings.lsp,
    root: config.root,
    toReal: (path) => workspace.toReal(path),
    toVirtual: (path) => workspace.toVirtual(path),
  })

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
    checkpoints: checkpointStore,
    extraPlugins: () => [
      ...(hookRunner
        ? [
            hooksPlugin({
              hooks: startSettings.hooks ?? {},
              root: config.root,
              runner: hookRunner,
            }),
          ]
        : []),
    ],
    userMemory: () => loadUserMemory(config.userDir),
    outputStyle: () => outputStyles.instruction(settingsMgr.setting('outputStyle')),
    taskHub,
    lsp,
    ...(search ? { search } : {}),
    ...(opts.webFetch ? { webFetch: opts.webFetch } : {}),
  })
  const agentsReady = agents
  await agentsReady

  let controller: AbortController | undefined

  /** The turn `run()` / `steer()` is driving: lets steers that were not delivered wait for its end. */
  interface ActiveTurn {
    /** Resolves once the first `send()` returned (a steer waits for it). */
    started: Promise<void>
    /** Texts of steers that were not delivered (`delivery` 'dropped', or the turn waits for an approval). */
    deferred: string[]
    /** `run.delivery` of the steers sent; they all settle when the turn ends. */
    deliveries: Array<Promise<void>>
  }
  let active: ActiveTurn | undefined

  /** Turn ids a drive loop (`drive` / `adopt`) answers the approvals of: `onRun` skips those. */
  const driven = new Set<string>()
  /** Runs `session.onRun` handed over that nobody drove (wake, queued turn, steer fallback). */
  const adopted = new Set<Promise<TurnResult<CoderMessage>>>()
  const adoptAborts = new Set<AbortController>()

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** The hooks of the most recent `run()` / `steer()`: the UI's, reused for runs a background event wakes. */
  let lastHooks: RunHooks | undefined

  /** Read a run's stream to its end when nobody displays it. */
  const drain = async (run: HarnessRun<CoderMessage>): Promise<void> => {
    try {
      const reader = (run.stream as ReadableStream<unknown>).getReader()
      for (;;) if ((await reader.read()).done) return
    } catch {
      // the stream failed or was already consumed: the result carries the outcome
    }
  }

  /** Reopen the session handle when a setting that shapes the prompt changed (idle only). */
  const refreshSession = async (): Promise<void> => {
    if (!sessionStale || controller !== undefined) return
    sessionStale = false
    await (await agentsReady).main.closeSession(sessionId).catch(() => {})
  }

  /**
   * Drive the run `start` returns to its end, then every turn that follows it without the user
   * (a steer that became a queued turn, a steer dropped by an approval stop). Nothing the session
   * starts runs undriven, so no approval stays unanswered. Also drives the wake runs that
   * background tasks start (`onWake`).
   */
  const drive = async (
    start: (s: HarnessSession<CoderMessage>, signal: AbortSignal) => HarnessRun<CoderMessage>,
    hooks: RunHooks,
  ): Promise<TurnResult<CoderMessage>> => {
    const abort = new AbortController()
    controller = abort
    const turn: ActiveTurn = {
      started: Promise.resolve(),
      deferred: [],
      deliveries: [],
    }
    let markStarted: () => void = () => {}
    turn.started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    active = turn
    const began = Date.now()
    try {
      const s = await session()
      const driveOptions = {
        session: s,
        broker,
        permissions,
        describe,
        signal: abort.signal,
        stopOnBareDeny: true,
        questionTimeout: () => settingsMgr.setting('askUserQuestionTimeout'),
        onRun: (run: HarnessRun<CoderMessage>) => {
          driven.add(run.turnId)
          hooks.onRun(run)
        },
      }
      const first = start(s, abort.signal)
      markStarted()
      let result = await driveTurn(first, driveOptions)
      for (;;) {
        if (abort.signal.aborted || result.stop === 'aborted') break
        // the turn ended: every steer of it has been delivered, queued as a turn or dropped
        await Promise.all(turn.deliveries.splice(0))
        await tick()
        // turns the session started meanwhile (a queued turn, a steer that became one) are driven
        // by `adopt`: the prompt is done when they are
        if (adopted.size > 0) {
          result = (await Promise.all([...adopted])).at(-1) ?? result
          continue
        }
        if (turn.deferred.length === 0) break
        result = await driveTurn(
          s.send(turn.deferred.splice(0).join('\n\n'), { abortSignal: abort.signal }),
          driveOptions,
        )
      }
      return result
    } finally {
      markStarted()
      turnMs += Date.now() - began
      if (controller === abort) controller = undefined
      if (active === turn) active = undefined
      await refreshSession()
    }
  }

  /** One prompt (with optional images) as a turn. */
  const execute = async (
    text: string,
    hooks: RunHooks,
    files?: FileUIPart[],
  ): Promise<TurnResult<CoderMessage>> => {
    lastHooks = hooks
    // a turn the session started by itself (a wake) is still running: it ends before the next prompt
    while (adopted.size > 0) await Promise.all([...adopted])
    return drive(
      (s, signal) =>
        s.send(files !== undefined && files.length > 0 ? { text, files } : text, {
          abortSignal: signal,
        }),
      hooks,
    )
  }

  const subscribed = new WeakSet<object>()

  /**
   * Drive a run nobody started through `run()` / `steer()`: its approvals and questions go
   * through the broker like a prompt's, its stream to the hooks of the most recent
   * `run()` / `steer()` (the UI's), or is drained when there were none.
   */
  const adopt = (s: HarnessSession<CoderMessage>, run: HarnessRun<CoderMessage>): void => {
    const abort = new AbortController()
    adoptAborts.add(abort)
    const done: Promise<TurnResult<CoderMessage>> = driveTurn(run, {
      session: s,
      broker,
      permissions,
      describe,
      signal: abort.signal,
      stopOnBareDeny: true,
      questionTimeout: () => settingsMgr.setting('askUserQuestionTimeout'),
      onRun: (r) => {
        driven.add(r.turnId)
        if (lastHooks !== undefined) lastHooks.onRun(r)
        else void drain(r)
      },
    }).finally(() => {
      adopted.delete(done)
      adoptAborts.delete(abort)
    })
    adopted.add(done)
    // a run error is in the result; the promise only guards the broker
    done.catch(() => undefined)
  }

  /** Close the handle of a session we leave (never while its turn runs). */
  const closeSessionHandle = async (id: string): Promise<void> => {
    if (controller !== undefined) return
    await (await agentsReady).main.closeSession(id).catch(() => {})
  }

  const session = async (): Promise<HarnessSession<CoderMessage>> => {
    const s = (await agentsReady).main.session(sessionId) as unknown as HarnessSession<CoderMessage>
    if (!subscribed.has(s)) {
      subscribed.add(s)
      // every run of the session: the ones `drive` started answer to it, the others (a wake by a
      // background shell or subagent, a queued turn, a steer that became a turn) are adopted. The
      // check waits a microtask so `drive` has registered the run it started itself.
      s.onRun((run) => {
        queueMicrotask(() => {
          if (!driven.has(run.turnId)) adopt(s, run)
        })
      })
    }
    return s
  }

  /** Switch the controller to another stored session and close the handle of the one it leaves. */
  const switchTo = async (id: string): Promise<void> => {
    const old = sessionId
    sessionId = id
    if (old !== id) await closeSessionHandle(old)
    taskHub.changed()
  }

  const sandboxInfo = (): { enabled: boolean; kind: string; network: boolean } => {
    const state = sandbox.state()
    return { enabled: state.enabled, kind: state.kind, network: state.network }
  }

  const statusLine = createStatusLine({
    command: () => settingsMgr.setting('statusLine')?.command,
    cwd: config.root,
    input: async () => {
      const stats = await api.stats()
      return {
        sessionId,
        cwd: config.root,
        mode: permissions.mode,
        model: modelState.model,
        ...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {}),
        contextTokens: stats.contextTokens,
        contextWindow: stats.contextWindow,
      }
    },
  })

  api = {
    config,
    permissions,
    broker,
    workspace,
    get sessionId(): string {
      return sessionId
    },

    run: (
      text: string,
      hooks: RunHooks,
      runOpts?: { files?: FileUIPart[] },
    ): Promise<TurnResult<CoderMessage>> => execute(text, hooks, runOpts?.files),

    async steer(text: string, hooks: RunHooks): Promise<SteerResult> {
      lastHooks = hooks
      const turn = active
      if (turn !== undefined) {
        await turn.started
        const s = await session()
        // still running (nothing awaits between this check and the send)
        if (active === turn && controller !== undefined) {
          // not running = the turn stopped for an approval: a send would auto-deny it
          if (!s.running) {
            turn.deferred.push(text)
            return { delivered: 'step' }
          }
          const run = s.send(text, { ifBusy: 'steer' })
          turn.deliveries.push(
            // a steer that became a turn of its own reaches `adopt` through `session.onRun`
            (run.delivery ?? Promise.resolve('step' as const)).then((delivery) => {
              if (delivery === 'dropped') turn.deferred.push(text)
            }),
          )
          return { delivered: 'step' }
        }
      }
      return { delivered: 'turn', result: await execute(text, hooks) }
    },

    abort(): void {
      controller?.abort()
      for (const a of adoptAborts) a.abort()
      void session().then((s) => s.abort())
    },

    messages: async () => (await session()).messages(),

    async messagesOf(id: string): Promise<CoderMessage[]> {
      return (await storage.messages.load({ sessionId: id })) as CoderMessage[]
    },

    async compact(instructions?: string): Promise<CompactSummary | null> {
      const s = await session()
      // like Claude Code: summarize the whole conversation, optionally with focus text
      const message = await s.compact({ keepLast: 0, ...(instructions ? { instructions } : {}) })
      if (!message) return null
      const part = message.parts.find((p) => p.type === 'data-eh.compaction') as
        | { data?: { tokens?: { before?: unknown; after?: unknown } } }
        | undefined
      const tokens = part?.data?.tokens
      return typeof tokens?.before === 'number' && typeof tokens.after === 'number'
        ? { tokens: { before: tokens.before, after: tokens.after } }
        : {}
    },

    async clear(): Promise<void> {
      await switchTo(newSessionId())
    },

    async resume(id: string): Promise<void> {
      if (id.includes(':agent:')) throw new Error(`cannot resume a subagent session: ${id}`)
      if ((await storage.messages.load({ sessionId: id, limit: 1 })).length === 0)
        throw new Error(`unknown session: ${id}`)
      await switchTo(id)
    },

    sessions: async (): Promise<SessionSummary[]> =>
      sessionTools.withNames(await listSessions(config)),

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
    setModel(model: string, opts?: { persist?: boolean }): void {
      if (typeof model !== 'string' || model.trim() === '') {
        throw new Error('setModel: the model id must be a non-empty string')
      }
      modelState.model = model.trim()
      config.model = modelState.model
      if (opts?.persist !== false) persist('model')
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

    setThinking(level: ThinkingLevel, opts?: { persist?: boolean }): void {
      if (!THINKING_LEVELS.includes(level)) {
        throw new Error(
          `setThinking: invalid level "${String(level)}". Use one of: ${THINKING_LEVELS.join(', ')}`,
        )
      }
      modelState.thinking = level
      if (opts?.persist !== false) persist('thinking')
    },

    async models(): Promise<ModelOption[]> {
      return modelOptions
    },

    async contextDetails(): Promise<ContextDetails> {
      const s = await session()
      const [stats, info, messages, listed] = await Promise.all([
        s.stats(),
        (await agentsReady).contextInfo(),
        s.messages(),
        s.tools(),
      ])
      // Per-tool sizes come from the core (`session.tools()`); `source:mcp:*` is MCP, skill tools
      // and `tool_search` are `core`, everything else (`app`, `plugin:*`) is built in.
      const tools = listed
        .map((t) => ({
          name: t.name,
          tokens: t.tokens,
          source: (t.source.startsWith('source:mcp:')
            ? 'mcp'
            : t.source === 'core'
              ? 'skill'
              : 'builtin') as 'builtin' | 'mcp' | 'skill',
        }))
        .sort((a, b) => b.tokens - a.tokens)
      let mcpTokens = 0
      let toolTokens = 0
      for (const t of stats.toolSources ?? []) {
        if (t.source.startsWith('source:mcp:')) mcpTokens += t.tokens
        else toolTokens += t.tokens
      }
      // The core cannot tell the memory blocks from the rest of the `app` instruction block, so
      // the app's own memory estimate is subtracted from it.
      let app = 0
      let skills = 0
      let other = 0
      for (const b of stats.instructionBlocks ?? []) {
        if (b.owner === 'app') app += b.tokens
        else if (b.owner === 'core:skills') skills += b.tokens
        else other += b.tokens
      }
      const memory = Math.min(info.memoryTokens, app)
      const categories: ContextCategory[] = [
        { key: 'system', label: 'System prompt', tokens: app - memory + other },
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
        tools,
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
        sandbox: sandboxInfo(),
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

    // ─── sessions and conversation ───
    rewindPoints: (): Promise<RewindPoint[]> => checkpoints.rewindPoints(),

    async rewind(messageId, what): Promise<RewindResult> {
      const result = await checkpoints.rewind(messageId, what)
      if (result.sessionId !== undefined) await switchTo(result.sessionId)
      return result
    },

    async branch(name?: string): Promise<string> {
      const from = sessionId
      const to = (await (await session()).fork()).id
      await sessionTools.nameBranch(from, to, name)
      await switchTo(to)
      return to
    },

    rename: (name: string): Promise<void> => sessionTools.rename(name),

    get sessionName(): string | undefined {
      return sessionTools.sessionName()
    },

    async exportText(): Promise<string> {
      return sessionTools.exportText(await (await session()).messages())
    },

    async assistantText(n?: number): Promise<string | undefined> {
      return sessionTools.assistantText(await (await session()).messages(), n)
    },

    sideQuestion,
    recap: recap.recap,
    async suggestNext(): Promise<string | undefined> {
      return settingsMgr.setting('promptSuggestions') === true ? recap.suggestNext() : undefined
    },

    // ─── workspace and memory ───
    addDirectory: (path: string): Promise<string> => addDirectory(workspace, path),
    memoryFiles: () => listMemoryFiles({ root: config.root, userDir: config.userDir }),

    // ─── background tasks ───
    tasks: (): BackgroundTask[] => taskHub.tasks(),
    stopTask: (id: string): Promise<void> => taskHub.stopTask(id),
    async taskOutput(id: string): Promise<string> {
      return taskHub.taskOutput(id)
    },
    onTasks: (listener) => taskHub.onTasks(listener),

    // ─── settings and diagnostics ───
    settings: (): Promise<SettingView[]> => settingsMgr.settings(),
    updateSetting: (key, value, scope): Promise<void> =>
      settingsMgr.updateSetting(key, value, scope),
    setting: (key) => settingsMgr.setting(key),
    outputStyles: () => outputStyles.styles(),

    async doctor(): Promise<DoctorCheck[]> {
      let merged: CoderSettings = startSettings
      try {
        merged = mergeSettings((await readSettingsLayers(config)).map((l) => l.settings))
      } catch {
        // an invalid file: runDoctor reports it under "Settings files"
      }
      const checks = await runDoctor({ config, settings: merged, models: () => api.models() })
      const os = sandboxInfo()
      checks.push({
        name: 'Sandbox state',
        status: 'ok',
        detail: os.enabled
          ? `on (${os.kind}), network ${os.network ? 'allowed' : 'blocked'}`
          : 'off: bash commands run unsandboxed',
      })
      if (lsp.available) {
        const servers = lsp.status()
        const failed = servers.filter((x) => x.state === 'failed')
        checks.push({
          name: 'Language servers',
          status: failed.length > 0 ? 'warn' : 'ok',
          detail: servers
            .map((x) => `${x.name}: ${x.state}${x.detail ? ` (${x.detail})` : ''}`)
            .join('; '),
        })
      }
      if (hookRunner !== undefined) {
        checks.push({
          name: 'Hooks',
          status: hookNotices.length > 0 ? 'warn' : 'ok',
          detail:
            hookNotices.length > 0
              ? `${hookNotices.length} notice(s), latest: ${hookNotices.at(-1)}`
              : 'configured, no problems so far',
        })
      }
      return checks
    },

    statusLineText: () => statusLine.text(),

    async close(): Promise<void> {
      controller?.abort()
      for (const a of adoptAborts) a.abort()
      taskHub.close()
      await lsp.close().catch(() => {})
      await (await agentsReady).closeAll()
      await saving
    },
  }
  return api
}

/** OS sandbox options from the `sandbox` setting; `usable` false forces it off. */
function osOptions(
  setting: CoderSettings['sandbox'],
  usable: boolean,
): { enabled: boolean; network: boolean; allowWrite: string[] } {
  return {
    enabled: usable && setting?.enabled === true,
    network: setting?.network ?? false,
    allowWrite: setting?.allowWrite ?? [],
  }
}

/**
 * Why the OS sandbox cannot be used although it is wanted, or `undefined`. bubblewrap is probed
 * with a real run (it fails inside containers and on kernels without user namespaces);
 * sandbox-exec on macOS needs no probe.
 */
function probeOsSandbox(wanted: boolean): string | undefined {
  if (!wanted) return undefined
  const detected = detectOsSandbox()
  if (detected.kind === 'none') {
    return 'sandbox.enabled is on but no OS sandbox tool was found (sandbox-exec or bwrap): commands run unsandboxed'
  }
  if (detected.kind === 'bubblewrap') {
    const probe = spawnSync(detected.path ?? 'bwrap', ['--ro-bind', '/', '/', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    })
    if (probe.status !== 0) {
      return 'sandbox.enabled is on but bubblewrap cannot start here (no user namespaces?): commands run unsandboxed'
    }
  }
  return undefined
}
