/**
 * Storage (Settings > Storage): the scan of a data directory, the volume warnings, the maintenance
 * actions (with VACUUM refused on low space), retention and the low-disk alarm.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAlarms } from '../src/app/alarms.ts'
import type { StoragePort } from '../src/app/ports.ts'
import { checkDiskAlarm, getStorage, runStorageAction } from '../src/app/storage.ts'
import {
  folderOfLibraryPath,
  GB,
  groupOfTable,
  isLowDisk,
  storageWarnings,
} from '../src/domain/storage.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { createStorageService, walkDir } from '../src/infra/storage/storage-service.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function instance(env: Record<string, string> = {}): { server: Server; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'team-storage-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    backupDir: join(dir, 'backups'),
    instanceId: 'storage-test',
    env,
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  return { server, dir }
}

const bytesOf = (n: number): string => 'x'.repeat(n)

describe('domain', () => {
  test('tables group by feature and library paths by folder', () => {
    expect(groupOfTable('model_calls')).toBe('model-calls')
    expect(groupOfTable('eh_messages')).toBe('chats')
    expect(groupOfTable('channel_messages')).toBe('channels')
    expect(groupOfTable('library_history')).toBe('library')
    expect(groupOfTable('routine_runs')).toBe('tasks')
    expect(groupOfTable('api_keys')).toBe('other')
    expect(folderOfLibraryPath('/library/reports/q1.md')).toBe('/library/reports')
    expect(folderOfLibraryPath('/library/readme.md')).toBe('/library')
    expect(folderOfLibraryPath('/memories/agents/a1/notes.md')).toBe('/memories/agents/a1')
    expect(folderOfLibraryPath('/memories/workspace/profile.md')).toBe('/memories')
    expect(folderOfLibraryPath('/uploads/x.png')).toBe('/uploads')
    expect(folderOfLibraryPath('/.eharness/tool-media/x.png')).toBe('/.eharness/tool-media')
    expect(folderOfLibraryPath('/skills/s/SKILL.md')).toBe('/skills')
    expect(folderOfLibraryPath('/weird.txt')).toBe('other')
  })

  test('low disk: under 10% or under 2 GB free', () => {
    expect(isLowDisk({ totalBytes: 100 * GB, freeBytes: 9 * GB })).toBe(true)
    expect(isLowDisk({ totalBytes: 100 * GB, freeBytes: 50 * GB })).toBe(false)
    expect(isLowDisk({ totalBytes: 10 * GB, freeBytes: 1.5 * GB })).toBe(true)
    expect(isLowDisk({ totalBytes: 1000 * GB, freeBytes: 150 * GB })).toBe(false)
  })
})

describe('the scan', () => {
  test('sizes, per-table, library breakdown, backups, other dirs and key files', async () => {
    const { server, dir } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/reports/q1.md', bytesOf(1000))
    await fs.write('/library/reports/q2.md', bytesOf(500))
    await fs.write('/library/data/a.md', bytesOf(200))
    await fs.write('/memories/agents/a1/notes.md', bytesOf(300))
    await fs.write('/uploads/u.txt', bytesOf(100))
    await fs.write('/.eharness/tool-media/shot.png', bytesOf(4000))
    await fs.write('/skills/s/SKILL.md', bytesOf(50))
    await fs.write('/library/reports/q1.md', bytesOf(1100)) // a second version in the history
    // directories next to the database
    mkdirSync(join(dir, 'backups'), { recursive: true })
    writeFileSync(join(dir, 'backups', 'b1.db'), bytesOf(2048))
    writeFileSync(join(dir, 'backups', 'b1.zip'), bytesOf(1024))
    mkdirSync(join(dir, 'code-scratch', 'run1'), { recursive: true })
    writeFileSync(join(dir, 'code-scratch', 'run1', 'f.py'), bytesOf(700))
    mkdirSync(join(dir, 'browser', 'profiles'), { recursive: true })
    writeFileSync(join(dir, 'browser', 'profiles', 'p.bin'), bytesOf(900))

    const view = await getStorage(server.deps, { refresh: true })
    expect(view.dataDir).toBe(dir)
    expect(view.volume?.totalBytes).toBeGreaterThan(0)
    expect(view.volume?.freeBytes).toBeGreaterThan(0)
    const db = view.database
    expect(db.dbBytes).toBe(statSync(join(dir, 'team.db')).size)
    expect(db.pageSize).toBeGreaterThan(0)
    expect(db.pageCount).toBeGreaterThan(0)
    expect(db.perTableBytes).toBe(true)
    expect(db.tables.length).toBeLessThanOrEqual(15)
    const files = db.tables.find((t) => t.name === 'library_files')
    expect(files?.rows).toBeGreaterThanOrEqual(7)
    expect(files?.group).toBe('library')
    expect(db.groups.map((g) => g.group)).toContain('library')

    const lib = view.library
    expect(lib.files).toBeGreaterThanOrEqual(7)
    const folder = (name: string) => lib.folders.find((f) => f.folder === name)
    expect(folder('/library/reports')).toEqual({
      folder: '/library/reports',
      files: 2,
      bytes: 1600,
    })
    expect(folder('/library/data')?.bytes).toBe(200)
    expect(folder('/memories/agents/a1')?.bytes).toBe(300)
    expect(folder('/uploads')?.bytes).toBe(100)
    expect(folder('/.eharness/tool-media')?.bytes).toBe(4000)
    expect(folder('/skills')?.bytes).toBeGreaterThanOrEqual(50)
    expect(lib.history.versions).toBeGreaterThanOrEqual(8)

    expect(view.backups).toMatchObject({ exists: true, files: 2, snapshots: 1, totalBytes: 3072 })
    expect(view.backups?.sameVolume).toBe(true)
    // the test's data dir lives in the OS temporary directory: the temporary warning wins
    expect(view.backups?.temporary).toBe(true)
    expect(view.warnings.map((w) => w.code)).toContain('backups-temporary')

    const other = (id: string) => view.others.find((d) => d.id === id)
    expect(other('code-scratch')).toMatchObject({ bytes: 700, files: 1, approximate: false })
    expect(other('browser')?.bytes).toBe(900)
    expect(other('browser')?.children[0]).toEqual({ name: 'profiles', bytes: 900 })
    expect(other('code-env')).toBeUndefined()

    // dev key files: a warning while the env keys are not set
    const keys = Object.fromEntries(view.keys.map((k) => [k.file, k]))
    expect(keys['secret.key']?.present).toBe(true)
    expect(keys['secret.key']?.envSet).toBe(false)
    expect(
      view.warnings.some((w) => w.code === 'key-file' && w.text.includes('TEAM_SECRET_KEY')),
    ).toBe(true)
    // never any key content
    expect(JSON.stringify(view)).not.toMatch(/[A-Za-z0-9+/]{43}=/)
  })

  test('no key warning when the env keys are set', async () => {
    const key = Buffer.alloc(32, 7).toString('base64')
    const { server } = instance({ TEAM_SECRET_KEY: key, TEAM_CHANNEL_KEY: key })
    const view = await getStorage(server.deps, { refresh: true })
    expect(view.warnings.some((w) => w.code === 'key-file')).toBe(false)
  })

  test('the report is cached for 60 seconds and refresh scans again', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    const first = await getStorage(server.deps, { refresh: true })
    await fs.write('/uploads/new.txt', 'hello')
    const cached = await getStorage(server.deps)
    expect(cached.scannedAt).toBe(first.scannedAt)
    expect(cached.library.files).toBe(first.library.files)
    const fresh = await getStorage(server.deps, { refresh: true })
    expect(fresh.library.files).toBeGreaterThan(first.library.files)
  })

  test('a walk stops at its caps and says approximate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-walk-'))
    dirs.push(dir)
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.txt`), 'abcd')
    const full = await walkDir(dir, { maxEntries: 100, maxMs: 5000 })
    expect(full).toMatchObject({ files: 30, bytes: 120, approximate: false })
    const capped = await walkDir(dir, { maxEntries: 10, maxMs: 5000 })
    expect(capped.approximate).toBe(true)
    expect(capped.files).toBe(10)
    // the time cap (a clock that jumps)
    let t = 0
    const timed = await walkDir(dir, { maxEntries: 100, maxMs: 5 }, () => (t += 10))
    expect(timed.approximate).toBe(true)
  })

  test('the scan of a service with a small walk cap marks the directory approximate', async () => {
    const { server, dir } = instance()
    mkdirSync(join(dir, 'code-scratch'), { recursive: true })
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, 'code-scratch', `f${i}`), 'zz')
    const service = createStorageService({
      sqlite: server.conn.sqlite,
      dbFile: join(dir, 'team.db'),
      dirs: [{ id: 'code-scratch', label: 'Code scratch', path: join(dir, 'code-scratch') }],
      walk: { maxEntries: 5 },
    })
    const report = await service.report()
    expect(report.others[0]?.approximate).toBe(true)
    expect(storageWarnings(report).some((w) => w.code === 'approximate')).toBe(true)
  })
})

describe('volume warnings and actions', () => {
  const statfs =
    (freeBytes: number, totalBytes = 100 * GB) =>
    () => ({ totalBytes, usedBytes: totalBytes - freeBytes, freeBytes })

  test('a low volume warns in the report', async () => {
    const { server, dir } = instance()
    const service = createStorageService({
      sqlite: server.conn.sqlite,
      dbFile: join(dir, 'team.db'),
      statfs: statfs(5 * GB),
    })
    const report = await service.report()
    expect(storageWarnings(report).some((w) => w.code === 'low-disk')).toBe(true)
    const healthy = createStorageService({
      sqlite: server.conn.sqlite,
      dbFile: join(dir, 'team.db'),
      statfs: statfs(60 * GB),
    })
    expect(storageWarnings(await healthy.report()).some((w) => w.code === 'low-disk')).toBe(false)
  })

  test('compact is refused when the free space is smaller than the database', async () => {
    const { server, dir } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/uploads/big.txt', bytesOf(200_000))
    const service = createStorageService({
      sqlite: server.conn.sqlite,
      dbFile: join(dir, 'team.db'),
      statfs: statfs(1000),
    })
    const error = await service.run('compact').catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'conflict', code: 'STORAGE_LOW_SPACE' })
    // with room, it runs and reports the sizes before and after
    const roomy = createStorageService({
      sqlite: server.conn.sqlite,
      dbFile: join(dir, 'team.db'),
      statfs: statfs(50 * GB),
    })
    const done = await roomy.run('compact')
    expect(done.action).toBe('compact')
    expect(done.before.dbBytes).toBeGreaterThan(0)
    expect(done.after.dbBytes).toBeGreaterThan(0)
    expect(done.after.walBytes).toBeLessThanOrEqual(done.before.walBytes)
  })

  test('compact gives deleted pages back to the disk', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    for (let i = 0; i < 40; i++) await fs.write(`/uploads/f${i}.txt`, bytesOf(100_000))
    for (let i = 0; i < 40; i++) await fs.delete(`/uploads/f${i}.txt`)
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const result = await runStorageAction(server.deps, 'compact', { confirm: true })
    expect(result.after.dbBytes).toBeLessThanOrEqual(result.before.dbBytes)
  })

  test('checkpoint truncates the WAL', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    for (let i = 0; i < 10; i++) await fs.write(`/uploads/c${i}.txt`, bytesOf(50_000))
    const result = await runStorageAction(server.deps, 'checkpoint', { confirm: true })
    expect(result.after.walBytes).toBe(0)
    expect(result.before.walBytes).toBeGreaterThanOrEqual(0)
  })

  test('every action needs the confirmation', async () => {
    const { server } = instance()
    expect(() => runStorageAction(server.deps, 'compact', { confirm: false })).toThrow(/confirm/)
  })

  test('retention removes what the settings no longer keep; clear-media removes old media only', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/.eharness/tool-media/old.png', bytesOf(5000))
    await fs.write('/.eharness/tool-media/new.png', bytesOf(5000))
    await fs.write('/library/keep.md', 'keep')
    const day = 86_400_000
    server.conn.sqlite
      .query('UPDATE library_files SET updated_at = ? WHERE path = ?')
      .run(Date.now() - 10 * day, '/.eharness/tool-media/old.png')
    const retention = await runStorageAction(server.deps, 'retention', { confirm: true })
    expect(retention.detail.media).toBe(1)
    expect(await fs.read('/.eharness/tool-media/old.png')).toBeNull()
    expect(await fs.read('/.eharness/tool-media/new.png')).toBeDefined()

    server.conn.sqlite
      .query('UPDATE library_files SET updated_at = ? WHERE path = ?')
      .run(Date.now() - 5 * day, '/.eharness/tool-media/new.png')
    const young = await runStorageAction(server.deps, 'clear-media', { confirm: true, days: 30 })
    expect(young.detail.media).toBe(0)
    const cleared = await runStorageAction(server.deps, 'clear-media', { confirm: true, days: 2 })
    expect(cleared.detail.media).toBe(1)
    expect(await fs.read('/library/keep.md')).toBeDefined()
    await expect(
      runStorageAction(server.deps, 'clear-media', { confirm: true, days: 0 }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('routes', () => {
  test('GET /storage and the action route', async () => {
    const { server } = instance()
    const res = await server.app.request('/storage?refresh=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dataDir: string; warnings: unknown[] }
    expect(body.dataDir.length).toBeGreaterThan(0)
    const post = (action: string, payload: unknown) =>
      server.app.request(`/storage/actions/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    expect((await post('checkpoint', { confirm: false })).status).toBe(400)
    expect((await post('nope', { confirm: true })).status).toBe(400)
    const ok = await post('checkpoint', { confirm: true })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { action: string }).action).toBe('checkpoint')
  })
})

describe('low-disk alarm', () => {
  test('raised once per day when the volume is low, not when it is fine', () => {
    const { server } = instance()
    const port = (freeBytes: number): StoragePort => ({
      report: () => Promise.reject(new Error('unused')),
      run: () => Promise.reject(new Error('unused')),
      volume: () => ({
        path: '/data',
        totalBytes: 100 * GB,
        usedBytes: 100 * GB - freeBytes,
        freeBytes,
      }),
    })
    const fine = { ...server.deps, storage: port(60 * GB) }
    expect(checkDiskAlarm(fine)).toBeUndefined()
    const low = { ...server.deps, storage: port(3 * GB) }
    const first = checkDiskAlarm(low)
    expect(first?.kind).toBe('system')
    expect(first?.text).toContain('nearly full')
    expect(first?.refs[0]).toContain('section=storage')
    expect(checkDiskAlarm(low)).toBeUndefined()
    expect(checkDiskAlarm(low)).toBeUndefined()
    expect(
      listAlarms(server.deps).alarms.filter((a) => a.subject === 'system:storage'),
    ).toHaveLength(1)
  })
})
