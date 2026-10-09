/** The `filesystem({ checkpoints })` option with scripted turns. */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { memoryCheckpointStore, rewindFiles } from './checkpoints.ts'
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
