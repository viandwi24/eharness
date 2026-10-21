/**
 * Backups: a consistent verified snapshot while writers run, a corrupt copy is caught, retention,
 * the files export (zip with manifest and hashes), restore of files as new versions that never
 * delete newer data, `backupBefore` and its alarm.
 */

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { listAlarms } from '../src/app/alarms.ts'
import {
  backupBefore,
  createBackup,
  createBackupScheduler,
  deleteBackup,
  previewRestore,
  restoreFiles,
} from '../src/app/backups.ts'
import { type BackupRecord, dueReason, planRetention, weekOf } from '../src/domain/backups.ts'
import { createBackupService, verifyCopy } from '../src/infra/backup/backup-service.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function instance(): { server: Server; dir: string; agentId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'team-backups-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'backups-test',
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  return { server, dir, agentId: def.id }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Reads a stored (method 0) zip through its central directory. */
function unzip(file: string): Map<string, Uint8Array> {
  const buf = readFileSync(file)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let end = buf.byteLength - 22
  while (view.getUint32(end, true) !== 0x06054b50) end--
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen))
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = buf.subarray(dataAt, dataAt + size)
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : new Uint8Array(data))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const rec = (id: string, at: number, over: Partial<BackupRecord> = {}): BackupRecord => ({
  id,
  createdAt: at,
  reason: 'daily',
  kind: 'daily',
  dbBytes: 1,
  filesBytes: 1,
  fileCount: 0,
  agentCount: 0,
  verified: true,
  error: null,
  exportError: null,
  ...over,
})

describe('snapshot', () => {
  test('is consistent and verified while another process writes', async () => {
    const { server, dir } = instance()
    const db = join(dir, 'team.db')
    // a writer process: each transaction inserts a pair of files, so a consistent copy has equal
    // numbers of `a-` and `b-` files
    const script = join(dir, 'writer.ts')
    writeFileSync(
      script,
      `import { Database } from 'bun:sqlite'
const db = new Database(process.argv[2])
db.run('PRAGMA busy_timeout = 5000')
const ins = db.query("INSERT INTO library_files (path, version, text, size, updated_at) VALUES (?, 'v', 'x', 1, 0)")
let i = 0
const tx = db.transaction((n) => { ins.run('/library/w/a-' + n); ins.run('/library/w/b-' + n) })
const t = Date.now()
while (Date.now() - t < 2500) { tx(i++) }
console.log('done', i)
`,
    )
    const proc = Bun.spawn(['bun', script, db], { stdout: 'pipe' })
    await Bun.sleep(300)
    const records: BackupRecord[] = []
    for (let i = 0; i < 4; i++) {
      records.push(await server.deps.backups!.create('manual'))
      await Bun.sleep(100)
    }
    await proc.exited
    for (const r of records) {
      expect(r.verified).toBe(true)
      const copy = new Database(join(dir, 'backups', `${r.id}.db`), { readonly: true })
      const a = copy
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM library_files WHERE path LIKE '/library/w/a-%'",
        )
        .get()?.n
      const b = copy
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM library_files WHERE path LIKE '/library/w/b-%'",
        )
        .get()?.n
      copy.close()
      expect(a).toBe(b ?? -1)
    }
  })

  test('verification catches a corrupt copy', async () => {
    const { server, dir } = instance()
    const good = await server.deps.backups!.create('manual')
    expect(good.verified).toBe(true)
    const file = join(dir, 'backups', `${good.id}.db`)
    const counts = { files: 0, agents: 1 }
    const live = server.conn.sqlite
      .query<{ n: number }, []>('SELECT count(*) AS n FROM agents')
      .get()?.n
    expect(
      verifyCopy(file, { files: 0, agents: live ?? 0 }, { files: 0, agents: live ?? 0 }).ok,
    ).toBe(true)
    // a wrong row count is caught
    expect(verifyCopy(file, { files: 5, agents: 1 }, { files: 5, agents: 1 }).ok).toBe(false)
    void counts
    // garbage in the header and in half of the pages is caught
    for (const at of [0, 4096]) {
      const bytes = readFileSync(file)
      // the magic string of the header, then half of the pages
      bytes.fill(0xff, at, at === 0 ? 16 : Math.floor(bytes.byteLength / 2))
      const bad = join(dir, `bad-${at}.db`)
      writeFileSync(bad, bytes)
      const verdict = verifyCopy(bad, { files: 0, agents: 0 }, { files: 0, agents: 99 })
      expect(verdict.ok).toBe(false)
    }
  })

  test('a corrupt copy is listed unverified and alarmed, never silently kept as good', async () => {
    const { server, dir } = instance()
    server.deps.backups = createBackupService({
      sqlite: server.conn.sqlite,
      dir: join(dir, 'backups'),
      afterCopy: (file) => {
        const bytes = readFileSync(file)
        bytes.fill(0xff, 4096, Math.floor(bytes.byteLength / 2))
        writeFileSync(file, bytes)
      },
    })
    const out = await createBackup(server.deps, 'manual')
    expect(out.ok).toBe(false)
    const listed = server.deps.backups.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.verified).toBe(false)
    expect(listed[0]?.filesBytes).toBeNull()
    expect(listAlarms(server.deps).alarms.some((a) => a.kind === 'system')).toBe(true)
  })
})

describe('retention', () => {
  const DAY = 86_400_000
  const base = Date.UTC(2026, 9, 22, 12) // Thu 2026-10-22
  const opts = { now: base, timezone: 'UTC', keepDaily: 3, keepWeekly: 2 }

  test('keeps the newest of the last days and weeks, the newest of all, and recent before-snapshots', () => {
    const list = [
      rec('today-2', base),
      rec('today-1', base - 3_600_000),
      rec('d1', base - DAY),
      rec('d2', base - 2 * DAY),
      rec('d3', base - 3 * DAY), // Mon 19th: 4th day, but the newest of its week? week of 22nd = Mon 19th
      rec('d4', base - 4 * DAY), // Sun 18th: previous week, newest of it
      rec('d5', base - 5 * DAY), // Sat 17th: same week as d4, older
      rec('d12', base - 12 * DAY), // third week back
      rec('before-recent', base - 10 * DAY - 3_600_000, { kind: 'before', reason: 'before: x' }),
      rec('before-old', base - 60 * DAY, { kind: 'before', reason: 'before: y' }),
      rec('broken', base - 20 * DAY, { verified: false, error: 'x' }),
    ]
    const plan = planRetention(list, opts)
    expect(plan.keep.sort()).toEqual(['today-2', 'd1', 'd2', 'd4', 'before-recent'].sort())
    expect(plan.remove.sort()).toEqual(['today-1', 'd3', 'd5', 'd12', 'before-old'].sort())
    // an unverified snapshot is never removed by a rule
    expect(plan.remove).not.toContain('broken')
    expect(weekOf('2026-10-22')).toBe('2026-10-19')
  })

  test('the newest verified snapshot always survives', () => {
    const plan = planRetention([rec('only', base - 400 * DAY)], opts)
    expect(plan.keep).toEqual(['only'])
  })

  test('due: one verified daily or startup snapshot per local day, from the set time', () => {
    const s = {
      backupEnabled: true,
      backupTime: '02:00',
      backupKeepDaily: 14,
      backupKeepWeekly: 8,
      timezone: 'UTC',
    }
    const at = (h: number): number => Date.UTC(2026, 9, 22, h)
    expect(dueReason([], { now: at(1), startup: false, s })).toBeNull()
    expect(dueReason([], { now: at(3), startup: false, s })).toBe('daily')
    expect(dueReason([], { now: at(1), startup: true, s })).toBe('startup')
    expect(dueReason([rec('x', at(2))], { now: at(5), startup: true, s })).toBeNull()
    expect(
      dueReason([rec('x', at(2), { verified: false })], { now: at(5), startup: false, s }),
    ).toBe('daily')
    expect(
      dueReason([], { now: at(5), startup: true, s: { ...s, backupEnabled: false } }),
    ).toBeNull()
  })
})

describe('export', () => {
  test('the zip holds every file with the right hash, memory by agent slug', async () => {
    const { server, agentId } = instance()
    const fs = libraryFs(server.conn.sqlite)
    const bin = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9])
    await fs.write('/library/reports/q1.md', '# Q1\nrevenue up')
    await fs.write('/library/ünï/名前.txt', 'unicode name')
    await fs.writeBytes?.('/library/data/blob.bin', bin)
    await fs.write(`/memories/agents/${agentId}/profile.md`, 'I am the lead')
    await fs.write('/memories/workspace/profile.md', 'We make things')
    await fs.write('/.eharness/tool-media/x.png', 'cache')
    const record = await server.deps.backups!.create('manual')
    expect(record.verified).toBe(true)
    const zipFile = join(server.deps.backups!.dir, `${record.id}.zip`)
    const entries = unzip(zipFile)
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))) as {
      files: Array<{
        path: string
        libraryPath: string
        size: number
        sha256: string
        updatedAt: number
      }>
      excluded: Array<{ prefix: string }>
    }
    const live = server.conn.sqlite
      .query<{ path: string }, []>(
        "SELECT path FROM library_files WHERE path NOT LIKE '/.eharness/tool-media/%'",
      )
      .all()
    expect(manifest.files.map((f) => f.libraryPath).sort()).toEqual(live.map((l) => l.path).sort())
    expect(manifest.excluded[0]?.prefix).toBe('/.eharness/tool-media')
    for (const f of manifest.files) {
      const bytes = entries.get(f.path.slice(1))
      expect(bytes).toBeDefined()
      expect(sha256(bytes as Uint8Array)).toBe(f.sha256)
      expect(f.size).toBe((bytes as Uint8Array).byteLength)
      expect(f.updatedAt).toBeGreaterThan(0)
    }
    expect(entries.get('library/data/blob.bin')).toEqual(bin)
    expect(new TextDecoder().decode(entries.get('library/reports/q1.md'))).toBe('# Q1\nrevenue up')
    expect(new TextDecoder().decode(entries.get('library/ünï/名前.txt'))).toBe('unicode name')
    expect(new TextDecoder().decode(entries.get('memories/agents/lead/profile.md'))).toBe(
      'I am the lead',
    )
    expect(entries.has('memories/workspace/profile.md')).toBe(true)
  })
})

describe('restore', () => {
  const read = (server: Server, path: string): string | undefined =>
    server.conn.sqlite
      .query<{ text: string }, [string]>('SELECT text FROM library_files WHERE path = ?')
      .get(path)?.text

  test('creates missing files, replaces changed ones only in mode all, never deletes newer files', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/a.md', 'a v1')
    await fs.write('/library/dir/b.md', 'b v1')
    await fs.write('/library/dir/c.md', 'c v1')
    const snap = await server.deps.backups!.create('manual')
    // later: a changed, b deleted, d new, c untouched
    await fs.write('/library/a.md', 'a v2 newer')
    await fs.delete('/library/dir/b.md')
    await fs.write('/library/d.md', 'd new')

    const plan = previewRestore(server.deps, snap.id, { path: '/', mode: 'missing' })
    expect(plan.counts).toEqual({ create: 1, replace: 0, keep: 1, same: expect.any(Number) })
    expect(plan.entries[0]).toMatchObject({ path: '/library/dir/b.md', action: 'create' })
    // a preview writes nothing
    expect(read(server, '/library/dir/b.md')).toBeUndefined()

    const r1 = await restoreFiles(server.deps, snap.id, { path: '/', mode: 'missing' })
    expect(r1).toMatchObject({ created: 1, replaced: 0, kept: 1, failed: [] })
    expect(read(server, '/library/dir/b.md')).toBe('b v1')
    expect(read(server, '/library/a.md')).toBe('a v2 newer')
    expect(read(server, '/library/d.md')).toBe('d new')
    expect(r1.safetyBackupId).not.toBeNull()
    expect(server.deps.backups?.get(r1.safetyBackupId as string)?.reason).toContain(
      'before: restore',
    )

    // one file, mode all: replaced, previous version stays in the history
    const history = (path: string): number =>
      server.conn.sqlite
        .query<{ n: number }, [string]>('SELECT count(*) AS n FROM library_history WHERE path = ?')
        .get(path)?.n ?? 0
    const before = history('/library/a.md')
    const r2 = await restoreFiles(server.deps, snap.id, { path: '/library/a.md', mode: 'all' })
    expect(r2).toMatchObject({ created: 0, replaced: 1 })
    expect(read(server, '/library/a.md')).toBe('a v1')
    expect(history('/library/a.md')).toBe(before + 1)
    expect(read(server, '/library/d.md')).toBe('d new')

    // a folder
    await fs.write('/library/dir/c.md', 'c edited')
    const r3 = await restoreFiles(server.deps, snap.id, { path: '/library/dir/', mode: 'all' })
    expect(r3).toMatchObject({ replaced: 1, created: 0 })
    expect(read(server, '/library/dir/c.md')).toBe('c v1')
    expect(read(server, '/library/d.md')).toBe('d new')

    // nothing to do: no safety snapshot, nothing written
    const r4 = await restoreFiles(server.deps, snap.id, { path: '/', mode: 'missing' })
    expect(r4).toMatchObject({ created: 0, replaced: 0 })
    expect(r4.safetyBackupId).toBeNull()
  })

  test('a failed safety snapshot stops the restore', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/a.md', 'a v1')
    const snap = await server.deps.backups!.create('manual')
    await fs.delete('/library/a.md')
    const real = server.deps.backups!
    server.deps.backups = { ...real, create: () => Promise.reject(new Error('disk full')) }
    await expect(restoreFiles(server.deps, snap.id, { path: '/', mode: 'all' })).rejects.toThrow(
      /safety backup failed/,
    )
    expect(read(server, '/library/a.md')).toBeUndefined()
  })
})

describe('backupBefore and the schedule', () => {
  test('backupBefore takes a verified snapshot tagged with the reason', async () => {
    const { server } = instance()
    const out = await backupBefore(server.deps, 'move memory into the library')
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.backup.kind).toBe('before')
      expect(out.backup.reason).toBe('before: move memory into the library')
      expect(out.backup.verified).toBe(true)
    }
  })

  test('a failed backupBefore answers ok: false and raises a system alarm', async () => {
    const { server } = instance()
    server.deps.backups = {
      ...server.deps.backups!,
      create: () => Promise.reject(new Error('no space left')),
    }
    const out = await backupBefore(server.deps, 'bulk delete')
    expect(out.ok).toBe(false)
    const alarms = listAlarms(server.deps).alarms
    expect(alarms.some((a) => a.kind === 'system' && a.text.includes('backup'))).toBe(true)
  })

  test('the scheduler snapshots once at start-up, then not again the same day', async () => {
    const { server } = instance()
    const scheduler = createBackupScheduler(server.deps)
    const first = await scheduler.tick(true)
    expect(first?.ok).toBe(true)
    expect(await scheduler.tick(false)).toBeUndefined()
    expect(server.deps.backups?.list().map((b) => b.reason)).toEqual(['startup'])
  })

  test('the newest verified snapshot cannot be deleted by hand', async () => {
    const { server } = instance()
    const a = await server.deps.backups!.create('manual')
    await Bun.sleep(5)
    const b = await server.deps.backups!.create('manual')
    expect(() => deleteBackup(server.deps, b.id)).toThrow(/newest verified/)
    deleteBackup(server.deps, a.id)
    expect(server.deps.backups?.list().map((r) => r.id)).toEqual([b.id])
  })
})

describe('http', () => {
  test('list, back up now, download both files streaming, settings knobs', async () => {
    const { server } = instance()
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/a.md', 'hello')
    const created = (await (await server.app.request('/backups', { method: 'POST' })).json()) as {
      ok: boolean
      backup: BackupRecord
    }
    expect(created.ok).toBe(true)
    const list = (await (await server.app.request('/backups')).json()) as {
      backups: BackupRecord[]
      stale: boolean
    }
    expect(list.backups).toHaveLength(1)
    expect(list.stale).toBe(false)
    const db = await server.app.request(`/backups/${created.backup.id}/db`)
    expect(db.headers.get('content-disposition')).toContain('attachment')
    expect((await db.arrayBuffer()).byteLength).toBe(created.backup.dbBytes)
    const files = await server.app.request(`/backups/${created.backup.id}/files`)
    expect(files.headers.get('content-type')).toBe('application/zip')
    expect((await files.arrayBuffer()).byteLength).toBe(created.backup.filesBytes as number)
    expect((await server.app.request('/backups/nope/db')).status).toBe(404)
    const bad = await server.app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupTime: '25:00' }),
    })
    expect(bad.status).toBe(400)
    const ok = await server.app.request('/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupTime: '03:30', backupKeepDaily: 7, backupKeepWeekly: 4 }),
    })
    expect(ok.status).toBe(200)
    expect(server.deps.settings.get()).toMatchObject({
      backupTime: '03:30',
      backupKeepDaily: 7,
      backupKeepWeekly: 4,
      backupEnabled: true,
    })
  })
})
