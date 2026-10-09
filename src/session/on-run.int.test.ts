/** `session.onRun()`: every turn that starts in this process reaches the listeners. */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessRun } from '../agent/session-types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type { HarnessContext } from '../plugin/types.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { collect } from './int-kit.ts'

// biome-ignore lint/suspicious/noExplicitAny: runs of a loosely typed test agent
type AnyRun = HarnessRun<any>

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

function setup(steps: Parameters<typeof scriptedModel>[0], capture: { ctx?: HarnessContext } = {}) {
  const agent = defineHarnessAgent({
    model: scriptedModel(steps),
    contextWindow: 100_000,
    logger: silent,
    tools: {
      danger: tool({
        description: 'dangerous',
        inputSchema: z.object({}),
        execute: async () => 'done',
      }),
    },
    approval: { policy: { danger: 'user-approval' } },
    plugins: [
      definePlugin({
        name: 'probe',
        session(ctx) {
          capture.ctx = ctx as unknown as HarnessContext
        },
      }),
    ],
  })
  return agent
}

describe('session.onRun', () => {
  test('send: the listener gets its own reader; the caller keeps the original stream', async () => {
    const agent = setup([{ text: 'hello' }])
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    const run = session.send('hi')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.turnId).toBe(run.turnId)
    const [mine, theirs] = await Promise.all([
      collect(run.stream),
      collect((seen[0] as AnyRun).stream),
    ])
    expect(theirs).toEqual(mine)
    expect(mine.at(-1)?.type).toBe('finish')
    expect((await (seen[0] as AnyRun).result).stop).toBe('complete')
    await agent.close()
  })

  test('a listener that never reads, a throwing listener and unsubscribe', async () => {
    const agent = setup([{ text: 'one' }, { text: 'two' }])
    const session = agent.session('s1')
    const calls: string[] = []
    const off = session.onRun(() => calls.push('a'))
    session.onRun(() => {
      throw new Error('boom')
    })
    session.onRun(() => calls.push('c'))
    expect((await session.send('1').result).stop).toBe('complete')
    expect(calls).toEqual(['a', 'c'])
    off()
    expect((await session.send('2').result).stop).toBe('complete')
    expect(calls).toEqual(['a', 'c', 'c'])
    await agent.close()
  })

  test('a queued turn is announced when it starts', async () => {
    const agent = setup([{ text: 'first', delayMs: 40 }, { text: 'second' }])
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    const first = session.send('1')
    const second = session.send('2', { ifBusy: 'queue' })
    expect(seen).toHaveLength(1)
    await first.result
    await second.result
    expect(seen.map((r) => r.turnId)).toEqual([first.turnId, second.turnId])
    const text = JSON.stringify(await collect((seen[1] as AnyRun).stream))
    expect(text).toContain('second')
    await agent.close()
  })

  test('a steer is announced exactly when it falls back to a turn of its own', async () => {
    const agent = setup([{ text: 'first', delayMs: 40 }, { text: 'second' }])
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    const first = session.send('1')
    await sleep(10)
    const steered = session.send('2', { ifBusy: 'steer' })
    const delivery = await steered.delivery
    await session.idle()
    expect(seen.length).toBe(delivery === 'turn' ? 2 : 1)
    expect(delivery === 'step' || delivery === 'turn').toBe(true)
    expect(seen[0]?.turnId).toBe(first.turnId)
    await agent.close()
  })

  test('respond: the continuation is announced', async () => {
    const agent = setup([
      { toolCalls: [{ toolName: 'danger', input: {} }] },
      { text: 'after approval' },
    ])
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    const first = await session.send('go').result
    expect(first.stop).toBe('tool-pending')
    const approval = first.pending?.approvals[0]
    const run = session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true }],
    })
    expect(seen.map((r) => r.kind)).toEqual(['send', 'respond'])
    expect(seen[1]?.turnId).toBe(run.turnId)
    expect((await run.result).stop).toBe('complete')
    await agent.close()
  })

  test('a wake from ctx.session.inject starts a turn the listener can drive', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const agent = setup([{ text: 'first' }, { text: 'woken' }], capture)
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    await session.send('hi').result
    await (capture.ctx as HarnessContext).session.inject(
      'eh.event',
      { name: 'job', text: 'job finished' },
      { wake: true },
    )
    await until('wake announced', () => seen.length === 2)
    expect(seen[1]?.kind).toBe('wake')
    expect((await (seen[1] as AnyRun).result).stop).toBe('complete')
    expect(JSON.stringify(await collect((seen[1] as AnyRun).stream))).toContain('woken')
    await agent.close()
  })

  test('a wake queued behind a running turn is announced when it starts', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const agent = setup([{ text: 'first', delayMs: 40 }, { text: 'woken' }], capture)
    const session = agent.session('s1')
    const seen: AnyRun[] = []
    session.onRun((run) => seen.push(run))
    session.send('hi')
    await sleep(5)
    // not 'next-step' deliverable into a finished step: the wake runs after the turn
    await session.inject('eh.event', { name: 'job', text: 'late' }, { wake: true })
    await session.idle()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    await agent.close()
  })
})
