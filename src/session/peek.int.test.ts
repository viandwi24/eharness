import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup() {
  const storage = { messages: inMemoryMessages(), state: inMemoryState() }
  const starts: string[] = []
  const plugin = definePlugin({
    name: 'starts',
    setup: () => ({ hooks: { 'session.start': (ctx) => void starts.push(ctx.session.id) } }),
  })
  const make = () =>
    defineHarnessAgent({
      model: scriptedModel([{ text: 'one' }, { text: 'two' }]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      plugins: [plugin],
    })
  return { storage, starts, make }
}

describe('agent.peek', () => {
  test('reads messages, stats and children without running session.start hooks', async () => {
    const { storage, starts, make } = setup()
    const writer = make()
    await writer.session('p').send('hello').result
    await writer
      .session('c', {
        parent: {
          sessionId: 'p',
          turnId: 't',
          depth: 1,
          agent: 'worker',
          name: 'w1',
          description: 'd',
        },
      })
      .ready()
    await writer.close()
    starts.length = 0

    const reader = make()
    const peek = reader.peek('p')
    const messages = await peek.messages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const stats = await peek.stats()
    expect(stats.pending).toBeNull()
    expect(stats.activeTurn).toBeNull()
    expect(stats.usage.turns).toBeGreaterThanOrEqual(0)
    expect(await peek.busy()).toBeNull()
    expect(await peek.pendingWaits()).toEqual([])
    expect(await peek.children()).toEqual([
      expect.objectContaining({ sessionId: 'c', agent: 'worker', name: 'w1', description: 'd' }),
    ])
    expect(await reader.peek('c').parentInfo()).toMatchObject({ sessionId: 'p', agent: 'worker' })
    // nothing was opened, nothing written
    expect(starts).toEqual([])
    const before = (await storage.state.get('p'))?.rev
    await peek.stats()
    expect((await storage.state.get('p'))?.rev).toBe(before)
    await reader.close()
  })

  test('turn operations throw a clear error; a missing session reads as empty', async () => {
    const { make } = setup()
    const agent = make()
    const peek = agent.peek('missing') as unknown as Record<string, () => unknown>
    expect(() => peek.send?.()).toThrow(/read-only/)
    expect(() => peek.respond?.()).toThrow(/agent\.session/)
    expect(await agent.peek('missing').messages()).toEqual([])
    expect((await agent.peek('missing').stats()).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    })
    expect(await agent.peek('missing').children()).toEqual([])
    await agent.close()
  })

  test('busy() reports a local turn of a live handle', async () => {
    const { make } = setup()
    const agent = make()
    const run = agent.session('p').send('go')
    expect((await agent.peek('p').busy())?.scope).toBe('local')
    await run.result
    expect(await agent.peek('p').busy()).toBeNull()
    await agent.close()
  })
})
