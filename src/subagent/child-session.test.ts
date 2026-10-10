import { describe, expect, test } from 'bun:test'
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessAgent,
  type SessionOptions,
  type StateAdapter,
} from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { pendingSubagentApprovals, type SubagentChildInfo, subagents } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
type Storage = { messages: ReturnType<typeof memoryMessages>; state: StateAdapter }
const shared = (): Storage => ({ messages: memoryMessages(), state: memoryState() })
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const call = (n: number, extra: Record<string, unknown> = {}) => ({
  toolName: 'agent',
  toolCallId: `c${n}`,
  input: { subagent_type: 'worker', description: `task ${n}`, prompt: 'go', ...extra },
})

function build(
  options: {
    calls: number
    name?: boolean
    childSession?: (info: SubagentChildInfo) => Omit<SessionOptions, 'parent'> | undefined
    maxChildren?: number
  },
  seen: { runtime?: unknown; parent?: unknown } = {},
) {
  const storage = shared()
  const spy = definePlugin({
    name: 'spy',
    setup: () => ({
      hooks: {
        'session.start': (ctx) => {
          seen.runtime = ctx.runtime
          seen.parent = ctx.session.parent
        },
      },
    }),
  })
  const worker = defineHarnessAgent({
    model: scriptedModel(Array.from({ length: 6 }, () => ({ text: 'report' }))),
    contextWindow: 100_000,
    storage,
    logger: silent,
    plugins: [spy],
  }) as Agent
  const steps = [
    {
      toolCalls: Array.from({ length: options.calls }, (_, i) =>
        call(i + 1, options.name === true ? { name: `w${i + 1}` } : {}),
      ),
    },
    { text: 'done' },
  ]
  const main = defineHarnessAgent({
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage,
    logger: silent,
    plugins: [
      subagents({
        agents: { worker: { agent: worker, description: 'does work' } },
        approvals: 'inline',
        answer: () => ({ approved: true }),
        ...(options.childSession === undefined ? {} : { childSession: options.childSession }),
        ...(options.maxChildren === undefined ? {} : { maxChildren: options.maxChildren }),
      }),
    ] as never,
  }) as Agent
  return { storage, main, worker }
}

describe('childSession and child identity', () => {
  test('childSession options reach the child; ctx.session.parent carries agent and name', async () => {
    const seen: { runtime?: Record<string, unknown>; parent?: Record<string, unknown> } = {}
    const infos: SubagentChildInfo[] = []
    const { main } = build(
      {
        calls: 1,
        name: true,
        childSession: (info) => {
          infos.push(info)
          return { runtime: { workspaceId: 'ws1' } }
        },
      },
      seen,
    )
    const session = main.session('p1')
    await session.send('go').result
    expect(infos[0]).toEqual({ parentSessionId: 'p1', agent: 'worker', name: 'w1', depth: 1 })
    expect(seen.runtime?.workspaceId).toBe('ws1')
    expect(seen.parent).toMatchObject({
      sessionId: 'p1',
      agent: 'worker',
      name: 'w1',
      description: 'task 1',
    })
    // the child index carries the identity, a read through peek needs no session open
    expect(await main.peek('p1').children()).toEqual([
      expect.objectContaining({ agent: 'worker', name: 'w1', description: 'task 1' }),
    ])
    expect(await pendingSubagentApprovals(main.peek('p1') as never, main)).toEqual([])
    await main.close()
  })

  test('index entries without identity still read', async () => {
    const { main, storage } = build({ calls: 0 })
    await main.session('p1').send('go').result
    const stored = await storage.state.get('p1')
    if (stored === null) throw new Error('no state')
    stored.core.children = [{ sessionId: 'old', turnId: 't', createdAt: 1 }]
    await storage.state.set('p1', stored)
    expect(await main.peek('p1').children()).toEqual([
      { sessionId: 'old', turnId: 't', createdAt: 1 },
    ])
    await main.close()
  })
})

describe('maxChildren', () => {
  test('refuses agent calls over the cap with a readable string', async () => {
    const { main } = build({ calls: 3, maxChildren: 2 })
    const session = main.session('p1')
    await session.send('go').result
    const outputs = (await session.messages())
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool-agent') as Array<{ toolCallId: string; output?: string }>
    const byId = Object.fromEntries(outputs.map((p) => [p.toolCallId, p.output]))
    expect(byId.c1).toBe('report')
    expect(byId.c2).toBe('report')
    expect(byId.c3).toContain('may not start more (limit 2)')
    expect(await main.peek('p1').children()).toHaveLength(2)
    await main.close()
  })
})
