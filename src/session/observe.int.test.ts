import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { ObserveEvent } from '../agent/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { defineToolSource } from '../registry/tool-source.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(events: ObserveEvent[], extra: Record<string, unknown> = {}) {
  return defineHarnessAgent({
    model: scriptedModel([
      { toolCalls: [{ toolName: 'echo', input: { text: 'hi' } }] },
      { text: 'done' },
    ]),
    contextWindow: 100_000,
    storage: { messages: spyMessages(), state: spyState() },
    logger: silent,
    onWarning: () => {},
    observe: (event) => events.push(event),
    tools: {
      echo: tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => text,
      }),
    },
    ...extra,
  })
}

describe('observe (spec 10 §8)', () => {
  test('reports phase spans of a turn', async () => {
    const events: ObserveEvent[] = []
    const agent = setup(events, {
      plugins: [
        definePlugin({ name: 'p', setup: () => ({ hooks: { 'turn.prepare': () => undefined } }) }),
      ],
    })
    await agent.session('s1').send('go').result
    const spans = events.filter((e) => e.type === 'span')
    const names = new Set(spans.map((e) => e.name))
    for (const name of [
      'turn.prepare',
      'state.write',
      'message.write',
      'model.call',
      'tool.execute',
    ]) {
      expect(names.has(name as never)).toBe(true)
    }
    expect(spans.filter((e) => e.name === 'model.call').map((e) => e.step)).toEqual([0, 1])
    const toolSpan = spans.find((e) => e.name === 'tool.execute')
    expect(toolSpan?.tool).toBe('echo')
    expect(toolSpan?.ok).toBe(true)
    for (const span of spans) {
      expect(span.sessionId).toBe('s1')
      expect(span.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  test('a failing hook is counted; a throwing observer is ignored', async () => {
    const events: ObserveEvent[] = []
    const agent = setup(events, {
      plugins: [
        definePlugin({
          name: 'bad',
          setup: () => ({
            hooks: {
              'turn.prepare': () => {
                throw new Error('boom')
              },
            },
          }),
        }),
      ],
      observe: (event: ObserveEvent) => {
        events.push(event)
        throw new Error('observer bug')
      },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const failed = events.filter((e) => e.type === 'count' && e.name === 'hook.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ hook: 'turn.prepare', owner: 'bad', sessionId: 's1' })
    expect(events.some((e) => e.type === 'count' && e.name === 'warning')).toBe(true)
  })

  test('a hook that times out is counted as hook.timeout', async () => {
    const events: ObserveEvent[] = []
    const agent = setup(events, {
      hooks: { timeoutMs: 20 },
      plugins: [
        definePlugin({
          name: 'slow',
          setup: () => ({ hooks: { 'turn.prepare': () => new Promise<undefined>(() => {}) } }),
        }),
      ],
    })
    await agent.session('s1').send('go').result
    expect(events.some((e) => e.type === 'count' && e.name === 'hook.timeout')).toBe(true)
    expect(
      events.some((e) => e.type === 'span' && e.name === 'turn.prepare' && e.ok === false),
    ).toBe(true)
  })

  test('a tool source in backoff is counted per skipped turn', async () => {
    const events: ObserveEvent[] = []
    const failing = defineToolSource({
      id: 'flaky',
      refresh: 'turn',
      list: async () => {
        throw new Error('down')
      },
    })
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'a' }, { text: 'b' }]),
      contextWindow: 100_000,
      storage: { messages: spyMessages(), state: spyState() },
      logger: silent,
      onWarning: () => {},
      observe: (event) => events.push(event),
      tools: [failing],
      toolSources: { retryAfterMs: 60_000 },
    })
    const session = agent.session('s1')
    await session.send('one').result
    await session.send('two').result
    const skipped = events.filter((e) => e.type === 'count' && e.name === 'tool-source.backoff')
    expect(skipped.length).toBeGreaterThanOrEqual(1)
    expect(skipped[0]).toMatchObject({ source: 'flaky' })
  })
})
