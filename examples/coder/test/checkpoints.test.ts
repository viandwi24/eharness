import { describe, expect, test } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import {
  CHECKPOINT_KEEP,
  createCheckpointStore,
  createCheckpoints,
} from '../src/app/checkpoints.ts'
import { createStorage, newSessionId } from '../src/app/sessions.ts'
import { createWorkspace } from '../src/workspace/index.ts'
import { setup } from './helpers.ts'

const call = (toolName: string, input: unknown): ScriptedStepInput => ({
  toolCalls: [{ toolName, input }],
})

async function env(files: Record<string, string>, steps: ScriptedStepInput[]) {
  const { root, config } = await setup(files)
  const workspace = await createWorkspace(config)
  const storage = createStorage(config)
  const store = createCheckpointStore({
    projectDataDir: config.projectDataDir,
    fs: workspace.fs,
  })
  let sessionId = newSessionId()
  const checkpoints = createCheckpoints({
    store,
    storage,
    fs: workspace.fs,
    sessionId: () => sessionId,
  })
  const agent = defineHarnessAgent({
    id: 'cp',
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage,
    plugins: [filesystem({ fs: workspace.fs }), checkpoints.plugin],
  })
  const send = async (text: string) => {
    const result = await agent.session(sessionId).send(text).result
    expect(result.stop).toBe('complete')
  }
  return {
    root,
    config,
    storage,
    store,
    checkpoints,
    send,
    useSession: (id: string) => {
      sessionId = id
    },
    id: () => sessionId,
    disk: (rel: string) => readFile(join(root, rel), 'utf8'),
  }
}

// turn 1: create new.txt, edit a.txt; turn 2: edit a.txt again, delete new.txt, edit a.txt once more
const script: ScriptedStepInput[] = [
  call('write_file', { path: '/new.txt', content: 'brand new\n' }),
  call('read_file', { path: '/a.txt' }),
  call('edit_file', { path: '/a.txt', old_string: 'one', new_string: 'ONE' }),
  { text: 'turn one done' },
  call('edit_file', { path: '/a.txt', old_string: 'two', new_string: 'TWO' }),
  call('edit_file', { path: '/a.txt', old_string: 'TWO', new_string: 'TWO!' }),
  call('read_file', { path: '/new.txt' }),
  call('delete_file', { path: '/new.txt' }),
  { text: 'turn two done' },
]

describe('checkpoints and rewind code', () => {
  test('records the content before the first change of each turn and rewinds files on disk', async () => {
    const t = await env({ 'a.txt': 'one\ntwo\n' }, script)
    await t.send('first')
    await t.send('second')
    expect(await t.disk('a.txt')).toBe('ONE\nTWO!\n')

    const cps = await t.store.list(t.id())
    expect(cps).toHaveLength(2)
    expect(cps[0]?.files['/new.txt']).toEqual({ existed: false })
    expect(cps[0]?.files['/a.txt']).toEqual({ existed: true, content: 'one\ntwo\n' })
    // the second edit of the same turn does not overwrite the snapshot
    expect(cps[1]?.files['/a.txt']).toEqual({ existed: true, content: 'ONE\ntwo\n' })
    expect(cps[1]?.files['/new.txt']).toEqual({ existed: true, content: 'brand new\n' })
    const files = await readdir(join(t.config.projectDataDir, 'checkpoints', t.id()))
    expect(files).toHaveLength(2)

    const points = await t.checkpoints.rewindPoints()
    expect(points.map((p) => p.text)).toEqual(['second', 'first'])
    expect(points[0]?.files).toEqual(['a.txt', 'new.txt'])
    // new.txt was created in turn 1 and deleted in turn 2: net unchanged from before turn 1
    expect(points[1]?.files).toEqual(['a.txt'])
    expect(points[0]?.at).toBeGreaterThan(0)

    // rewind code to before turn 2: new.txt is back, a.txt is the result of turn 1
    const r2 = await t.checkpoints.rewind(points[0]?.messageId ?? '', 'code')
    expect(r2.prompt).toBe('second')
    expect(r2.restoredFiles).toEqual(['a.txt', 'new.txt'])
    expect(r2.sessionId).toBeUndefined()
    expect(await t.disk('a.txt')).toBe('ONE\ntwo\n')
    expect(await t.disk('new.txt')).toBe('brand new\n')
    // restored files are no longer listed for the point
    expect((await t.checkpoints.rewindPoints())[0]?.files).toEqual([])
    // new.txt exists again now, so turn 1 would delete it
    expect((await t.checkpoints.rewindPoints())[1]?.files).toEqual(['a.txt', 'new.txt'])

    // rewind code to before turn 1: a.txt original, new.txt deleted
    const r1 = await t.checkpoints.rewind(points[1]?.messageId ?? '', 'code')
    expect(r1.restoredFiles).toEqual(['a.txt', 'new.txt'])
    expect(await t.disk('a.txt')).toBe('one\ntwo\n')
    await expect(t.disk('new.txt')).rejects.toThrow()
  })

  test('rewind conversation creates a new session with only the earlier messages', async () => {
    const t = await env({ 'a.txt': 'one\ntwo\n' }, script)
    const first = t.id()
    await t.send('first')
    await t.send('second')
    const before = await t.storage.messages.load({ sessionId: first })
    expect(before.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const points = await t.checkpoints.rewindPoints()

    const result = await t.checkpoints.rewind(points[0]?.messageId ?? '', 'conversation')
    expect(result.restoredFiles).toEqual([])
    expect(result.prompt).toBe('second')
    expect(result.sessionId).toBeDefined()
    expect(result.sessionId).not.toBe(first)
    const copied = await t.storage.messages.load({ sessionId: result.sessionId ?? '' })
    expect(copied.map((m) => m.id)).toEqual(before.slice(0, 2).map((m) => m.id))
    // the old session is untouched, the disk too
    expect(await t.storage.messages.load({ sessionId: first })).toEqual(before)
    expect(await t.disk('a.txt')).toBe('ONE\nTWO!\n')

    // the new session keeps the checkpoint of turn 1 only
    const kept = await t.store.list(result.sessionId ?? '')
    expect(kept.map((c) => c.userMessageId)).toEqual([before[0]?.id ?? ''])
    expect(await t.store.list(first)).toHaveLength(2)
  })

  test('both: new session and files restored; unknown message id throws', async () => {
    const t = await env({ 'a.txt': 'one\ntwo\n' }, script)
    await t.send('first')
    await t.send('second')
    const points = await t.checkpoints.rewindPoints()
    const result = await t.checkpoints.rewind(points[1]?.messageId ?? '', 'both')
    expect(result.restoredFiles).toEqual(['a.txt'])
    expect(await t.disk('a.txt')).toBe('one\ntwo\n')
    expect(await t.storage.messages.load({ sessionId: result.sessionId ?? '' })).toEqual([])
    await expect(t.checkpoints.rewind('nope', 'code')).rejects.toThrow()
  })

  test('shell changes are not checkpointed; files outside any tool call stay as they are', async () => {
    const t = await env({ 'a.txt': 'one\n' }, [{ text: 'nothing' }])
    await t.send('first')
    await writeFile(join(t.root, 'a.txt'), 'changed by hand\n')
    expect(await t.store.list(t.id())).toEqual([])
    const [point] = await t.checkpoints.rewindPoints()
    expect(point?.files).toEqual([])
    expect((await t.checkpoints.rewind(point?.messageId ?? '', 'code')).restoredFiles).toEqual([])
    expect(await t.disk('a.txt')).toBe('changed by hand\n')
  })

  test('keeps the last 50 turns per session', async () => {
    const { config } = await setup({ 'a.txt': 'x' })
    const workspace = await createWorkspace(config)
    const store = createCheckpointStore({ projectDataDir: config.projectDataDir, fs: workspace.fs })
    expect(CHECKPOINT_KEEP).toBe(50)
    for (let i = 0; i < 53; i++) await store.record('s', `m${String(i).padStart(3, '0')}`, '/a.txt')
    const ids = (await store.list('s')).map((c) => c.userMessageId)
    expect(ids).toHaveLength(50)
    expect(ids[0]).toBe('m003')
    expect(ids.at(-1)).toBe('m052')
  })
})
