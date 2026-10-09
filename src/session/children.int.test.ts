import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { StateAdapter } from '../agent/session-types.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { MAX_CHILDREN, registerChild } from './family.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function shared() {
  return { messages: memoryMessages(), state: memoryState() }
}

function makeAgent(
  storage: { messages: ReturnType<typeof memoryMessages>; state: StateAdapter },
  extra: Record<string, unknown> = {},
) {
  return defineHarnessAgent({
    model: scriptedModel(Array.from({ length: 8 }, (_, i) => ({ text: `answer ${i}` }))),
    contextWindow: 100_000,
    storage,
    logger: silent,
    ...extra,
  })
}

const parentOf = (n: number) => ({
  sessionId: 'parent',
  turnId: 'turn-1',
  toolCallId: `call-${n}`,
  depth: 1,
})

describe('parent / child index', () => {
  test('a child registers in the state of a parent of another agent sharing the storage', async () => {
    const storage = shared()
    const agentA = makeAgent(storage)
    const agentB = makeAgent(storage)
    const parent = agentA.session('parent')
    await parent.send('hello').result

    const child = agentB.session('child-1', { parent: parentOf(1) })
    await child.ready()
    await child.send('work').result

    const children = await parent.children()
    expect(children).toEqual([
      {
        sessionId: 'child-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        createdAt: expect.any(Number),
      },
    ])
    expect(await child.parentInfo()).toEqual(parentOf(1))
    expect(await parent.parentInfo()).toBeUndefined()
    expect(await child.children()).toEqual([])
    // the child's state carries the parent durably
    expect((await storage.state.get('child-1'))?.core.parent).toEqual(parentOf(1))
  })

  test('is durable: after closing everything and reopening in a fresh agent', async () => {
    const storage = shared()
    const agentA = makeAgent(storage)
    await agentA.session('parent').send('hello').result
    const agentB = makeAgent(storage)
    await agentB.session('child-1', { parent: parentOf(1) }).ready()
    await agentB.session('child-2', { parent: parentOf(2) }).ready()
    await agentA.close()
    await agentB.close()

    const restarted = makeAgent(storage)
    expect((await restarted.session('parent').children()).map((c) => c.sessionId)).toEqual([
      'child-1',
      'child-2',
    ])
    // a child opened without options knows its parent from the state
    expect((await restarted.session('child-2').parentInfo())?.toolCallId).toBe('call-2')
    // reopening a child is idempotent
    await restarted.session('child-1', { parent: parentOf(1) }).ready()
    expect(await restarted.session('parent').children()).toHaveLength(2)
  })

  test('the parent keeps the children registered while its own writes continue', async () => {
    const storage = shared()
    const agentB = makeAgent(storage)
    const spawn = tool({
      description: 'spawn a child session',
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        await agentB.session(`child-${n}`, { parent: parentOf(n) }).ready()
        return `child-${n}`
      },
    })
    const agentA = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'spawn', input: { n: 1 } }] },
        { text: 'spawned' },
        { text: 'second turn' },
      ]),
      contextWindow: 100_000,
      tools: { spawn },
      storage,
      logger: silent,
    })
    const parent = agentA.session('parent')
    expect((await parent.send('go').result).stop).toBe('complete')
    // registered during the running turn, preserved by the owner's later writes
    expect((await parent.children()).map((c) => c.sessionId)).toEqual(['child-1'])
    await agentB.session('child-2', { parent: parentOf(2) }).ready()
    expect((await parent.send('again').result).stop).toBe('complete')
    await agentA.closeSession('parent')
    expect((await storage.state.get('parent'))?.core.children?.map((c) => c.sessionId)).toEqual([
      'child-1',
      'child-2',
    ])
  })

  test('concurrent registrations all land (compare-and-set with retries)', async () => {
    const storage = shared()
    const agentA = makeAgent(storage)
    await agentA.session('parent').send('hello').result
    const agentB = makeAgent(storage)
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        agentB.session(`child-${i}`, { parent: parentOf(i) }).ready(),
      ),
    )
    const ids = (await agentA.session('parent').children()).map((c) => c.sessionId).sort()
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `child-${i}`).sort())
  })

  test('caps the list at 500 (oldest dropped) and ignores duplicates', async () => {
    const storage = shared()
    await storage.state.set('parent', { v: 1, rev: 1, core: {}, plugins: {} })
    for (let i = 0; i < MAX_CHILDREN + 5; i++) {
      await registerChild(storage.state, 'parent', {
        sessionId: `c${i}`,
        turnId: 't',
        createdAt: i,
      })
    }
    expect(
      await registerChild(storage.state, 'parent', {
        sessionId: 'c504',
        turnId: 't',
        createdAt: 9,
      }),
    ).toBe('exists')
    const children = (await storage.state.get('parent'))?.core.children ?? []
    expect(children).toHaveLength(MAX_CHILDREN)
    expect(children[0]?.sessionId).toBe('c5')
    expect(children.at(-1)?.sessionId).toBe(`c${MAX_CHILDREN + 4}`)
  })

  test('works without setIf (plain read-modify-write) and never creates a missing parent', async () => {
    const inner = memoryState()
    const state: StateAdapter = { get: (id) => inner.get(id), set: (id, s) => inner.set(id, s) }
    const storage = { messages: memoryMessages(), state }
    const agent = makeAgent(storage)
    await agent.session('parent').send('hello').result
    await agent.session('child-1', { parent: parentOf(1) }).ready()
    expect((await agent.session('parent').children()).map((c) => c.sessionId)).toEqual(['child-1'])

    // a parent without stored state is not created
    await agent.session('orphan', { parent: { ...parentOf(1), sessionId: 'nowhere' } }).ready()
    expect(await inner.get('nowhere')).toBeNull()
    expect(await agent.session('orphan').parentInfo()).toEqual({
      ...parentOf(1),
      sessionId: 'nowhere',
    })
  })

  test('a failing registration does not break the child', async () => {
    const inner = memoryState()
    let fail = true
    const state: StateAdapter = {
      get: async (id) => {
        if (fail && id === 'parent') throw new Error('down')
        return inner.get(id)
      },
      set: (id, s) => inner.set(id, s),
      ...(inner.setIf === undefined ? {} : { setIf: inner.setIf.bind(inner) }),
    }
    const storage = { messages: memoryMessages(), state }
    const agent = makeAgent(storage)
    await inner.set('parent', { v: 1, rev: 1, core: {}, plugins: {} })
    const child = agent.session('child-1', { parent: parentOf(1) })
    await child.ready()
    expect((await child.send('x').result).stop).toBe('complete')
    expect(await inner.get('parent').then((s) => s?.core.children)).toBeUndefined()
    // not recorded as registered: the next open retries
    expect((await inner.get('child-1'))?.core.parent).toBeUndefined()
    await agent.closeSession('child-1')
    fail = false
    await agent.session('child-1', { parent: parentOf(1) }).ready()
    expect((await inner.get('parent'))?.core.children?.map((c) => c.sessionId)).toEqual(['child-1'])
  })
})
