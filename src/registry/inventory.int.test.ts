import { describe, expect, test } from 'bun:test'
import { type Tool, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { spyMessages, spyState } from '../session/int-kit.ts'
import { type ScriptedStepInput, scriptedModel } from '../testing/scripted-model.ts'
import { defineToolSource } from './tool-source.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(steps: ScriptedStepInput[], config: Partial<HarnessAgentConfig> = {}) {
  const model = scriptedModel(steps)
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: spyMessages(), state: spyState() },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, model, warnings }
}

const echo = (label: string): Tool =>
  tool({
    description: `Echo ${label}.`,
    inputSchema: z.object({ text: z.string().optional() }),
    execute: async ({ text }) => `${label}:${text ?? ''}`,
  })

const names = (calls: Array<{ tools?: Array<{ name: string }> } | undefined>, i: number) =>
  (calls[i]?.tools ?? []).map((t) => t.name)

const files = definePlugin({
  name: 'files',
  setup: () => ({
    instructions: 'Files plugin instructions.',
    tools: { read: echo('read'), write: echo('write') },
  }),
})
const mcp = defineToolSource({ id: 'mcp:github', list: () => ({ gh_issue: echo('gh_issue') }) })
const lazy = defineToolSource({
  id: 'mcp:lazy',
  defer: true,
  list: () => ({ lazy_a: echo('lazy_a') }),
})
const skill = { name: 'deploy', description: 'How to deploy.', content: 'Deploy steps.' }

describe('session.tools() (R14)', () => {
  test('request order, sources, deferred flag, tokens, schema', async () => {
    const { agent, model } = setup([{ text: 'ok' }], {
      instructions: 'App instructions.',
      tools: { app_tool: echo('app'), ...{} },
      plugins: [files],
      skills: [skill],
      mcp: [mcp, lazy],
    })
    const session = agent.session('s1')
    const tools = await session.tools()
    expect(tools.map((t) => [t.name, t.source, t.deferred])).toEqual([
      ['app_tool', 'app', false],
      ['read', 'plugin:files', false],
      ['write', 'plugin:files', false],
      ['load_skill', 'core', false],
      ['read_skill_file', 'core', false],
      ['gh_issue', 'source:mcp:github', false],
      ['lazy_a', 'source:mcp:lazy', true],
      ['tool_search', 'core', false],
    ])
    expect(tools[0]?.description).toBe('Echo app.')
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' })
    for (const t of tools) expect(t.tokens).toBeGreaterThan(0)
    // the same order the model sees
    await session.send('hi').result
    // deferred tools stay hidden from the provider until discovered
    expect(names(model.calls, 0)).toEqual(tools.filter((t) => !t.deferred).map((t) => t.name))
  })

  test('turn-refresh sources are listed on every call, session sources once', async () => {
    let turnLists = 0
    let sessionLists = 0
    const perTurn = defineToolSource({
      id: 'dyn',
      refresh: 'turn',
      list: () => {
        turnLists++
        return { dyn_tool: echo('dyn') }
      },
    })
    const perSession = defineToolSource({
      id: 'stable',
      list: () => {
        sessionLists++
        return { stable_tool: echo('stable') }
      },
    })
    const { agent } = setup([], { mcp: [perTurn, perSession] })
    const session = agent.session('s1')
    await session.tools()
    await session.tools()
    expect([turnLists, sessionLists]).toEqual([2, 1])
  })
})

describe('ContextStats blocks (R15)', () => {
  test('instructionBlocks and toolSources sum to the totals, idle and in a turn', async () => {
    const { agent } = setup([{ text: 'ok' }], {
      instructions: [
        'App static instructions.',
        { text: () => 'App session instructions.', refresh: 'session' },
        { text: () => 'App turn reminder.', refresh: 'turn' },
      ],
      tools: { app_tool: echo('app') },
      plugins: [files],
      skills: [skill],
      mcp: [mcp],
    })
    const session = agent.session('s1')
    const check = (stats: Awaited<ReturnType<typeof session.stats>>) => {
      const blocks = stats.instructionBlocks ?? []
      const sources = stats.toolSources ?? []
      expect(blocks.map((b) => [b.owner, b.refresh])).toEqual([
        ['app', 'static'],
        ['files', 'static'],
        ['core:skills', 'static'],
        ['app', 'session'],
        ['app', 'turn'],
      ])
      expect(
        Math.abs(blocks.reduce((n, b) => n + b.tokens, 0) - stats.instructions),
      ).toBeLessThanOrEqual(blocks.length)
      expect(sources.map((s) => [s.source, s.tools])).toEqual([
        ['app', 1],
        ['plugin:files', 2],
        ['core', 2],
        ['source:mcp:github', 1],
      ])
      expect(sources.reduce((n, s) => n + s.tokens, 0)).toBeGreaterThanOrEqual(stats.tools)
      expect(sources.reduce((n, s) => n + s.tokens, 0) - stats.tools).toBeLessThanOrEqual(
        sources.length,
      )
    }
    check(await session.stats())
    const run = session.send('hi')
    const contexts: Array<Awaited<ReturnType<typeof session.stats>>> = []
    for await (const chunk of run.stream) {
      if (chunk.type === 'data-eh.context') contexts.push(chunk.data as never)
    }
    expect(contexts.length).toBeGreaterThan(0)
    check(contexts[0] as never)
  })
})

describe('config.toolOrder (R12)', () => {
  test('listed names first, the rest in default order; unknown names warn once', async () => {
    const { agent, model, warnings } = setup([{ text: 'a' }, { text: 'b' }], {
      tools: { app_tool: echo('app') },
      plugins: [files],
      mcp: [mcp],
      toolOrder: ['gh_issue', 'write', 'nope', 'app_tool'],
    })
    const session = agent.session('s1')
    expect((await session.tools()).map((t) => t.name)).toEqual([
      'gh_issue',
      'write',
      'app_tool',
      'read',
    ])
    await session.send('one').result
    await session.send('two').result
    expect(names(model.calls, 0)).toEqual(['gh_issue', 'write', 'app_tool', 'read'])
    expect(names(model.calls, 1)).toEqual(['gh_issue', 'write', 'app_tool', 'read'])
    const orderWarnings = warnings.filter((w) => w.code === 'W_TOOL_ORDER')
    expect(orderWarnings).toHaveLength(1)
    expect(orderWarnings[0]?.details).toEqual({ tools: ['nope'] })
  })
})

describe('addUsage with plain usage (R8)', () => {
  test('accepts the TurnResult usage shape; costUsd counts', async () => {
    const sub = definePlugin({
      name: 'sub',
      session: (ctx) => ({
        tools: {
          run_sub: tool({
            inputSchema: z.object({}),
            execute: async () => {
              ctx.turn?.addUsage({
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                cachedInputTokens: 10,
                reasoningTokens: 5,
                costUsd: 0.25,
              })
              ctx.turn?.addUsage({ inputTokens: 1, outputTokens: 1 }, { costUsd: 0.05 })
              return 'done'
            },
          }),
        },
      }),
    })
    const { agent } = setup([{ toolCalls: [{ toolName: 'run_sub', input: {} }] }, { text: 'ok' }], {
      plugins: [sub],
    })
    const result = await agent.session('s1').send('go').result
    expect(result.usage.costUsd).toBeCloseTo(0.3, 5)
  })
})

describe('reasoning duration (R20)', () => {
  test('reasoning-end carries providerMetadata.eharness.durationMs, stored and not sent to the model', async () => {
    const { agent, model } = setup(
      [{ reasoning: 'thinking', text: 'answer', delayMs: 15 }, { text: 'again' }],
      {},
    )
    const session = agent.session('s1')
    const run = session.send('hi')
    let end: { providerMetadata?: { eharness?: { durationMs?: number } } } | undefined
    for await (const chunk of run.stream) {
      if (chunk.type === 'reasoning-end') end = chunk as never
    }
    const result = await run.result
    expect(end?.providerMetadata?.eharness?.durationMs).toBeGreaterThanOrEqual(10)
    const assistant = result.messages.find((m: HarnessUIMessage) => m.role === 'assistant')
    const part = assistant?.parts.find((p) => p.type === 'reasoning') as
      | { providerMetadata?: { eharness?: { durationMs?: number } } }
      | undefined
    expect(part?.providerMetadata?.eharness?.durationMs).toBeGreaterThanOrEqual(10)
    await session.send('next').result
    expect(JSON.stringify(model.prompts[1])).not.toContain('durationMs')
  })
})
