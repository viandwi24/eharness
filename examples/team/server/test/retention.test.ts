import { describe, expect, test } from 'bun:test'
import { openDatabase } from '../src/infra/db/client.ts'
import { compactDatabase, pruneTables, reclaimSpace } from '../src/infra/db/retention.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'

describe('pruneTables', () => {
  test('drops old finished rows, keeps recent and running ones', () => {
    const { sqlite } = openDatabase(':memory:')
    const now = 1_000_000_000_000
    const day = 86_400_000
    const task = (id: string, state: string, endedAt: number | null) =>
      sqlite
        .query(
          `INSERT INTO tasks (id, agent_id, session_id, origin, title, state, started_at, ended_at, last_activity_at)
           VALUES (?, 'a', ?, 'chat', 't', ?, 0, ?, 0)`,
        )
        .run(id, `s-${id}`, state, endedAt)
    task('old', 'done', now - 100 * day)
    task('new', 'done', now - day)
    task('run', 'running', null)
    const run = (id: string, status: string, at: number) =>
      sqlite
        .query(
          `INSERT INTO routine_runs (id, routine_id, scheduled_at, trigger, status, session_id, claimed_at, finished_at)
           VALUES (?, 'r', ?, 'schedule', ?, 's', ?, ?)`,
        )
        .run(id, at, status, at, at)
    run('r-old', 'succeeded', now - 40 * day)
    run('r-new', 'succeeded', now - day)
    run('r-live', 'claimed', now - 41 * day)
    const out = pruneTables(sqlite, {}, now)
    expect(out.tasks).toBe(1)
    expect(out.routineRuns).toBe(1)
    const ids = sqlite
      .query<{ id: string }, []>('SELECT id FROM tasks')
      .all()
      .map((r) => r.id)
    expect(ids.sort()).toEqual(['new', 'run'])
  })
})

describe('media retention', () => {
  const png = (n: number): Uint8Array => {
    const bytes = new Uint8Array(64 * 1024)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 7 + n) % 251
    return bytes
  }

  test('deletes tool media and browser shots older than mediaDays, nothing else', async () => {
    const { sqlite } = openDatabase(':memory:')
    const fs = libraryFs(sqlite)
    const day = 86_400_000
    const now = Date.now()
    const paths = [
      '/.eharness/tool-media/s-c1-1.png',
      '/.eharness/tool-media/s-c2-1.png',
      '/.browser/shots/s-01.png',
      '/.browser/shots/s-02.png',
      '/notes/keep.png',
      '/.eharness/tool-outputs/c1.txt',
    ]
    for (const [i, path] of paths.entries())
      await fs.writeBytes?.(path, png(i), { mediaType: 'image/png' })
    const age = (path: string, days: number): void => {
      sqlite
        .query('UPDATE library_files SET updated_at = ? WHERE path = ?')
        .run(now - days * day, path)
      sqlite.query('UPDATE library_history SET at = ? WHERE path = ?').run(now - days * day, path)
    }
    age('/.eharness/tool-media/s-c1-1.png', 5)
    age('/.browser/shots/s-01.png', 4)
    age('/notes/keep.png', 400)
    age('/.eharness/tool-outputs/c1.txt', 400)
    const out = pruneTables(sqlite, {}, now)
    expect(out.media).toBe(2)
    const left = (await fs.list('/')).map((f) => f.path)
    expect(left).toEqual([
      '/.browser/shots/s-02.png',
      '/.eharness/tool-media/s-c2-1.png',
      '/.eharness/tool-outputs/c1.txt',
      '/notes/keep.png',
    ])
    // mediaDays: 0 keeps everything
    age('/.eharness/tool-media/s-c2-1.png', 30)
    expect(pruneTables(sqlite, { mediaDays: 0 }, now).media).toBe(0)
    expect(pruneTables(sqlite, { mediaDays: 10 }, now).media).toBe(1)
  })

  test('a new database is incremental: deleted media give their pages back', async () => {
    const dir = process.env.TMPDIR ?? '/tmp'
    const file = `${dir}/team-media-${crypto.randomUUID()}.db`
    const { sqlite, close } = openDatabase(file)
    try {
      expect(
        sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum,
      ).toBe(2)
      const fs = libraryFs(sqlite)
      for (let i = 0; i < 20; i++) await fs.writeBytes?.(`/.browser/shots/s-${i}.png`, png(i))
      sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
      const before = Bun.file(file).size
      pruneTables(sqlite, { mediaDays: 1 }, Date.now() + 5 * 86_400_000)
      expect(reclaimSpace(sqlite)).toBe(true)
      sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
      expect(Bun.file(file).size).toBeLessThan(before - 500_000)
      // already incremental: the opt-in conversion does nothing
      expect(compactDatabase(sqlite)).toBe(false)
    } finally {
      close()
      for (const suffix of ['', '-wal', '-shm'])
        await Bun.file(`${file}${suffix}`)
          .delete()
          .catch(() => undefined)
    }
  })

  test('compactDatabase converts an existing none-mode database once; reclaimSpace is a no-op before', async () => {
    const { Database } = await import('bun:sqlite')
    const sqlite = new Database(':memory:')
    sqlite.run('CREATE TABLE t (x BLOB)')
    expect(sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(
      0,
    )
    expect(reclaimSpace(sqlite)).toBe(false)
    expect(compactDatabase(sqlite)).toBe(true)
    expect(sqlite.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(
      2,
    )
    expect(compactDatabase(sqlite)).toBe(false)
    sqlite.close()
  })
})
