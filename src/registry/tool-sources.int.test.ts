import { describe, expect, test } from 'bun:test'
import { type Tool, type ToolSet, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import { filesystem } from '../filesystem/index.ts'
import { memoryFs } from '../filesystem/memory.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { spyMessages, spyState } from '../session/int-kit.ts'
import {
  type ScriptedCallOptions,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { defineToolSource } from './tool-source.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(steps: ScriptedStepInput[], config: Partial<HarnessAgentConfig> = {}) {
  const model = scriptedModel(steps)
  const warnings: HarnessWarning[] = []
  const messages = spyMessages()
  const state = spyState()
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, model, warnings, messages, state }
}

function toolNames(call: ScriptedCallOptions | undefined): string[] {
  return (call?.tools ?? []).map((t) => t.name)
}

const echo = (label: string, description = `Echo ${label}.`): Tool =>
  tool({
    description,
    inputSchema: z.object({ text: z.string().optional() }),
    execute: async ({ text }) => `${label}:${text ?? ''}`,
  })

function toolOutputs(message: HarnessUIMessage | undefined): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  for (const part of message?.parts ?? []) {
    if (!part.type.startsWith('tool-')) continue
    const p = part as { type: string; output?: unknown; errorText?: string }
    out.push([p.type.slice(5), p.output ?? p.errorText])
  }
  return out
}

const assistantOf = (result: { messages: HarnessUIMessage[]; messageId?: string }) =>
  result.messages.find((m) => m.id === result.messageId)

describe('tool sources: lifecycle and refresh', () => {
  test('open at session open, list once per session (default), close on session close', async () => {
    const events: string[] = []
    const source = defineToolSource({
      id: 'db:tools',
      open: (ctx) => {
        events.push(`open:${ctx.session.id}`)
      },
      list: () => {
        events.push('list')
        return { lookup: echo('lookup') }
      },
      close: () => {
        events.push('close')
      },
    })
    const { agent, model } = setup([{ text: 'a' }, { text: 'b' }], { tools: [source] })
    const session = agent.session('s1')
    await session.ready()
    expect(events).toEqual(['open:s1'])
    await session.send('one').result
    await session.send('two').result
    expect(events).toEqual(['open:s1', 'list'])
    expect(toolNames(model.calls[0])).toEqual(['lookup'])
    expect(toolNames(model.calls[1])).toEqual(['lookup'])
    await agent.closeSession('s1')
    expect(events).toEqual(['open:s1', 'list', 'close'])
  })

  test("refresh: 'turn' lists before every turn; changes apply at the next turn only", async () => {
    let version = 1
    const source = defineToolSource({
      id: 'db:tools',
      refresh: 'turn',
      list: (): ToolSet => (version === 1 ? { v1: echo('v1') } : { v2: echo('v2') }),
    })
    const { agent, model } = setup(
      [
        () => {
          version = 2 // mid-turn change: not visible in this turn
          return { toolCalls: [{ toolName: 'v1', input: {} }] }
        },
        { text: 'done' },
        { text: 'next' },
      ],
      { tools: [source] },
    )
    const session = agent.session('s1')
    const first = await session.send('one').result
    expect(first.stop).toBe('complete')
    expect(toolNames(model.calls[1])).toEqual(['v1'])
    await session.send('two').result
    expect(toolNames(model.calls[2])).toEqual(['v2'])
  })

  test('a failing list() warns W_TOOL_SOURCE_FAILED, the turn continues, retried next turn', async () => {
    let calls = 0
    const source = defineToolSource({
      id: 'flaky',
      list: () => {
        calls++
        if (calls === 1) throw new Error('down')
        return { lookup: echo('lookup') }
      },
    })
    const { agent, model, warnings } = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }], {
      tools: [source],
    })
    const session = agent.session('s1')
    expect((await session.send('one').result).stop).toBe('complete')
    expect(toolNames(model.calls[0])).toEqual([])
    const failed = warnings.filter((w) => w.code === 'W_TOOL_SOURCE_FAILED')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.message).toContain('down')
    expect(failed[0]?.details?.source).toBe('flaky')
    await session.send('two').result
    await session.send('three').result
    expect(calls).toBe(2) // retried once, then cached for the session
    expect(toolNames(model.calls[1])).toEqual(['lookup'])
    expect(toolNames(model.calls[2])).toEqual(['lookup'])
  })

  test('invalid names, reserved names and collisions are skipped with warnings', async () => {
    const first = defineToolSource({
      id: 'first',
      list: () => ({
        'bad name': echo('bad'),
        tool_search: echo('reserved'),
        load_skill: echo('reserved2'),
        static_one: echo('shadowed'),
        shared: echo('first'),
      }),
    })
    const second = defineToolSource({
      id: 'second',
      list: () => ({ shared: echo('second'), own: echo('own') }),
    })
    const { agent, model, warnings } = setup([{ toolCalls: [{ toolName: 'shared', input: {} }] }], {
      tools: [{ static_one: echo('static') }, first, second],
    })
    const result = await agent.session('s1').send('go').result
    expect(toolNames(model.calls[0])).toEqual(['static_one', 'shared', 'own'])
    expect(toolOutputs(assistantOf(result))).toEqual([['shared', 'first:']])
    expect(warnings.map((w) => [w.code, w.details?.source, w.details?.tool])).toEqual([
      ['W_INVALID_TOOL_NAME', 'first', 'bad name'],
      ['W_SHADOWED', 'first', 'tool_search'],
      ['W_SHADOWED', 'first', 'load_skill'],
      ['W_SHADOWED', 'first', 'static_one'],
      ['W_SHADOWED', 'second', 'shared'],
    ])
  })

  test('defineToolSource validates its options', () => {
    const bad = (def: unknown) => {
      try {
        defineToolSource(def as never)
      } catch (error) {
        return isHarnessError(error, 'EH_CONFIG_INVALID')
      }
      return false
    }
    expect(bad({ id: '', list: () => ({}) })).toBe(true)
    expect(bad({ id: 'x' })).toBe(true)
    expect(bad({ id: 'x', list: () => ({}), refresh: 'always' })).toBe(true)
    expect(bad({ id: 'x', list: () => ({}), defer: 'auto' })).toBe(true)
    expect(bad({ id: 'x', list: () => ({}), close: 1 })).toBe(true)
    expect(bad({ id: 'x', list: () => ({}), defer: true, refresh: 'turn' })).toBe(false)
  })
})

describe('deferred tools and tool_search', () => {
  const catalog = () =>
    defineToolSource({
      id: 'catalog',
      defer: true,
      list: () => ({
        get_invoice: echo('invoice', 'Fetch an invoice by number.'),
        list_customers: echo('customers', 'List customers.'),
      }),
    })

  test('no deferred tool → no tool_search', async () => {
    const { agent, model } = setup([{ text: 'hi' }], { tools: [{ a: echo('a') }] })
    await agent.session('s1').send('go').result
    expect(toolNames(model.calls[0])).toEqual(['a'])
  })

  test('a static tool may not use the reserved name tool_search', () => {
    expect(() =>
      defineHarnessAgent({ model: scriptedModel([]), tools: { tool_search: echo('x') } }),
    ).toThrow()
  })

  test('deferred tools are hidden until tool_search finds them, then callable in later steps and after reload', async () => {
    const steps: ScriptedStepInput[] = [
      { toolCalls: [{ toolName: 'tool_search', input: { query: 'invoice' } }] },
      { toolCalls: [{ toolName: 'get_invoice', input: { text: '42' } }] },
      { toolCalls: [{ toolName: 'a', input: {} }] },
      { toolCalls: [{ toolName: 'get_invoice', input: { text: '43' } }] },
      { text: 'done' },
      { toolCalls: [{ toolName: 'get_invoice', input: { text: '44' } }] },
      { text: 'again' },
    ]
    const { agent, model, messages, state } = setup(steps.slice(0, 5), {
      tools: [{ a: echo('a') }, catalog()],
    })
    const result = await agent.session('s1').send('Find invoice 42').result
    expect(result.stop).toBe('complete')
    // step 0: only non-deferred tools + tool_search (last, stable order)
    expect(toolNames(model.calls[0])).toEqual(['a', 'tool_search'])
    // step 1 and 3: the discovered tool is directly callable
    expect(toolNames(model.calls[1])).toEqual(['a', 'get_invoice', 'tool_search'])
    expect(toolNames(model.calls[3])).toEqual(['a', 'get_invoice', 'tool_search'])
    expect(toolOutputs(assistantOf(result))).toEqual([
      [
        'tool_search',
        { tools: [{ name: 'get_invoice', description: 'Fetch an invoice by number.' }] },
      ],
      ['get_invoice', 'invoice:42'],
      ['a', 'a:'],
      ['get_invoice', 'invoice:43'],
    ])

    // reload: a new agent on the same storage seeds discoveries from the stored tool_search result
    const reloaded = scriptedModel(steps.slice(5))
    const agent2 = defineHarnessAgent({
      model: reloaded,
      contextWindow: 100_000,
      storage: { messages, state },
      logger: silent,
      onWarning: () => {},
      tools: [{ a: echo('a') }, catalog()],
    })
    const next = await agent2.session('s1').send('And 44?').result
    expect(next.stop).toBe('complete')
    expect(toolNames(reloaded.calls[0])).toEqual(['a', 'get_invoice', 'tool_search'])
    expect(toolOutputs(assistantOf(next))).toEqual([['get_invoice', 'invoice:44']])
  })

  test('calling a deferred tool before discovering it is a readable tool error', async () => {
    const { agent } = setup(
      [{ toolCalls: [{ toolName: 'get_invoice', input: {} }] }, { text: 'sorry' }],
      { tools: [catalog()] },
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const [[name, error]] = toolOutputs(assistantOf(result)) as [[string, string]]
    expect(name).toBe('get_invoice')
    expect(typeof error).toBe('string')
  })

  test('tools marked deferLoading by the developer also enable tool_search', async () => {
    const hidden = { ...echo('hidden', 'Hidden helper.'), deferLoading: true } as Tool
    const { agent, model } = setup([{ text: 'ok' }], { tools: { shown: echo('s'), hidden } })
    await agent.session('s1').send('go').result
    expect(toolNames(model.calls[0])).toEqual(['shown', 'tool_search'])
  })
})

describe('tool output limits (spec 09 §4)', () => {
  const big = (n: number) => `${'h'.repeat(n / 2)}${'t'.repeat(n / 2)}`

  test('a 200k-char string is truncated head + tail with W_TOOL_OUTPUT_LIMITED (scenario 32)', async () => {
    const { agent, model, warnings } = setup(
      [{ toolCalls: [{ toolName: 'dump', input: {} }] }, { text: 'ok' }],
      {
        tools: {
          dump: tool({ inputSchema: z.object({}), execute: async () => big(200_000) }),
        },
      },
    )
    const result = await agent.session('s1').send('go').result
    const [[, output]] = toolOutputs(assistantOf(result)) as [[string, string]]
    expect(output.startsWith('h'.repeat(35_000))).toBe(true)
    expect(output.endsWith('t'.repeat(15_000))).toBe(true)
    expect(output).toContain('…[truncated 150000 chars]…')
    expect(output.length).toBeLessThan(50_100)
    const limited = warnings.filter((w) => w.code === 'W_TOOL_OUTPUT_LIMITED')
    expect(limited).toHaveLength(1)
    expect(limited[0]?.details).toMatchObject({
      tool: 'dump',
      originalChars: 200_000,
      maxChars: 50_000,
      strategy: 'truncate',
    })
    // the model wire carries the same truncated text
    expect(JSON.stringify(model.prompts[1])).toContain('…[truncated 150000 chars]…')
  })

  test('structured outputs become { truncated, preview, originalChars }; perTool overrides', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `row-${i}` }))
    const { agent, warnings } = setup(
      [
        {
          toolCalls: [
            { toolName: 'rows', input: {} },
            { toolName: 'free', input: {} },
            { toolName: 'small', input: {} },
          ],
        },
        { text: 'ok' },
      ],
      {
        toolOutput: { maxChars: 1_000, perTool: { free: false, small: 10 } },
        tools: {
          rows: tool({ inputSchema: z.object({}), execute: async () => rows }),
          free: tool({ inputSchema: z.object({}), execute: async () => big(2_000) }),
          small: tool({ inputSchema: z.object({}), execute: async () => 'twelve chars' }),
        },
      },
    )
    const result = await agent.session('s1').send('go').result
    const outputs = Object.fromEntries(toolOutputs(assistantOf(result)))
    const json = JSON.stringify(rows)
    expect(outputs.rows).toEqual({
      truncated: true,
      preview: expect.stringContaining('…[truncated'),
      originalChars: json.length,
    })
    expect((outputs.rows as { preview: string }).preview.startsWith(json.slice(0, 400))).toBe(true)
    expect(outputs.free).toBe(big(2_000))
    expect(outputs.small).toBe('twelve …[truncated 2 chars]…ars')
    expect(
      warnings.filter((w) => w.code === 'W_TOOL_OUTPUT_LIMITED').map((w) => w.details?.tool),
    ).toEqual(expect.arrayContaining(['rows', 'small']))
  })

  test('limits run after tool.after hooks; a limited output bypasses a custom toModelOutput', async () => {
    const seen: unknown[] = []
    const plugin = definePlugin({
      name: 'pad',
      setup: () => ({
        hooks: {
          'tool.after': (_ctx, event) => {
            seen.push(event.output)
            return { output: { wrapped: String(event.output).repeat(100) } }
          },
        },
      }),
    })
    const { agent, model } = setup(
      [{ toolCalls: [{ toolName: 'mcp_like', input: {} }] }, { text: 'ok' }],
      {
        plugins: [plugin],
        toolOutput: { maxChars: 200 },
        tools: {
          mcp_like: tool({
            inputSchema: z.object({}),
            execute: async () => 'abcdef',
            // expects `{ wrapped }`; would throw on the limited form
            toModelOutput: ({ output }) => ({
              type: 'text',
              value: (output as unknown as { wrapped: string }).wrapped.toUpperCase(),
            }),
          }),
        },
      },
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(seen).toEqual(['abcdef'])
    const [[, output]] = toolOutputs(assistantOf(result)) as [[string, { truncated: boolean }]]
    expect(output.truncated).toBe(true)
    expect(JSON.stringify(model.prompts[1])).toContain('"truncated":true')
  })

  test('evict without a toolOutputs service falls back to truncate', async () => {
    const { agent, warnings } = setup(
      [{ toolCalls: [{ toolName: 'dump', input: {} }] }, { text: 'ok' }],
      {
        toolOutput: { maxChars: 100, strategy: 'evict' },
        tools: { dump: tool({ inputSchema: z.object({}), execute: async () => big(1_000) }) },
      },
    )
    const result = await agent.session('s1').send('go').result
    const [[, output]] = toolOutputs(assistantOf(result)) as [[string, string]]
    expect(output).toContain('…[truncated 900 chars]…')
    expect(output).not.toContain('Full output saved')
    expect(warnings.find((w) => w.code === 'W_TOOL_OUTPUT_LIMITED')?.details?.strategy).toBe(
      'truncate',
    )
  })

  test('evict with a toolOutputs service stores the full text and points the model to it', async () => {
    const stored = new Map<string, string>()
    const outputsPlugin = definePlugin({
      name: 'outs',
      provides: ['toolOutputs'],
      session: () => ({
        services: {
          toolOutputs: {
            put: async (id: string, text: string) => {
              stored.set(id, text)
              return `/.eharness/tool-outputs/${id}.txt`
            },
          },
        } as never,
      }),
    })
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    const { agent, warnings } = setup(
      [
        {
          toolCalls: [
            { toolName: 'dump', input: {}, toolCallId: 'c1' },
            { toolName: 'rows', input: {}, toolCallId: 'c2' },
          ],
        },
        { text: 'ok' },
      ],
      {
        plugins: [outputsPlugin],
        toolOutput: { maxChars: 100, strategy: 'evict' },
        tools: {
          dump: tool({ inputSchema: z.object({}), execute: async () => big(1_000) }),
          rows: tool({ inputSchema: z.object({}), execute: async () => rows }),
        },
      },
    )
    const result = await agent.session('s1').send('go').result
    const outputs = Object.fromEntries(toolOutputs(assistantOf(result)))
    expect(stored.get('c1')).toBe(big(1_000))
    expect(JSON.parse(stored.get('c2') ?? '')).toEqual(rows)
    expect(outputs.dump).toContain('…[truncated 900 chars]…')
    expect(outputs.dump).toContain(
      'Full output saved to /.eharness/tool-outputs/c1.txt; use read_file with offset/limit to see more.',
    )
    expect(outputs.rows).toMatchObject({
      truncated: true,
      note: 'Full output saved to /.eharness/tool-outputs/c2.txt; use read_file with offset/limit to see more.',
    })
    expect(
      warnings.filter((w) => w.code === 'W_TOOL_OUTPUT_LIMITED').map((w) => w.details?.strategy),
    ).toEqual(['evict', 'evict'])
  })

  test('evict + filesystem: the full text is readable via read_file (scenario 32)', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')
    let path = ''
    const { agent, warnings } = setup(
      [
        { toolCalls: [{ toolName: 'dump', input: {}, toolCallId: 'call_9' }] },
        (call) => {
          const text = JSON.stringify(call.prompt)
          path = /Full output saved to (\S+);/.exec(text)?.[1] ?? ''
          return { toolCalls: [{ toolName: 'read_file', input: { path, offset: 399, limit: 2 } }] }
        },
        { text: 'ok' },
      ],
      {
        plugins: [filesystem({ fs: memoryFs() })],
        toolOutput: { maxChars: 500, strategy: 'evict' },
        tools: { dump: tool({ inputSchema: z.object({}), execute: async () => lines }) },
      },
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(path.startsWith('/.eharness/tool-outputs/call_9')).toBe(true)
    const outputs = toolOutputs(assistantOf(result))
    expect(outputs[1]).toEqual(['read_file', '   399\tline 399\n   400\tline 400'])
    expect(warnings.find((w) => w.code === 'W_TOOL_OUTPUT_LIMITED')?.details?.strategy).toBe(
      'evict',
    )
  })

  test('a full default read_file window is not cut by the default output limit', async () => {
    const content = Array.from({ length: 20_000 }, (_, i) => `row ${i} ${'x'.repeat(30)}`).join(
      '\n',
    )
    const { agent, warnings } = setup(
      [
        { toolCalls: [{ toolName: 'read_file', input: { path: '/big.txt', limit: 2000 } }] },
        { text: 'ok' },
      ],
      { plugins: [filesystem({ fs: memoryFs({ '/big.txt': content }) })] },
    )
    const result = await agent.session('s1').send('go').result
    const [[, output]] = toolOutputs(assistantOf(result)) as [[string, string]]
    expect(output).toContain('Continue with offset=')
    expect(output).not.toContain('…[truncated')
    expect(warnings.some((w) => w.code === 'W_TOOL_OUTPUT_LIMITED')).toBe(false)
  })

  test('preliminary outputs are not limited; the final one is, and addUsage counts nested usage', async () => {
    const subagent = definePlugin({
      name: 'sub',
      session: (ctx) => ({
        tools: {
          child: tool({
            inputSchema: z.object({}),
            async *execute() {
              yield { status: 'working', log: 'x'.repeat(500) }
              ctx.turn?.addUsage({
                inputTokens: 30,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: undefined,
                },
                outputTokens: 20,
                outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
                totalTokens: 50,
              })
              yield { status: 'done', log: 'y'.repeat(500) }
            },
          }),
        },
      }),
    })
    const { agent } = setup([{ toolCalls: [{ toolName: 'child', input: {} }] }, { text: 'ok' }], {
      plugins: [subagent],
      toolOutput: { maxChars: 100 },
    })
    const run = agent.session('s1').send('go')
    const outputs: Array<{ output: unknown; preliminary?: boolean }> = []
    for await (const chunk of run.stream) {
      if (chunk.type === 'tool-output-available') {
        outputs.push({
          output: chunk.output,
          ...(chunk.preliminary === true ? { preliminary: true } : {}),
        })
      }
    }
    const result = await run.result
    expect(outputs.slice(0, 2)).toEqual([
      { output: { status: 'working', log: 'x'.repeat(500) }, preliminary: true },
      { output: { status: 'done', log: 'y'.repeat(500) }, preliminary: true },
    ])
    expect(outputs.at(-1)?.preliminary).toBeUndefined()
    expect(outputs.at(-1)?.output).toMatchObject({ truncated: true })
    const [[, stored]] = toolOutputs(assistantOf(result)) as [[string, { truncated: boolean }]]
    expect(stored.truncated).toBe(true)
    expect(assistantOf(result)?.metadata?.eharness?.usage?.nested).toBe(50)
  })
})

describe('timeouts and repair (spec 09 §5)', () => {
  const slow = tool({
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 2_000)
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(abortSignal.reason ?? new Error('aborted'))
        })
      }),
  })

  test('settings.timeout.toolMs turns a slow tool into a readable tool error', async () => {
    const { agent, model } = setup(
      [{ toolCalls: [{ toolName: 'slow', input: {} }] }, { text: 'gave up' }],
      { tools: { slow }, settings: { timeout: { toolMs: 30 } } },
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const [[, error]] = toolOutputs(assistantOf(result)) as [[string, string]]
    expect(typeof error).toBe('string')
    expect(error.length).toBeGreaterThan(0)
    expect(JSON.stringify(model.prompts[1])).toContain('error')
  })

  test('per-tool timeout settings.timeout.tools.<name>Ms', async () => {
    const quick = tool({ inputSchema: z.object({}), execute: async () => 'fast' })
    const { agent } = setup(
      [
        {
          toolCalls: [
            { toolName: 'slow', input: {} },
            { toolName: 'quick', input: {} },
          ],
        },
        { text: 'ok' },
      ],
      { tools: { slow, quick }, settings: { timeout: { tools: { slowMs: 30 } } } },
    )
    const result = await agent.session('s1').send('go').result
    const outputs = Object.fromEntries(toolOutputs(assistantOf(result)))
    expect(outputs.quick).toBe('fast')
    expect(typeof outputs.slow).toBe('string')
    expect(outputs.slow).not.toBe('late')
  })

  test('config.repairToolCall fixes a malformed call; without it the model reads the error', async () => {
    const add = tool({
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    })
    const steps: ScriptedStepInput[] = [
      { toolCalls: [{ toolName: 'add', input: { a: '1', b: 2 } }] },
      { text: 'done' },
    ]
    const repaired = setup(steps, {
      tools: { add },
      repairToolCall: async ({ toolCall }) => ({
        ...toolCall,
        input: JSON.stringify({ a: 1, b: 2 }),
      }),
    })
    const ok = await repaired.agent.session('s1').send('go').result
    expect(toolOutputs(assistantOf(ok))).toEqual([['add', 3]])

    const plain = setup(steps, { tools: { add } })
    const failed = await plain.agent.session('s1').send('go').result
    expect(failed.stop).toBe('complete')
    const [[, error]] = toolOutputs(assistantOf(failed)) as [[string, string]]
    expect(typeof error).toBe('string')
    expect(JSON.stringify(plain.model.prompts[1])).toContain('error')
  })
})
