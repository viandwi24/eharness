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
  PermissionEngine,
  PermissionMode,
  PermissionRules,
  SessionSummary,
} from '../src/contracts.ts'
import { MODE_CYCLE } from '../src/contracts.ts'

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
    model: 'test/model',
    mode,
    contextWindow: 100_000,
    resume: opts.resume,
    untrusted: opts.untrusted ?? [],
    trusted: (opts.untrusted ?? []).length === 0,
  } as unknown as CoderConfig
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
    setModel: () => {},
    agents: () => [],
    stats: async () => ({ contextTokens: 5000, contextWindow: 100_000, costUsd: 0.5 }),
    close: async () => {},
  }
  return { controller, broker, calls }
}
