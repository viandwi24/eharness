/** An in-memory `CoderController` for the render tests, backed by a real eharness session. */
import { type FileUIPart, tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod/v4'
import type {
  ApprovalAnswer,
  ApprovalBroker,
  ApprovalRequest,
  BackgroundTask,
  CoderConfig,
  CoderController,
  CoderMessage,
  CoderSettings,
  ContextDetails,
  CustomCommand,
  DoctorCheck,
  ModelOption,
  PermissionEngine,
  PermissionMode,
  PermissionRules,
  QuestionRequest,
  QuestionResult,
  RewindPoint,
  RewindResult,
  SessionSummary,
  SettingView,
  StatusInfo,
  ThinkingLevel,
  UsageSummary,
} from '../src/contracts.ts'
import { MODE_CYCLE } from '../src/contracts.ts'

/** Realistic `/context` data: a 200k window, 29% used, compaction at 160k. */
export const FIXTURE_CONTEXT: ContextDetails = {
  model: 'anthropic/claude-sonnet-4.6',
  provider: 'openrouter',
  window: 200_000,
  used: 58_000,
  free: 142_000,
  summarizeAt: 160_000,
  hardLimit: 190_000,
  autocompactBuffer: 40_000,
  categories: [
    { key: 'system', label: 'System prompt', tokens: 3100 },
    { key: 'memory', label: 'Memory files', tokens: 2400 },
    { key: 'skills', label: 'Skills', tokens: 1200 },
    { key: 'tools', label: 'Tools', tokens: 11_300 },
    { key: 'mcp', label: 'MCP tools', tokens: 4000 },
    { key: 'messages', label: 'Messages', tokens: 36_000 },
  ],
  tools: [
    { name: 'bash', tokens: 2100, source: 'builtin' },
    { name: 'edit_file', tokens: 1800, source: 'builtin' },
    { name: 'agent', tokens: 1500, source: 'builtin' },
    { name: 'github_search', tokens: 900, source: 'mcp' },
    { name: 'read_file', tokens: 700, source: 'builtin' },
    { name: 'load_skill', tokens: 300, source: 'skill' },
  ],
  memoryFiles: [
    { path: 'AGENTS.md', tokens: 1900 },
    { path: '.coder/CODER.local.md', tokens: 500 },
  ],
  messages: { count: 24, user: 9, assistant: 15, toolCalls: 31 },
  lastCompaction: { before: 152_000, after: 18_000, at: Date.UTC(2026, 0, 2, 3, 0, 0) },
  pruned: { outputs: 12, chars: 340_000 },
}

export const FIXTURE_USAGE: UsageSummary = {
  inputTokens: 184_320,
  outputTokens: 9_870,
  cachedInputTokens: 120_000,
  turns: 5,
  costUsd: 0.4123,
  durationMs: 185_000,
}

export const FIXTURE_MODELS: ModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'openrouter',
    contextWindow: 200_000,
    pricing: { input: 3, output: 15 },
    reasoning: true,
    tools: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    provider: 'openrouter',
    contextWindow: 400_000,
    pricing: { input: 1.25, output: 10 },
    reasoning: true,
    tools: true,
  },
  {
    id: 'meta/llama-3-8b',
    name: 'Llama 3 8B',
    provider: 'openrouter',
    contextWindow: 8000,
    pricing: { input: 0.05, output: 0.1 },
    reasoning: false,
    tools: true,
  },
  {
    id: 'acme/chat-only',
    name: 'Acme Chat',
    provider: 'openrouter',
    contextWindow: 32_000,
    reasoning: false,
    tools: false,
  },
]

export function fakeBroker(): ApprovalBroker & {
  answers: Array<{ id: string; answer: ApprovalAnswer }>
  questionAnswers: Array<{ id: string; result: QuestionResult }>
  push(request: ApprovalRequest): void
  pushQuestion(request: QuestionRequest): void
} {
  let queue: ApprovalRequest[] = []
  let questions: QuestionRequest[] = []
  const listeners = new Set<(p: ApprovalRequest[]) => void>()
  const notify = (): void => {
    for (const l of listeners) l(queue)
  }
  const answers: Array<{ id: string; answer: ApprovalAnswer }> = []
  const questionAnswers: Array<{ id: string; result: QuestionResult }> = []
  return {
    answers,
    questionAnswers,
    ask: () => new Promise(() => {}),
    pending: () => queue,
    answer(id, answer) {
      answers.push({ id, answer })
      queue = queue.filter((r) => r.id !== id)
      notify()
    },
    question: () => new Promise(() => {}),
    pendingQuestions: () => questions,
    answerQuestion(id, result) {
      questionAnswers.push({ id, result })
      questions = questions.filter((r) => r.id !== id)
      notify()
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    push(request) {
      queue = [...queue, request]
      notify()
    },
    pushQuestion(request) {
      questions = [...questions, request]
      notify()
    },
  }
}

/** Settings of the `/config` page fixture. */
export const DEFAULT_SETTINGS: SettingView[] = [
  {
    key: 'promptSuggestions',
    label: 'Prompt suggestions',
    description: 'Suggest the next prompt after each turn',
    type: 'boolean',
    value: false,
    source: 'default',
  },
  {
    key: 'theme',
    label: 'Theme',
    description: 'UI palette',
    type: 'enum',
    options: ['dark', 'light', 'auto'],
    value: 'dark',
    source: 'default',
  },
  {
    key: 'askUserQuestionTimeout',
    label: 'Question timeout',
    description: 'Seconds before an unanswered question is dismissed',
    type: 'number',
    value: 0,
    source: 'default',
  },
  {
    key: 'outputStyle',
    label: 'Output style',
    description: 'Response style',
    type: 'string',
    value: 'default',
    source: 'user',
  },
]

export interface FakeOptions {
  script?: ScriptedStepInput[]
  resume?: true
  sessions?: SessionSummary[]
  mode?: PermissionMode
  untrusted?: string[]
  /** Stored messages by session id for `messagesOf`. */
  childMessages?: Record<string, CoderMessage[]>
  /** `models()` result; a function may reject to simulate being offline. */
  models?: ModelOption[] | (() => Promise<ModelOption[]>)
  context?: ContextDetails
  usage?: UsageSummary
  status?: Partial<StatusInfo>
  model?: string
  thinking?: ThinkingLevel
  /** Prompt history of this project, newest last. */
  history?: string[]
  /** History of all projects (Ctrl+R), newest last. */
  allHistory?: string[]
  commands?: CustomCommand[]
  /** `steer()` result: joined the running turn (default) or ran as a turn of its own. */
  steerAs?: 'step' | 'turn'
  /** Project root (`/export` writes below it). */
  root?: string
  rewindPoints?: RewindPoint[]
  /** Result of `rewind()`; default restores the point's files and returns its prompt. */
  rewindResult?: Partial<RewindResult>
  tasks?: BackgroundTask[]
  settings?: SettingView[]
  /** Values `setting(key)` returns. */
  settingValues?: Partial<CoderSettings>
  doctor?: DoctorCheck[]
  outputStyles?: Array<{ name: string; description: string }>
  /** `suggestNext()` result. */
  suggestion?: string
  /** Chunks `sideQuestion()` streams (default one chunk). */
  sideChunks?: string[]
  /** Delay between side question chunks. */
  sideDelayMs?: number
  assistantTexts?: string[]
  memoryFiles?: Array<{ path: string; real: string; exists: boolean; scope: 'project' | 'user' }>
  recap?: string
  exportText?: string
  sessionName?: string
}

export function fakeController(opts: FakeOptions = {}) {
  const broker = fakeBroker()
  const runFiles: FileUIPart[][] = []
  let tasks: BackgroundTask[] = [...(opts.tasks ?? [])]
  const taskListeners = new Set<(t: BackgroundTask[]) => void>()
  const settings: SettingView[] = (opts.settings ?? DEFAULT_SETTINGS).map((v) => ({ ...v }))
  const settingValues: Record<string, unknown> = { ...opts.settingValues }
  let sessionName = opts.sessionName
  let sessionId = 's1'
  const calls: string[] = []
  const shellCalls: string[] = []
  const stored = [...(opts.history ?? [])]
  let mode: PermissionMode = opts.mode ?? 'default'
  const listeners = new Set<(m: PermissionMode) => void>()
  const rules: PermissionRules = { allow: [], ask: [], deny: [] }
  const permissions: PermissionEngine = {
    get mode() {
      return mode
    },
    setMode(m) {
      calls.push(`setMode:${m}`)
      mode = m
      for (const l of listeners) l(mode)
    },
    cycleMode() {
      calls.push('cycleMode')
      const i = MODE_CYCLE.indexOf(mode)
      mode = MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? 'default'
      for (const l of listeners) l(mode)
      return mode
    },
    decide: () => ({ status: 'approved' }),
    suggestRule: () => undefined,
    allow: async () => {},
    async addRule(kind, rule, scope) {
      if (rule === 'bad') throw new Error('invalid rule: bad')
      calls.push(`addRule:${kind}:${rule}:${scope}`)
      rules[kind].push(rule)
    },
    async removeRule(kind, rule) {
      calls.push(`removeRule:${kind}:${rule}`)
      const i = rules[kind].indexOf(rule)
      if (i >= 0) rules[kind].splice(i, 1)
      return i >= 0
    },
    rules: () => rules,
    inactiveTools: () => [],
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
  const files = z.object({ path: z.string() })
  const agent = defineHarnessAgent({
    model: scriptedModel(opts.script ?? [{ text: 'ok' }]),
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    tools: {
      read_file: tool({ inputSchema: files, execute: async () => 'line one\nline two' }),
      edit_file: tool({
        inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
        execute: async () => 'Edited /a.ts',
      }),
    },
  })
  const config = {
    root: '/work/project',
    model: opts.model ?? 'test/model',
    mode,
    contextWindow: 100_000,
    resume: opts.resume,
    untrusted: opts.untrusted ?? [],
    trusted: (opts.untrusted ?? []).length === 0,
  } as unknown as CoderConfig
  let currentModel = opts.model ?? 'test/model'
  let currentThinking: ThinkingLevel = opts.thinking ?? 'provider-default'
  const controller: CoderController & { calls: string[]; shellCalls: string[] } = {
    calls,
    shellCalls,
    config,
    permissions,
    broker,
    workspace: {
      fs: { list: async () => [{ path: '/src/app.ts' }, { path: '/README.md' }] },
    } as never,
    get sessionId() {
      return sessionId
    },
    async run(text, hooks, runOpts) {
      calls.push(`run:${text}`)
      if (runOpts?.files?.length) {
        runFiles.push(runOpts.files)
        calls.push(`files:${runOpts.files.length}`)
      }
      const run = agent.session('s1').send(text)
      hooks.onRun(run as never)
      return (await run.result) as never
    },
    abort: () => {
      calls.push('abort')
      agent.session('s1').abort()
    },
    messages: async () => [],
    messagesOf: async (id) => opts.childMessages?.[id] ?? [],
    compact: async (instructions) => {
      calls.push(`compact:${instructions ?? ''}`)
    },
    clear: async () => {},
    resume: async (id) => {
      calls.push(`resume:${id}`)
      if (id === 'unknown') throw new Error('unknown session')
    },
    sessions: async () => opts.sessions ?? [],
    shell: async (command) => {
      shellCalls.push(command)
      return { output: 'shell out', exitCode: 0 }
    },
    setModel(id, o) {
      calls.push(`setModel:${id}${o?.persist === false ? ':session' : ''}`)
      currentModel = id
    },
    get model() {
      return currentModel
    },
    provider: 'openrouter',
    get thinking() {
      return currentThinking
    },
    setThinking(level, o) {
      calls.push(`setThinking:${level}${o?.persist === false ? ':session' : ''}`)
      currentThinking = level
    },
    models: async () =>
      typeof opts.models === 'function' ? opts.models() : (opts.models ?? FIXTURE_MODELS),
    contextDetails: async () => opts.context ?? FIXTURE_CONTEXT,
    usage: async () => opts.usage ?? FIXTURE_USAGE,
    status: async () => ({
      version: '0.1.0',
      eharnessVersion: '0.9.0',
      cwd: '/work/project',
      provider: 'openrouter',
      model: currentModel,
      thinking: currentThinking,
      mode,
      sessionId: 's1',
      mounts: [
        { virtual: '/', real: '/work/project', readonly: false },
        { virtual: '/@dirs/shared-lib/', real: '/work/shared-lib', readonly: true },
      ],
      trusted: (opts.untrusted ?? []).length === 0,
      untrusted: opts.untrusted ?? [],
      memoryFile: 'AGENTS.md',
      mcpServers: ['github'],
      agents: 2,
      settingsFiles: [
        { path: '/home/me/.coder/settings.json', exists: true },
        { path: '/work/project/.coder/settings.json', exists: true },
        { path: '/work/project/.coder/settings.local.json', exists: false },
      ],
      sandbox: {
        enabled: (settingValues.sandbox as { enabled?: boolean } | undefined)?.enabled ?? false,
        kind: 'seatbelt',
        network: false,
      },
      ...opts.status,
    }),
    async steer(text, hooks) {
      calls.push(`steer:${text}`)
      if (opts.steerAs !== 'turn') return { delivered: 'step' }
      const run = agent.session('s1').send(text)
      hooks.onRun(run as never)
      return { delivered: 'turn', result: (await run.result) as never }
    },
    async history(o) {
      calls.push(`history:${o?.allProjects ? 'all' : 'project'}`)
      return o?.allProjects ? [...(opts.allHistory ?? stored)] : [...stored]
    },
    async addHistory(text) {
      calls.push(`addHistory:${text}`)
      stored.push(text)
    },
    diff: async () => ({ git: false, files: [] }),
    commands: async () => opts.commands ?? [],
    async expandCommand(name, args) {
      calls.push(`expand:${name}:${args}`)
      return `EXPANDED ${name} ${args}`.trim()
    },
    agents: () => [],
    stats: async () => ({ contextTokens: 5000, contextWindow: 100_000, costUsd: 0.5 }),
    close: async () => {},
    async rewindPoints() {
      calls.push('rewindPoints')
      return opts.rewindPoints ?? []
    },
    async rewind(messageId, what) {
      calls.push(`rewind:${messageId}:${what}`)
      const point = (opts.rewindPoints ?? []).find((p) => p.messageId === messageId)
      const result: RewindResult = {
        restoredFiles: what === 'conversation' ? [] : (point?.files ?? []),
        prompt: point?.text ?? '',
        ...(what !== 'code' ? { sessionId: 's2' } : {}),
        ...opts.rewindResult,
      }
      if (result.sessionId) sessionId = result.sessionId
      return result
    },
    async branch(name) {
      calls.push(`branch:${name ?? ''}`)
      sessionId = 's-branch'
      if (name) sessionName = name
      return 's-branch'
    },
    async rename(name) {
      calls.push(`rename:${name}`)
      sessionName = name
    },
    get sessionName() {
      return sessionName
    },
    exportText: async () => opts.exportText ?? 'user: hi\n\nassistant: ok\n',
    async assistantText(n = 1) {
      calls.push(`assistantText:${n}`)
      const list = opts.assistantTexts ?? ['last answer', 'older answer']
      return list[n - 1]
    },
    async sideQuestion(question, onDelta, signal) {
      calls.push(`side:${question}`)
      const chunks = opts.sideChunks ?? ['side answer']
      let all = ''
      for (const chunk of chunks) {
        if (opts.sideDelayMs) await new Promise((r) => setTimeout(r, opts.sideDelayMs))
        if (signal?.aborted) {
          calls.push('side:aborted')
          throw new Error('aborted')
        }
        all += chunk
        onDelta(chunk)
      }
      return all
    },
    recap: async () => opts.recap ?? 'You were fixing the parser.',
    async suggestNext() {
      calls.push('suggestNext')
      return opts.suggestion
    },
    async addDirectory(path) {
      calls.push(`addDirectory:${path}`)
      return `/@dirs/${path.split('/').pop()}/`
    },
    memoryFiles: async () =>
      opts.memoryFiles ?? [
        { path: 'AGENTS.md', real: '/work/project/AGENTS.md', exists: true, scope: 'project' },
        {
          path: '~/.coder/CODER.md',
          real: '/home/me/.coder/CODER.md',
          exists: false,
          scope: 'user',
        },
      ],
    tasks: () => tasks,
    async stopTask(id) {
      calls.push(`stopTask:${id}`)
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: 'stopped', endedAt: Date.now() } : t))
      for (const l of taskListeners) l(tasks)
    },
    async taskOutput(id) {
      calls.push(`taskOutput:${id}`)
      return tasks.find((t) => t.id === id)?.tail ?? ''
    },
    onTasks(listener) {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    settings: async () => settings.map((v) => ({ ...v })),
    async updateSetting(key, value, scope) {
      calls.push(`updateSetting:${key}:${JSON.stringify(value)}:${scope}`)
      const view = settings.find((v) => v.key === key)
      if (view) {
        view.value = value
        view.source = scope
      }
      settingValues[key] = value
      if (key === 'sandbox.enabled') settingValues.sandbox = { enabled: value as boolean }
    },
    setting: ((key: string) => settingValues[key]) as CoderController['setting'],
    outputStyles: async () =>
      opts.outputStyles ?? [
        { name: 'default', description: 'Standard responses' },
        { name: 'concise', description: 'Short answers' },
        { name: 'learning', description: 'Explains as it goes' },
      ],
    doctor: async () =>
      opts.doctor ?? [
        { name: 'Node runtime', status: 'ok', detail: 'bun 1.4.2' },
        { name: 'ripgrep', status: 'warn', detail: 'not installed' },
        { name: 'API key', status: 'error', detail: 'OPENROUTER_API_KEY missing' },
      ],
    statusLineText: async () => undefined,
  }
  const setTasks = (next: BackgroundTask[]): void => {
    tasks = next
    for (const l of taskListeners) l(tasks)
  }
  return { controller, broker, calls, runFiles, setTasks, settingValues }
}
