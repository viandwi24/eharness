/**
 * The proof of docs/plans/P58-backup-coverage.md: EVERY feature is filled through the real app, the
 * workspace is exported with a passphrase, a fresh empty instance imports it with overwrite, and
 * every table that the zip restores is compared entity by entity (ids of agents and volatile times
 * normalised). Also: a second import changes nothing, the undo puts the previous state back, the
 * whole-database restore round trip with its undo (a staged restore swapped in at the restart), and
 * the secrets work after a restore (a provider profile and a connection hold their secret, an API
 * key authenticates).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup } from '../src/app/backups.ts'
import { restoreDatabase } from '../src/app/database-restore.ts'
import {
  applyImport,
  listRestorePoints,
  previewImport,
  previewUndo,
} from '../src/app/workspace-import.ts'
import { COVERAGE } from '../src/domain/backup-coverage.ts'
import { SECTIONS } from '../src/domain/workspace-data.ts'
import type { Server } from '../src/main.ts'
import {
  type BaseWorld,
  cleanup,
  closeServer,
  instance,
  json,
  newSecretKey,
  populateBase,
  SECRET,
} from './support/backup-world.ts'
import { type ApiWorld, populateApi } from './support/populate-api.ts'
import { type ChannelsWorld, populateChannels } from './support/populate-channels.ts'
import { type HistoryWorld, populateHistory } from './support/populate-history.ts'

afterEach(cleanup)

const PASSPHRASE = 'correct horse battery staple'
const PROVIDER_KEY = 'sk-or-backup-everything-1234567890'

interface Everything {
  server: Server
  base: BaseWorld
  channels: ChannelsWorld
  api: ApiWorld
  history: HistoryWorld
}

async function populateEverything(server: Server): Promise<Everything> {
  const base = await populateBase(server)
  const made = await server.app.request(
    '/providers/profiles',
    json({
      providerId: 'openrouter',
      id: 'main-key',
      label: 'Main key',
      settings: { apiKey: PROVIDER_KEY },
    }),
  )
  expect(made.status).toBeLessThan(300)
  const channels = await populateChannels(server, base)
  const api = await populateApi(server, base)
  const history = await populateHistory(server, base)
  // briefings: the app no longer writes them (legacy digest pages), so a row is inserted like the old code did
  server.conn.sqlite
    .query(
      'INSERT INTO briefings (id, day, title, body, items, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('brief-1', '2026-01-02', 'Daily briefing', '# Today\n- all quiet', '[]', 1)
  return { server, base, channels, api, history }
}

// --- comparing a workspace -----------------------------------------------------------------------

/** Columns that legitimately differ after a restore: times, versions, counters of the restore itself. */
const VOLATILE = /(^|_)at$|^(version|rev|seq)$|^updated|^created|^last_|^claimed_/

/** Tables compared by another route than their rows. */
const COMPARED_ELSEWHERE = new Set([
  'library_files', // by path and content hash
  'config_profiles', // by the secrets port
  'api_keys', // by the secrets port
])

/** Tables whose rows are rebuilt by the app (new random ids): compared without them. */
const DROP_COLUMNS: Record<string, string[]> = {
  routines: ['id'],
  // the lead's own persona version row of a seeded workspace is generated
  agent_persona_versions: [],
}

type Rows = Record<string, string[]>

const zipTables = (): string[] =>
  COVERAGE.filter((c) => c.class === 'zip' && !COMPARED_ELSEWHERE.has(c.table)).map((c) => c.table)

/** Rows of every table the zip restores, as sorted comparable strings. */
function snapshot(server: Server, tables = zipTables()): Rows {
  const sqlite = server.conn.sqlite
  const agents = sqlite.query<{ id: string; slug: string }, []>('SELECT id, slug FROM agents').all()
  const pattern =
    agents.length === 0 ? undefined : new RegExp(agents.map((a) => a.id).join('|'), 'g')
  const slugOf = new Map(agents.map((a) => [a.id, a.slug]))
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => (x < y ? -1 : 1))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v
  const norm = (v: unknown): unknown => {
    if (v instanceof Uint8Array) return `b64:${Buffer.from(v).toString('base64')}`
    let text = v
    if (typeof text === 'string' && pattern !== undefined) {
      text = text.replace(pattern, (m) => `<agent:${slugOf.get(m)}>`)
    }
    // JSON text compares by content, not by the order of keys
    if (typeof text === 'string' && /^[[{]/.test(text)) {
      try {
        return JSON.stringify(canonical(JSON.parse(text)))
      } catch {
        // plain text
      }
    }
    return text
  }
  const out: Rows = {}
  for (const table of tables) {
    let rows = sqlite.query<Record<string, unknown>, []>(`SELECT * FROM "${table}"`).all()
    // the default empty "Chat" thread of an agent is created at every start: derived, not compared
    // the digest configuration is written by the import; a workspace that never changed it has defaults
    if (table === 'settings') rows = rows.filter((r) => r.key !== 'digest:config')
    // the heartbeat schedule of an agent is made at start (or when the import creates the agent)
    if (table === 'routines') {
      rows = rows.filter((r) => !String(r.program_id ?? '').startsWith('sys:heartbeat:'))
    }
    if (table === 'chat_threads') {
      rows = rows.filter((r) => !(r.title === 'Chat' && r.preview === null && r.seed === null))
    }
    out[table] = rows
      .map((r) => {
        const o: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (VOLATILE.test(k) || (DROP_COLUMNS[table] ?? []).includes(k)) continue
          o[k] = norm(v)
        }
        return JSON.stringify(o)
      })
      .sort()
  }
  return out
}

/** Differences of two snapshots, readable, for the failure message (empty = equal). */
function differences(a: Rows, b: Rows): string[] {
  const out: string[] = []
  for (const table of Object.keys(a)) {
    const left = a[table] ?? []
    const right = b[table] ?? []
    const rs = new Set(right)
    const ls = new Set(left)
    const missing = left.filter((r) => !rs.has(r))
    const extra = right.filter((r) => !ls.has(r))
    if (missing.length > 0 || extra.length > 0) {
      out.push(
        `${table}: ${left.length} -> ${right.length}\n  missing: ${missing
          .slice(0, 2)
          .map((r) => r.slice(0, 400))
          .join('\n           ')}\n  extra:   ${extra
          .slice(0, 2)
          .map((r) => r.slice(0, 400))
          .join('\n           ')}`,
      )
    }
  }
  return out
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Library files by path (agent memory by slug) and content hash. */
async function files(server: Server): Promise<Record<string, string>> {
  const slugs = new Map(
    server.deps.agents.list({ includeArchived: true }).map((a) => [a.id, a.slug]),
  )
  const out: Record<string, string> = {}
  for (const m of server.deps.library.list({
    prefix: '/',
    excludePrefixes: ['/.eharness/tool-media/'],
    limit: 1_000_000,
  })) {
    const f = await server.deps.library.read(m.path)
    const bytes = f?.bytes ?? new TextEncoder().encode(f?.text ?? '')
    const shown = m.path.replace(
      /^\/memories\/agents\/([^/]+)\//,
      (_, id: string) => `/memories/agents/${slugs.get(id) ?? id}/`,
    )
    out[shown] = sha(bytes)
  }
  return out
}

/** The secrets as the port sees them, without write times and use counters. */
async function secrets(server: Server): Promise<string[]> {
  const records = (await server.deps.secrets?.list()) ?? []
  return records
    .map((r) =>
      JSON.stringify({
        key: r.key,
        rows: r.rows
          .map((x) => ({
            kind: x.kind,
            id: x.id,
            profile: Object.fromEntries(
              Object.entries(x.profile).filter(
                ([k]) => !VOLATILE.test(k) && !['scopeId', 'source'].includes(k),
              ),
            ),
          }))
          .sort((p, q) => (p.kind + p.id < q.kind + q.id ? -1 : 1)),
      }),
    )
    .sort()
}

const zipOf = async (server: Server, includeConversations = true): Promise<Uint8Array> => {
  const res = await server.app.request(
    '/backups/export',
    json({ passphrase: PASSPHRASE, includeConversations }),
  )
  expect(res.status).toBe(200)
  return new Uint8Array(await res.arrayBuffer())
}

const stage = (server: Server, bytes: Uint8Array) =>
  (server.deps.backups as NonNullable<typeof server.deps.backups>).stageUpload(bytes, 'all.zip')

const ALL_SECTIONS = [...SECTIONS]

// --- the tests -----------------------------------------------------------------------------------

describe('backup everything', () => {
  test('every table the zip restores has data in the populated workspace', async () => {
    const { server } = await populateEverything(instance().server)
    const empty = Object.entries(snapshot(server))
      .filter(([, rows]) => rows.length === 0)
      .map(([t]) => t)
    // the persona proposals, rehearsals ... must all be filled: nothing is proven by an empty table
    expect(
      empty,
      `tables with no rows (fill them in a populate-* helper): ${empty.join(', ')}`,
    ).toEqual([])
    const sqlite = server.conn.sqlite
    for (const table of ['library_files', 'config_profiles', 'api_keys']) {
      const n = sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0
      expect(n, table).toBeGreaterThan(0)
    }
  })

  test('export, a fresh empty instance, import with overwrite: every feature equal', async () => {
    const a = await populateEverything(instance({ seedAgents: false }).server)
    const before = snapshot(a.server)
    const bytes = await zipOf(a.server)

    const b = instance({ seedAgents: false }).server
    await b.connectorsReady
    const emptyB = snapshot(b)
    const staged = await stage(b, bytes)
    const source = { uploadId: staged.uploadId }
    const preview = await previewImport(b.deps, source, { passphrase: PASSPHRASE })
    expect(preview.secrets).toMatchObject({ included: true, unlocked: true })
    expect(preview.items.filter((i) => i.applicable === false && i.blocked !== null)).toEqual([])

    const result = await applyImport(
      b.deps,
      source,
      { sections: ALL_SECTIONS, overwrite: true },
      { by: 'web', passphrase: PASSPHRASE },
    )
    expect(result.items.filter((i) => i.action === 'failed')).toEqual([])
    expect(result.counts.failed).toBe(0)

    expect(differences(before, snapshot(b))).toEqual([])
    expect(await files(b)).toEqual(await files(a.server))
    expect(await secrets(b)).toEqual(await secrets(a.server))

    // a second import has nothing left to do
    const again = await previewImport(b.deps, source, { passphrase: PASSPHRASE })
    expect(
      again.items
        .filter((i) => i.status === 'added' || i.status === 'changed')
        .map((i) => `${i.key}: ${i.status}`),
    ).toEqual([])

    // the undo puts the empty workspace back (agents are archived: an import never deletes them)
    const point = listRestorePoints(b.deps)[0]
    const undo = await previewUndo(b.deps, point?.id as string)
    const undone = await applyImport(
      b.deps,
      undo.source,
      { ...undo.selection },
      { by: 'web', undoOf: point?.id as string },
    )
    expect(undone.counts.failed).toBe(0)
    const after = snapshot(b)
    for (const table of Object.keys(emptyB)) {
      if (
        [
          'agents',
          'agent_connectors',
          'agent_persona_versions',
          'agent_persona_proposals',
          'routines',
          'programs',
          'program_tests',
          'rehearsals',
          'chats',
          'chat_threads',
          'people_events',
        ].includes(table)
      ) {
        continue
      }
      // the workspace row keeps the restored defaults, and an archived agent keeps its heartbeat settings
      const keep = (r: string): boolean =>
        table !== 'settings' || !/"key":"(workspace|heartbeat:[^"]*:config)"/.test(r)
      expect((after[table] ?? []).filter(keep), `${table} after the undo`).toEqual(
        (emptyB[table] ?? []).filter(keep),
      )
    }
    expect(b.deps.agents.list().filter((x) => x.slug === 'forecaster')).toEqual([])
    expect(Object.keys(await files(b)).filter((p) => p.startsWith('/library/reports'))).toEqual([])
  })

  test('into a workspace with the example agents seeded (other ids): references are remapped', async () => {
    const a = await populateEverything(instance({ seedAgents: true }).server)
    const before = snapshot(a.server)
    const bytes = await zipOf(a.server)
    const b = instance({ seedAgents: true }).server
    await b.connectorsReady
    // the seeded agents of the two instances have different ids
    expect(b.deps.agents.getBySlug('lead')?.id).not.toBe(a.base.leadId)
    const staged = await stage(b, bytes)
    const result = await applyImport(
      b.deps,
      { uploadId: staged.uploadId },
      { sections: ALL_SECTIONS, overwrite: true },
      { by: 'web', passphrase: PASSPHRASE },
    )
    expect(result.items.filter((i) => i.action === 'failed')).toEqual([])
    expect(differences(before, snapshot(b))).toEqual([])
  })

  test('secrets work after the restore: a provider profile, a connection, an API key', async () => {
    const a = await populateEverything(instance({ seedAgents: false }).server)
    const bytes = await zipOf(a.server)
    // another server key: the zip depends on the passphrase only
    const b = instance({ seedAgents: false, secretKey: newSecretKey() }).server
    await b.connectorsReady
    const staged = await stage(b, bytes)
    const done = await applyImport(
      b.deps,
      { uploadId: staged.uploadId },
      { sections: ALL_SECTIONS, overwrite: true },
      { by: 'web', passphrase: PASSPHRASE },
    )
    expect(done.counts.failed).toBe(0)
    const all = (await b.deps.secrets?.list()) ?? []
    const provider = all.find((r) => r.key === 'provider/main-key')
    expect(((provider?.rows[0]?.profile.settings ?? {}) as Record<string, unknown>).apiKey).toBe(
      PROVIDER_KEY,
    )
    expect(b.deps.providers.profileIds()).toContain('main-key')
    // the connection is connected again and its credentials are the exported ones
    const conn = all.find((r) => r.key === `connection/${a.base.connectionId}`)
    expect(JSON.stringify(conn)).toContain(SECRET)
    const test = await b.deps.connectors.testConnection(a.base.connectionId)
    expect(test.ok).toBe(true)
    // the API key authenticates and a wrong one does not
    const ok = await b.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${a.api.apiKey}` },
    })
    expect(ok.status).toBe(200)
    const bad = await b.app.request('/v1/agents', { headers: { authorization: 'Bearer nope' } })
    expect(bad.status).toBe(401)
    // the shared artifact keeps its link
    const shared = b.conn.sqlite
      .query<{ share_token: string | null }, [string]>(
        'SELECT share_token FROM artifacts WHERE id = ?',
      )
      .get(a.api.sharedArtifactId)
    expect(shared?.share_token).toBe(a.api.shareToken)
  })

  test('the zip holds no plain secret, and a zip without conversations restores everything else', async () => {
    const a = await populateEverything(instance({ seedAgents: false }).server)
    const bytes = await zipOf(a.server, false)
    const text = Buffer.from(bytes).toString('latin1')
    for (const needle of [PROVIDER_KEY, SECRET, a.api.apiKey, a.api.shareToken]) {
      expect(text.includes(needle)).toBe(false)
    }
    const b = instance({ seedAgents: false }).server
    await b.connectorsReady
    const staged = await stage(b, bytes)
    const preview = await previewImport(b.deps, { uploadId: staged.uploadId })
    expect(preview.items.some((i) => i.section === 'conversations')).toBe(false)
    const done = await applyImport(
      b.deps,
      { uploadId: staged.uploadId },
      { overwrite: true },
      { by: 'web' },
    )
    expect(done.counts.failed).toBe(0)
    const conversations = ['eh_messages', 'eh_state', 'chat_threads', 'session_modes']
    const left = snapshot(b, conversations)
    expect(left.eh_messages?.length ?? 0).toBe(0)
  })
})

describe('restore the whole database', () => {
  test('a staged restore is swapped in at the restart, and its undo brings the old state back', async () => {
    const secretKey = newSecretKey()
    const channelKey = newSecretKey()
    let restarts = 0
    const first = instance({ secretKey, channelKey, onRestart: () => restarts++ })
    const everything = await populateEverything(first.server)
    const created = await createBackup(first.server.deps, 'manual')
    expect(created.ok).toBe(true)
    const backupId = created.ok ? created.backup.id : ''
    const atBackup = snapshot(first.server)
    const filesAtBackup = await files(first.server)

    // the workspace moves on: new and removed data
    const fs = (await import('../src/infra/eh/library-fs.ts')).libraryFs(first.server.conn.sqlite)
    await fs.write('/library/after-the-backup.md', 'written later')
    await fs.delete('/library/reports/q1.md')
    first.server.conn.sqlite.run('DELETE FROM decisions')
    first.server.conn.sqlite.run('DELETE FROM people')
    const moved = snapshot(first.server)
    expect(differences(atBackup, moved).length).toBeGreaterThan(0)

    // a wrong phrase is refused, nothing is staged
    await expect(
      restoreDatabase(first.server.deps, backupId, { confirm: 'yes', by: 'web' }),
    ).rejects.toThrow(/confirm/)
    expect(first.server.deps.backups?.database.pending()).toBeUndefined()

    const res = await restoreDatabase(first.server.deps, backupId, {
      confirm: 'Restore whole database',
      by: 'web',
    })
    expect(res.restart).toBe('automatic')
    expect(restarts).toBe(1)
    expect(first.server.deps.backups?.database.pending()?.backupId).toBe(backupId)
    expect((await first.server.app.request('/backups/database-restore')).status).toBe(200)
    // nothing changed yet: the running database is still the moved one
    expect(differences(moved, snapshot(first.server))).toEqual([])

    // the restart: close, open the same database file again
    await closeServer(first.server)
    const second = instance({ secretKey, channelKey, dir: first.dir, onRestart: () => restarts++ })
    await second.server.connectorsReady
    expect(second.server.deps.backups?.database.pending()).toBeUndefined()
    expect(second.server.deps.backups?.database.lastResult()).toMatchObject({
      ok: true,
      backupId,
    })
    expect(differences(atBackup, snapshot(second.server))).toEqual([])
    expect(await files(second.server)).toEqual(filesAtBackup)
    expect(await secrets(second.server)).toContain(
      (await secrets(second.server)).find((s) => s.includes('main-key')) as string,
    )
    // the API key still authenticates, the secrets still open (same keys)
    const auth = await second.server.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${everything.api.apiKey}` },
    })
    expect(auth.status).toBe(200)

    // the restore point is listed and its undo is the same operation from the safety backup
    const point = listRestorePoints(second.server.deps).find((p) => p.kind === 'database-restore')
    expect(point).toBeDefined()
    await expect(previewUndo(second.server.deps, point?.id as string)).rejects.toThrow(/database/i)
    const undo = await restoreDatabase(second.server.deps, point?.safetyBackupId as string, {
      confirm: 'restore whole database',
      by: 'web',
      undoOf: point?.id as string,
    })
    expect(undo.restart).toBe('automatic')
    await closeServer(second.server)
    const third = instance({ secretKey, channelKey, dir: first.dir })
    await third.server.connectorsReady
    expect(differences(moved, snapshot(third.server))).toEqual([])
    const afterUndo = await files(third.server)
    expect(afterUndo['/library/after-the-backup.md']).toBeDefined()
    expect(afterUndo['/library/reports/q1.md']).toBeUndefined()
    // the point of the restore is marked undone
    expect(
      listRestorePoints(third.server.deps).find((p) => p.id === point?.id)?.undoneBy,
    ).not.toBeNull()
    // the old database file is kept aside until the next restore
    expect(readFileSync(join(first.dir, 'team.db.replaced')).byteLength).toBeGreaterThan(0)
  })

  test('a damaged staged copy is not applied: the server starts on the database it had', async () => {
    const secretKey = newSecretKey()
    const channelKey = newSecretKey()
    const first = instance({ secretKey, channelKey })
    await populateBase(first.server)
    const before = snapshot(first.server)
    const { writeFileSync } = await import('node:fs')
    await closeServer(first.server)
    writeFileSync(`${first.dbFile}.restore`, 'this is not a database')
    writeFileSync(
      `${first.dbFile}.restore.json`,
      JSON.stringify({ backupId: 'x', safetyBackupId: 'y', restorePointId: 'z', stagedAt: 1 }),
    )
    const second = instance({ secretKey, channelKey, dir: first.dir })
    await second.server.connectorsReady
    expect(differences(before, snapshot(second.server))).toEqual([])
    expect(second.server.deps.backups?.database.lastResult()?.ok).toBe(false)
  })
})
