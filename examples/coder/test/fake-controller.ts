/** An in-memory `CoderController` for the render tests, backed by a real eharness session. */
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod/v4'
import type {
  ApprovalAnswer,
  ApprovalBroker,
  ApprovalRequest,
  CoderConfig,
  CoderController,
  CoderMessage,
  ContextDetails,
  ModelOption,
  PermissionEngine,
  PermissionMode,
  PermissionRules,
  SessionSummary,
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
  push(request: ApprovalRequest): void
} {
  let queue: ApprovalRequest[] = []
  const listeners = new Set<(p: ApprovalRequest[]) => void>()
  const answers: Array<{ id: string; answer: ApprovalAnswer }> = []
  return {
    answers,
    ask: () => new Promise(() => {}),
    pending: () => queue,
    answer(id, answer) {
      answers.push({ id, answer })
      queue = queue.filter((r) => r.id !== id)
      for (const l of listeners) l(queue)
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    push(request) {
      queue = [...queue, request]
      for (const l of listeners) l(queue)
    },
  }
}

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
}

export function fakeController(opts: FakeOptions = {}) {
  const broker = fakeBroker()
  const calls: string[] = []
  const shellCalls: string[] = []
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
    sessionId: 's1',
    async run(text, hooks) {
      calls.push(`run:${text}`)
      const run = agent.session('s1').send(text)
      hooks.onRun(run as never)
      return (await run.result) as never
    },
    abort: () => void calls.push('abort'),
    messages: async () => [],
    messagesOf: async (id) => opts.childMessages?.[id] ?? [],
    compact: async () => {},
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
    setModel(id) {
      calls.push(`setModel:${id}`)
      currentModel = id
    },
    get model() {
      return currentModel
    },
    provider: 'openrouter',
    get thinking() {
      return currentThinking
    },
    setThinking(level) {
      calls.push(`setThinking:${level}`)
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
      ...opts.status,
    }),
    agents: () => [],
    stats: async () => ({ contextTokens: 5000, contextWindow: 100_000, costUsd: 0.5 }),
    close: async () => {},
  }
  return { controller, broker, calls }
}
