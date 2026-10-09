/** The `filesystem({ checkpoints })` option with scripted turns. */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  type CheckpointStore,
  checkpointsSince,
  memoryCheckpointStore,
  rewindFiles,
} from './checkpoints.ts'
import { memoryFs } from './memory.ts'
import { filesystem } from './plugin.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

describe('filesystem({ checkpoints })', () => {
  test('records the content before the first change of each turn under the user message id; rewind restores', async () => {
    const fs = memoryFs({ '/a.txt': 'a0\n', '/b.txt': 'b0\n', '/c.txt': 'c0\n' })
    const store = memoryCheckpointStore()
    const agent = defineHarnessAgent({
      model: scriptedModel([
        // turn 1: read + edit a, overwrite b, create d, edit a again
        { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] },
        {
          toolCalls: [
            {
              toolName: 'edit_file',
              input: { path: '/a.txt', old_string: 'a0', new_string: 'a1' },
            },
          ],
        },
        { toolCalls: [{ toolName: 'read_file', input: { path: '/b.txt' } }] },
        { toolCalls: [{ toolName: 'write_file', input: { path: '/b.txt', content: 'b1\n' } }] },
        { toolCalls: [{ toolName: 'write_file', input: { path: '/d.txt', content: 'd1\n' } }] },
        {
          toolCalls: [
            {
              toolName: 'edit_file',
              input: { path: '/a.txt', old_string: 'a1', new_string: 'a2' },
            },
          ],
        },
        { text: 'one' },
        // turn 2: delete c
        { toolCalls: [{ toolName: 'read_file', input: { path: '/c.txt' } }] },
        { toolCalls: [{ toolName: 'delete_file', input: { path: '/c.txt' } }] },
        { text: 'two' },
      ]),
      contextWindow: 100_000,
      storage: { messages: memoryMessages(), state: memoryState() },
      logger: silent,
      plugins: [filesystem({ fs, checkpoints: store })],
    })
    const session = agent.session('cp')
    const first = await session.send('one').result
    const second = await session.send('two').result
    const user1 = first.messages.find((m) => m.role === 'user')?.id as string
    const user2 = second.messages.filter((m) => m.role === 'user').at(-1)?.id as string
    expect(user1).not.toBe(user2)

    const records = await store.list('cp')
    expect(records.map((r) => [r.turnKey, r.path, r.before])).toEqual([
      [user1, '/a.txt', { content: 'a0\n' }],
      [user1, '/b.txt', { content: 'b0\n' }],
      [user1, '/d.txt', { missing: true }],
      [user2, '/c.txt', { content: 'c0\n' }],
    ])

    const result = await rewindFiles({ fs, store, sessionId: 'cp', fromTurnKey: user1 })
    expect(result.restored.sort()).toEqual(['/a.txt', '/b.txt', '/c.txt'])
    expect(result.deleted).toEqual(['/d.txt'])
    expect((await fs.read('/a.txt'))?.content).toBe('a0\n')
    expect((await fs.read('/c.txt'))?.content).toBe('c0\n')
    expect(await fs.read('/d.txt')).toBeNull()
  })

  test('writers through the fs service are recorded; tool outputs are not; no option, no records', async () => {
    const fs = memoryFs({ '/note.txt': 'n0' })
    const store = memoryCheckpointStore()
    const other = definePlugin({
      name: 'writer',
      requires: ['fs'],
      setup: () => ({
        hooks: {
          'turn.start': async (ctx) => {
            await ctx.services.fs.write('/note.txt', 'n1')
            await ctx.services.toolOutputs.put('call-1', 'big output')
          },
        },
      }),
    })
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'hi' }]),
      contextWindow: 100_000,
      storage: { messages: memoryMessages(), state: memoryState() },
      logger: silent,
      plugins: [filesystem({ fs, checkpoints: store }), other],
    })
    const result = await agent.session('cp2').send('go').result
    const userId = result.messages.find((m) => m.role === 'user')?.id
    expect((await store.list('cp2')).map((r) => [r.turnKey, r.path])).toEqual([
      [userId as string, '/note.txt'],
    ])
    expect((await fs.read('/.eharness/tool-outputs/call-1.txt'))?.content).toBe('big output')
  })

  test('invalid checkpoints option is a config error', () => {
    expect(() =>
      filesystem({
        fs: memoryFs(),
        checkpoints: {} as unknown as ReturnType<typeof memoryCheckpointStore>,
      }),
    ).toThrow('checkpoints')
  })
})

describe('checkpoints and session.fork', () => {
  function forkSetup(store: CheckpointStore, extra: unknown[] = []) {
    const fs = memoryFs({ '/a.txt': 'a0', '/b.txt': 'b0' })
    let turn = 0
    const writer = definePlugin({
      name: 'writer',
      requires: ['fs'],
      setup: () => ({
        hooks: {
          'turn.start': async (ctx) => {
            turn++
            await ctx.services.fs.write(turn === 1 ? '/a.txt' : '/b.txt', `v${turn}`)
          },
        },
      }),
    })
    const warnings: string[] = []
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'one' }, { text: 'two' }]),
      contextWindow: 100_000,
      storage: { messages: memoryMessages(), state: memoryState() },
      logger: silent,
      onWarning: (w) => warnings.push(w.code),
      plugins: [filesystem({ fs, checkpoints: store }), writer, ...extra] as never,
    })
    return { agent, fs, warnings }
  }

  test('a fork copies the checkpoints of the kept turns only', async () => {
    const store = memoryCheckpointStore()
    const { agent } = forkSetup(store)
    const session = agent.session('src')
    const first = await session.send('one').result
    const second = await session.send('two').result
    const user1 = first.messages.find((m) => m.role === 'user')?.id as string
    const user2 = second.messages.filter((m) => m.role === 'user').at(-1)?.id as string
    expect((await store.list('src')).map((r) => r.turnKey)).toEqual([user1, user2])

    const forked = await session.fork({ beforeMessageId: user2 })
    expect((await store.list(forked.id)).map((r) => [r.turnKey, r.path])).toEqual([
      [user1, '/a.txt'],
    ])
    const full = await session.fork()
    expect((await store.list(full.id)).map((r) => r.turnKey)).toEqual([user1, user2])
    // the source keeps its own
    expect(await store.list('src')).toHaveLength(2)
    await agent.close()
  })

  test("a store's own copy() is used; a failing copy warns and the fork still succeeds", async () => {
    const inner = memoryCheckpointStore()
    const copies: Array<[string, string, readonly string[] | undefined]> = []
    const store: CheckpointStore = {
      ...inner,
      copy: async (from, to, turnKeys) => {
        copies.push([from, to, turnKeys])
        if (copies.length === 2) throw new Error('copy failed')
      },
    }
    const { agent, warnings } = forkSetup(store)
    const session = agent.session('src')
    const first = await session.send('one').result
    await session.send('two').result
    const user1 = first.messages.find((m) => m.role === 'user')?.id as string
    const forked = await session.fork()
    expect(copies[0]?.[0]).toBe('src')
    expect(copies[0]?.[1]).toBe(forked.id)
    expect(copies[0]?.[2]?.[0]).toBe(user1)
    const second = await session.fork()
    expect(second.id).not.toBe(forked.id)
    expect(warnings).toContain('W_HOOK_FAILED')
    await agent.close()
  })
})

describe('checkpoints of child sessions in a rewind', () => {
  test('checkpointsSince and rewindFiles take sessionIds; the earliest snapshot wins across sessions', async () => {
    const fs = memoryFs({ '/a.txt': 'now-a', '/b.txt': 'now-b' })
    const store = memoryCheckpointStore()
    const k = (n: number) => `0000000${n}`
    // parent turn 1 changed a (before: a0); the child (later) changed a (before: a1) and b (before: b0)
    await store.save({ sessionId: 'p', turnKey: k(1), path: '/a.txt' }, { content: 'a0' })
    await store.save({ sessionId: 'c', turnKey: k(2), path: '/a.txt' }, { content: 'a1' })
    await store.save({ sessionId: 'c', turnKey: k(2), path: '/b.txt' }, { content: 'b0' })

    const alone = await checkpointsSince({ store, sessionId: 'p', fromTurnKey: k(1) })
    expect(alone.map((c) => c.path)).toEqual(['/a.txt'])
    const family = await checkpointsSince({
      store,
      sessionId: 'p',
      sessionIds: ['c'],
      fromTurnKey: k(1),
    })
    expect(family.map((c) => [c.path, c.sessionId, c.before])).toEqual([
      ['/a.txt', 'p', { content: 'a0' }],
      ['/b.txt', 'c', { content: 'b0' }],
    ])

    const result = await rewindFiles({
      fs,
      store,
      sessionId: 'p',
      sessionIds: ['c'],
      fromTurnKey: k(1),
    })
    expect(result.restored.sort()).toEqual(['/a.txt', '/b.txt'])
    expect((await fs.read('/a.txt'))?.content).toBe('a0')
    expect((await fs.read('/b.txt'))?.content).toBe('b0')
    expect(await store.list('p')).toEqual([])
    expect(await store.list('c')).toEqual([])
  })

  test('without sessionIds the child is untouched', async () => {
    const fs = memoryFs({ '/b.txt': 'now-b' })
    const store = memoryCheckpointStore()
    await store.save({ sessionId: 'c', turnKey: '00000002', path: '/b.txt' }, { content: 'b0' })
    const result = await rewindFiles({ fs, store, sessionId: 'p', fromTurnKey: '00000001' })
    expect(result.restored).toEqual([])
    expect(await store.list('c')).toHaveLength(1)
  })
})
