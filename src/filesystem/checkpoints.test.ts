/** Checkpoint stores, `checkpointsSince`, `rewindFiles` and `checkpointedFs`. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CheckpointStore,
  checkpointedFs,
  checkpointsSince,
  memoryCheckpointStore,
  rewindFiles,
} from './checkpoints.ts'
import { memoryFs } from './memory.ts'
import { nodeCheckpointStore } from './node/checkpoint-store.ts'
import { diskFs } from './node/disk-fs.ts'
import type { FileSystem } from './types.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eh-cp-')))
  dirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

// ids that sort like UUIDv7s
const T1 = '00000000-0000-7000-8000-000000000001'
const T2 = '00000000-0000-7000-8000-000000000002'
const T3 = '00000000-0000-7000-8000-000000000003'

const stores: Array<[string, (opts?: { keepTurns?: number }) => Promise<CheckpointStore>]> = [
  ['memoryCheckpointStore', async (o) => memoryCheckpointStore(o)],
  ['nodeCheckpointStore', async (o) => nodeCheckpointStore(await temp(), o)],
]

for (const [name, make] of stores) {
  describe(`${name} (port contract)`, () => {
    test('save is first-write-wins; load and list', async () => {
      const store = await make()
      const key = { sessionId: 's/1', turnKey: T1, path: '/a.txt' }
      expect(await store.load(key)).toBeNull()
      await store.save(key, { content: 'one' })
      await store.save(key, { content: 'two' })
      await store.save({ ...key, path: '/b.txt' }, { missing: true })
      await store.save({ ...key, turnKey: T2 }, { content: 'later' })
      expect(await store.load(key)).toEqual({ content: 'one' })
      const list = await store.list('s/1')
      expect(list.map((r) => [r.turnKey, r.path, r.before])).toEqual([
        [T1, '/a.txt', { content: 'one' }],
        [T1, '/b.txt', { missing: true }],
        [T2, '/a.txt', { content: 'later' }],
      ])
      expect(list.every((r) => typeof r.at === 'number')).toBe(true)
      expect(await store.list('other')).toEqual([])
    })

    test('delete removes some turns or the whole session', async () => {
      const store = await make()
      for (const turnKey of [T1, T2, T3]) {
        await store.save({ sessionId: 's', turnKey, path: '/a' }, { content: turnKey })
      }
      await store.save({ sessionId: 'x', turnKey: T1, path: '/a' }, { content: 'x' })
      await store.delete('s', [T1, T3])
      expect((await store.list('s')).map((r) => r.turnKey)).toEqual([T2])
      await store.delete('s')
      expect(await store.list('s')).toEqual([])
      expect(await store.list('x')).toHaveLength(1)
      await store.delete('never-existed')
    })

    test('keepTurns drops the oldest turns', async () => {
      const store = await make({ keepTurns: 2 })
      for (const turnKey of [T1, T2, T3]) {
        await store.save({ sessionId: 's', turnKey, path: '/a' }, { content: turnKey })
      }
      expect((await store.list('s')).map((r) => r.turnKey)).toEqual([T2, T3])
    })
  })
}

test('nodeCheckpointStore survives a restart (a new instance on the same directory)', async () => {
  const dir = await temp()
  await nodeCheckpointStore(dir).save({ sessionId: 's', turnKey: T1, path: '/a' }, { content: 'x' })
  expect((await nodeCheckpointStore(dir).list('s'))[0]?.before).toEqual({ content: 'x' })
})

const adapters: Array<[string, () => Promise<FileSystem>]> = [
  ['memoryFs', async () => memoryFs()],
  ['diskFs', async () => diskFs(await temp())],
]

for (const [name, makeFs] of adapters) {
  describe(`checkpoints on ${name}`, () => {
    /** Run the scripted edits of turn `key` through the recording fs. */
    async function turn(
      fs: FileSystem,
      store: CheckpointStore,
      key: string | undefined,
      work: (fs: FileSystem) => Promise<void>,
    ): Promise<void> {
      await work(checkpointedFs({ fs, store, sessionId: 's', turnKey: () => key }))
    }

    test('records the content before the FIRST change per turn; rewind restores earliest', async () => {
      const fs = await makeFs()
      const store = memoryCheckpointStore()
      await fs.write('/keep.txt', 'k0')
      await fs.write('/edit.txt', 'e0')
      await fs.write('/gone.txt', 'g0')
      await turn(fs, store, T1, async (r) => {
        await r.write('/edit.txt', 'e1')
        await r.write('/edit.txt', 'e1b') // second change in the same turn
        await r.write('/new.txt', 'n1') // did not exist
      })
      await turn(fs, store, T2, async (r) => {
        await r.write('/edit.txt', 'e2')
        await r.delete('/gone.txt')
        await r.write('/keep.txt', 'k2')
      })

      const since = await checkpointsSince({ store, sessionId: 's', fromTurnKey: T2, fs })
      expect(since.map((p) => [p.path, p.turnKey, p.changed])).toEqual([
        ['/edit.txt', T2, true],
        ['/gone.txt', T2, true],
        ['/keep.txt', T2, true],
      ])

      const result = await rewindFiles({ fs, store, sessionId: 's', fromTurnKey: T1 })
      expect(result.restored.sort()).toEqual(['/edit.txt', '/gone.txt', '/keep.txt'])
      expect(result.deleted).toEqual(['/new.txt'])
      expect(result.failed).toEqual([])
      expect((await fs.read('/edit.txt'))?.content).toBe('e0')
      expect((await fs.read('/gone.txt'))?.content).toBe('g0')
      expect((await fs.read('/keep.txt'))?.content).toBe('k0')
      expect(await fs.read('/new.txt')).toBeNull()
      expect(await store.list('s')).toEqual([]) // rewound snapshots are dropped
    })

    test('rewinding to a later turn leaves earlier turns alone; unchanged files are reported', async () => {
      const fs = await makeFs()
      const store = memoryCheckpointStore()
      await fs.write('/a.txt', 'a0')
      await fs.write('/b.txt', 'b0')
      await turn(fs, store, T1, async (r) => void (await r.write('/a.txt', 'a1')))
      await turn(fs, store, T2, async (r) => {
        await r.write('/b.txt', 'b1')
        await r.write('/b.txt', 'b0') // changed back: nothing to restore
      })
      const result = await rewindFiles({ fs, store, sessionId: 's', fromTurnKey: T2 })
      expect(result).toEqual({ restored: [], deleted: [], unchanged: ['/b.txt'], failed: [] })
      expect((await fs.read('/a.txt'))?.content).toBe('a1')
      expect((await store.list('s')).map((r) => r.turnKey)).toEqual([T1])
    })

    test('a point between turns (no checkpoint of its own) selects later turns', async () => {
      const fs = await makeFs()
      const store = memoryCheckpointStore()
      await fs.write('/a.txt', 'a0')
      await turn(fs, store, T1, async (r) => void (await r.write('/a.txt', 'a1')))
      await turn(fs, store, T3, async (r) => void (await r.write('/a.txt', 'a3')))
      await rewindFiles({ fs, store, sessionId: 's', fromTurnKey: T2 })
      expect((await fs.read('/a.txt'))?.content).toBe('a1')
    })

    test('move records both ends; nothing is recorded outside a turn or for skipped paths', async () => {
      const fs = await makeFs()
      const store = memoryCheckpointStore()
      await fs.write('/from.txt', 'f')
      await turn(fs, store, undefined, async (r) => void (await r.write('/x.txt', 'x')))
      expect(await store.list('s')).toEqual([])

      const recording = checkpointedFs({
        fs,
        store,
        sessionId: 's',
        turnKey: () => T1,
        skip: (p) => p.startsWith('/skip/'),
      })
      await recording.write('/skip/a.txt', 'a')
      expect(await recording.move?.('/from.txt', '/to.txt')).toEqual({ ok: true })
      expect((await store.list('s')).map((r) => [r.path, r.before])).toEqual([
        ['/from.txt', { content: 'f' }],
        ['/to.txt', { missing: true }],
      ])
      await rewindFiles({ fs, store, sessionId: 's', fromTurnKey: T1 })
      expect((await fs.read('/from.txt'))?.content).toBe('f')
      expect(await fs.read('/to.txt')).toBeNull()
    })

    test('concurrent first changes of the same path record the original content', async () => {
      const fs = await makeFs()
      const store = memoryCheckpointStore()
      await fs.write('/a.txt', 'a0')
      const r = checkpointedFs({ fs, store, sessionId: 's', turnKey: () => T1 })
      await Promise.all([r.write('/a.txt', 'a1'), r.write('/a.txt', 'a2'), r.delete('/a.txt')])
      expect((await store.list('s'))[0]?.before).toEqual({ content: 'a0' })
    })
  })
}

describe('rewindFiles failures', () => {
  test('a path that cannot be restored is reported, the others are restored, records are kept', async () => {
    const fs = memoryFs({ '/ok.txt': 'ok0', '/ro.txt': 'ro0' })
    const store = memoryCheckpointStore()
    const recording = checkpointedFs({ fs, store, sessionId: 's', turnKey: () => T1 })
    await recording.write('/ok.txt', 'ok1')
    await recording.write('/ro.txt', 'ro1')
    const guarded: FileSystem = {
      ...fs,
      async write(path, content, opts) {
        if (path === '/ro.txt') throw new Error('read-only directory: /ro.txt')
        return fs.write(path, content, opts)
      },
    }
    const result = await rewindFiles({ fs: guarded, store, sessionId: 's', fromTurnKey: T1 })
    expect(result.restored).toEqual(['/ok.txt'])
    expect(result.failed).toEqual([{ path: '/ro.txt', error: 'read-only directory: /ro.txt' }])
    expect(await store.list('s')).toHaveLength(2)
    expect((await fs.read('/ok.txt'))?.content).toBe('ok0')
  })

  test('keepRecords keeps the snapshots', async () => {
    const fs = memoryFs({ '/a.txt': 'a0' })
    const store = memoryCheckpointStore()
    await checkpointedFs({ fs, store, sessionId: 's', turnKey: () => T1 }).write('/a.txt', 'a1')
    await rewindFiles({ fs, store, sessionId: 's', fromTurnKey: T1, keepRecords: true })
    expect(await store.list('s')).toHaveLength(1)
  })

  test('an unreadable file (binary) is not recorded and the change still goes through', async () => {
    const errors: string[] = []
    const fs = memoryFs({ '/a.txt': 'a0' })
    const broken: FileSystem = {
      ...fs,
      async read(path) {
        if (path === '/a.txt') throw new Error('binary or too large file')
        return fs.read(path)
      },
    }
    const store = memoryCheckpointStore()
    const r = checkpointedFs({
      fs: broken,
      store,
      sessionId: 's',
      turnKey: () => T1,
      onError: (path) => errors.push(path),
    })
    expect(await r.write('/a.txt', 'a1')).toMatchObject({ ok: true })
    expect(errors).toEqual(['/a.txt'])
    expect(await store.list('s')).toEqual([])
  })
})
