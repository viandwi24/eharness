import { describe, expect, test } from 'bun:test'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessAgentConfig,
  type HarnessWarning,
} from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { latestTodos, TODOS_INSTRUCTION, todos } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** A summarizer answering `text`, recording its prompts. */
function summarizer(text: string) {
  const prompts: unknown[] = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'summarizer',
    doGenerate: async (call) => {
      prompts.push(call.prompt)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  return Object.assign(model, { prompts })
}

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  storage: NonNullable<HarnessAgentConfig['storage']> = {
    messages: memoryMessages(),
    state: memoryState(),
  },
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage,
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, warnings }
}

const write = (items: Array<[string, string]>) => ({
  toolCalls: [
    {
      toolName: 'todo_write',
      input: { todos: items.map(([content, status]) => ({ content, status })) },
    },
  ],
})

const promptText = (prompt: unknown) => JSON.stringify(prompt)

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) return out
    out.push(next.value)
  }
}

describe('todos plugin', () => {
  test('todo_write returns a compact list, streams data-todos.list and is stored in the message', async () => {
    const model = scriptedModel([
      write([
        ['Read the spec', 'completed'],
        ['Write the code', 'in_progress'],
        ['Run the tests', 'pending'],
      ]),
      { text: 'working' },
    ])
    const { agent } = setup({ model, plugins: [todos()] })
    const run = agent.session('s1').send('build it')
    const chunks = await drain(run.stream)
    const result = await run.result
    expect(promptText(model.calls[0]?.prompt)).toContain(TODOS_INSTRUCTION.slice(0, 40))
    expect(promptText(model.calls[1]?.prompt)).toContain(
      'Todo list updated: 2 open, 1 completed.\\n[x] Read the spec\\n[>] Write the code\\n[ ] Run the tests',
    )
    expect(chunks.filter((c) => c.type === 'data-todos.list')).toHaveLength(1)
    expect(latestTodos(result.messages).map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
    ])
    // the data part is not projected to the model
    expect(promptText(model.calls[1]?.prompt)).not.toContain('data-todos')
  })

  test('two items in progress is an error result; the list is unchanged', async () => {
    const model = scriptedModel([
      write([
        ['a', 'in_progress'],
        ['b', 'in_progress'],
      ]),
      { text: 'oops' },
    ])
    const { agent } = setup({ model, plugins: [todos()] })
    const result = await agent.session('s1').send('go').result
    expect(promptText(model.calls[1]?.prompt)).toContain('ERROR: only one todo may be in_progress')
    expect(latestTodos(result.messages)).toEqual([])
  })

  test('open todos are reminded after remindEvery steps without a todo_write (volatile)', async () => {
    const model = scriptedModel([
      write([['Step one', 'in_progress']]),
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { toolCalls: [{ toolName: 'noop', input: {} }] },
      { text: 'done' },
    ])
    const { tool } = await import('ai')
    const { z } = await import('zod/v4')
    let n = 0
    const noop = tool({ inputSchema: z.object({}), execute: async () => `ok ${n++}` })
    const { agent } = setup({ model, tools: { noop }, plugins: [todos({ remindEvery: 2 })] })
    await agent.session('s1').send('go').result
    expect(promptText(model.calls[2]?.prompt)).not.toContain('Open todos')
    expect(promptText(model.calls[3]?.prompt)).toContain('Open todos (update them with todo_write')
  })

  test('enforce continues while todos are open, until they are done', async () => {
    const model = scriptedModel([
      write([
        ['a', 'in_progress'],
        ['b', 'pending'],
      ]),
      { text: 'I will stop here' },
      write([
        ['a', 'completed'],
        ['b', 'completed'],
      ]),
      { text: 'all done' },
    ])
    const { agent } = setup({ model, plugins: [todos({ enforce: true })] })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(4)
    expect(promptText(model.calls[2]?.prompt)).toContain('You stopped with open todos')
  })

  test('enforce gives up when a nudge changes nothing (no looping)', async () => {
    const model = scriptedModel([
      write([['a', 'in_progress']]),
      { text: 'no' },
      { text: 'still no' },
      { text: 'never' },
      { text: 'x' },
    ])
    const { agent } = setup({ model, plugins: [todos({ enforce: true, maxNudges: 5 })] })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(3) // one nudge, then no change + idle → stop
  })

  test('the list survives a compaction (carried in state) and is reminded once', async () => {
    const summary = summarizer('SUMMARY')
    const model = scriptedModel([
      write([['Ship it', 'in_progress']]),
      { text: 'first answer' },
      { text: 'second answer' },
      { text: 'third answer' },
    ])
    const { agent } = setup({
      model,
      plugins: [todos()],
      compaction: { model: summary, keepLast: 0, maxSummaryTokens: 100 },
    })
    const session = agent.session('s1')
    await session.send('one').result
    await session.send('two').result
    await session.compact()
    expect(promptText(summary.prompts[0])).toContain('[>] Ship it')
    await session.send('three').result
    expect(promptText(model.calls[3]?.prompt)).not.toContain('todo_write","input')
    expect(promptText(model.calls[3]?.prompt)).toContain('Open todos (update them with todo_write')
  })

  test('the list survives a restart followed by a compaction (fresh instance, same storage)', async () => {
    const storage = { messages: memoryMessages(), state: memoryState() }
    const model = scriptedModel([
      write([['Ship it', 'in_progress']]),
      { text: 'first answer' },
      { text: 'second answer' },
      { text: 'third answer' },
    ])
    const first = setup({ model, plugins: [todos()] }, storage)
    await first.agent.session('s1').send('one').result
    await first.agent.session('s1').send('two').result
    await first.agent.close()
    const summary = summarizer('SUMMARY')
    const { agent } = setup(
      {
        model,
        plugins: [todos()],
        compaction: { model: summary, keepLast: 0, maxSummaryTokens: 100 },
      },
      storage,
    )
    const session = agent.session('s1')
    await session.compact()
    expect(promptText(summary.prompts[0])).toContain('[>] Ship it')
    await session.send('three').result
    expect(promptText(model.calls[3]?.prompt)).not.toContain('todo_write","input')
    expect(promptText(model.calls[3]?.prompt)).toContain('[>] Ship it')
  })

  test('a denied todo_write is a failed write: the list is unchanged', async () => {
    const deny = definePlugin({
      name: 'deny',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) =>
            (e.input as { todos: Array<{ content: string }> }).todos.some(
              (t) => t.content === 'Nope',
            )
              ? 'denied'
              : undefined,
        },
      }),
    })
    const model = scriptedModel([
      write([['Ship it', 'in_progress']]),
      write([['Nope', 'in_progress']]),
      { text: 'done' },
    ])
    const { agent } = setup({
      model,
      plugins: [todos({ remindEvery: 1 }), deny],
    })
    await agent.session('s1').send('go').result
    const last = promptText(model.calls[2]?.prompt)
    expect(last).toContain('Open todos (update them with todo_write as you work):\\n[>] Ship it')
    expect(last).not.toContain('[>] Nope')
  })
})
