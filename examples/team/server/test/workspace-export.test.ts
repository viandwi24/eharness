/**
 * The workspace export (one readable zip) and its import: every entity type in the zip, a round trip
 * export -> wipe -> import, the preview (counts, readable diffs, authority), unticking, never
 * deleting without the tick, restore points and undo, corrupt/tampered/zip-slip/oversize zips
 * refused, secrets absent.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { restoreFiles } from '../src/app/backups.ts'
import { setHeartbeat } from '../src/app/heartbeat.ts'
import { editPersona } from '../src/app/persona.ts'
import { createProgram } from '../src/app/programs.ts'
import { createRoutine } from '../src/app/routines.ts'
import { patchSettings } from '../src/app/settings.ts'
import { collectEntities } from '../src/app/workspace-export.ts'
import {
  applyImport,
  listRestorePoints,
  previewImport,
  previewUndo,
} from '../src/app/workspace-import.ts'
import { comparable } from '../src/domain/workspace-docs.ts'
import {
  bytesOf,
  canonicalJson,
  classify,
  IMPORT_LIMITS,
  type ImportPreview,
  textOf,
} from '../src/domain/workspace-export.ts'
import { zip } from '../src/infra/artifacts/zip.ts'
import { sha256 } from '../src/infra/backup/workspace-zip.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { fakeMcp } from './support/fake-mcp.ts'

const servers: Server[] = []
const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const stop of stops.splice(0)) stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SECRET_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

function instance(): Server {
  const dir = mkdtempSync(join(tmpdir(), 'team-workspace-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'workspace-test',
    models: scriptedModelConfig(scriptedModel([]) as never),
    env: { TEAM_SECRET_KEY: SECRET_KEY, TEAM_ALLOW_PRIVATE_MCP: '1' },
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  return server
}

const SECRET = 'HEADERSECRET9'

interface World {
  server: Server
  analystId: string
  connectionId: string
}

/** A workspace with one of everything: a second agent, persona, heartbeat, program, routine, connection, person, files, memory. */
async function populate(server: Server): Promise<World> {
  await server.connectorsReady
  const mcp = fakeMcp()
  stops.push(() => mcp.server.stop(true))
  const made = await server.app.request('/connectors/custom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Company docs',
      url: `${mcp.url}?token=${SECRET}`,
      signIn: 'none',
      headers: { 'X-Api-Key': SECRET },
      availableToAll: false,
    }),
  })
  expect(made.status).toBe(201)
  const connectionId = ((await made.json()) as { connection: { id: string } }).connection.id
  const deps = server.deps
  const analyst = createAgent(deps, {
    name: 'Forecaster',
    instructions: 'Analyse the numbers and report plainly.',
    description: 'Looks at numbers',
    permissionMode: 'manual',
    rules: { allow: ['Read'] },
  })
  updateAgent(deps, analyst.id, {
    connectors: { ...analyst.connectors, [connectionId]: { enabled: 'on' } as never },
  })
  editPersona(deps, analyst.id, {
    identity: {
      displayName: 'Ana',
      about: 'The numbers person',
      language: 'English',
      emoji: false,
    },
    voice: 'Short and exact.\nNo filler.',
    operatingRules: 'Escalate anything above 10 000 to the owner.',
  })
  await setHeartbeat(deps, analyst.id, { everyMinutes: 45 })
  createProgram(deps, {
    agentId: analyst.id,
    name: 'Weekly report',
    brief: 'Collect the weekly numbers.\nWrite them to /library/reports.',
    authority: { tools: ['Read'], read: ['/library/'], write: ['/library/reports/'] },
    trigger: { kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1', tz: 'UTC' } },
  })
  createRoutine(deps, {
    agentId: analyst.id,
    name: 'Morning check',
    prompt: 'Check the dashboard.',
    schedule: { kind: 'cron', expr: '30 8 * * *', tz: 'UTC' },
  })
  await deps.people.create({
    displayName: 'Dewi Example',
    role: 'admin',
    fields: { branch: 'North' },
    notes: 'Prefers short messages',
  })
  patchSettings(deps, { teamName: 'Acme Team' })
  const fs = libraryFs(server.conn.sqlite)
  await fs.write('/library/reports/q1.md', '# Q1\nrevenue up\nmargin flat')
  await fs.write('/library/notes/ünï.txt', 'unicode name')
  await fs.writeBytes?.('/library/data/blob.bin', new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9]))
  await fs.write('/memories/workspace/profile.md', 'We make things')
  await fs.write(`/memories/agents/${analyst.id}/profile.md`, 'I am the forecaster')
  await fs.write(
    `/memories/agents/${analyst.id}/HEARTBEAT.md`,
    '# Heartbeat\n- watch the weekly report\n',
  )
  return { server, analystId: analyst.id, connectionId }
}

// --- state of a workspace, comparable across ids ------------------------------------------------

/** Everything the export covers, keyed by a name (not an id), so a recreated entity compares equal. */
async function stateOf(server: Server): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of await collectEntities(server.deps)) {
    const kind = classify(f.path)?.kind ?? 'other'
    if (f.path.endsWith('.md')) {
      out[f.path] = textOf(f.bytes)
      continue
    }
    const doc = JSON.parse(textOf(f.bytes)) as Record<string, unknown>
    if (kind === 'routine') {
      const slug = f.path.split('/')[1]
      out[`routine:${slug}:${String(doc.name)}`] = canonicalJson(comparable('routine', doc))
    } else if (kind === 'person') {
      out[`person:${String(doc.displayName)}`] = canonicalJson(comparable('person', doc))
    } else if (kind === 'reminder') {
      out[f.path] = canonicalJson(doc)
    } else if (kind === 'settings') {
      // `backupEnabled` and friends are plain settings: they are part of the state too
      out[f.path] = canonicalJson(doc)
    } else {
      out[f.path] = canonicalJson(doc)
    }
  }
  const slugs = new Map(
    server.deps.agents.list({ includeArchived: true }).map((a) => [a.id, a.slug]),
  )
  for (const m of server.deps.library.list({
    prefix: '/',
    excludePrefixes: ['/.eharness/tool-media/'],
    limit: 100000,
  })) {
    const file = await server.deps.library.read(m.path)
    const bytes = file?.bytes ?? bytesOf(file?.text ?? '')
    const shown = m.path.replace(
      /^\/memories\/agents\/([^/]+)\//,
      (_, id: string) => `/memories/agents/${slugs.get(id) ?? id}/`,
    )
    out[`file:${shown}`] = sha256(bytes)
  }
  return out
}

const backupZip = (server: Server, id: string): Uint8Array =>
  readFileSync(join(server.deps.backups?.dir as string, `${id}.zip`))

/** Reads a zip's entries through its central directory (stored or deflated). */
function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let end = buf.byteLength - 22
  while (view.getUint32(end, true) !== 0x06054b50) end--
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen))
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    out.set(name, buf.slice(dataAt, dataAt + size))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** A well-formed workspace zip built by hand (a manifest with the right hashes). */
function makeZip(
  files: Record<string, string | Uint8Array>,
  options: { manifest?: (m: Record<string, unknown>) => Record<string, unknown> } = {},
): Uint8Array {
  const entries = Object.entries(files).map(([path, v]) => ({
    path,
    bytes: typeof v === 'string' ? bytesOf(v) : v,
  }))
  const manifest = {
    format: 'eharness-team-workspace',
    formatVersion: 1,
    app: { name: 'test', version: '0' },
    createdAt: 1,
    counts: {},
    files: entries.map((e) => ({
      path: e.path,
      size: e.bytes.byteLength,
      sha256: createHash('sha256').update(e.bytes).digest('hex'),
    })),
    excluded: [],
    notice: '',
  }
  const m = options.manifest === undefined ? manifest : options.manifest(manifest)
  return zip([...entries, { path: 'manifest.json', bytes: bytesOf(JSON.stringify(m)) }])
}

const stage = (server: Server, bytes: Uint8Array) =>
  (server.deps.backups as NonNullable<typeof server.deps.backups>).stageUpload(bytes, 't.zip')

async function newBackup(server: Server, reason = 'manual') {
  const out = await server.deps.backups?.create(reason, await collectEntities(server.deps))
  if (out === undefined) throw new Error('no backups')
  expect(out.verified).toBe(true)
  expect(out.exportError).toBeNull()
  return out
}

const item = (p: ImportPreview, key: string) => p.items.find((i) => i.key === key)

// --- tests -------------------------------------------------------------------------------------

describe('the export', () => {
  test('is one zip with every entity type, readable, with a manifest of hashes, and no secrets', async () => {
    const world = await populate(instance())
    const backup = await newBackup(world.server)
    const raw = backupZip(world.server, backup.id)
    const entries = unzip(raw)
    const manifest = JSON.parse(textOf(entries.get('manifest.json') as Uint8Array)) as {
      format: string
      formatVersion: number
      app: { version: string }
      createdAt: number
      counts: Record<string, number>
      files: Array<{ path: string; size: number; sha256: string }>
    }
    expect(manifest).toMatchObject({ format: 'eharness-team-workspace', formatVersion: 1 })
    expect(manifest.app.version).not.toBe('')
    expect(manifest.createdAt).toBeGreaterThan(0)
    expect(manifest.counts).toMatchObject({ programs: 1, routines: 1, people: 1, connections: 1 })
    expect(manifest.counts.agents).toBeGreaterThanOrEqual(2)
    // every other file is in the manifest with its sha256, and nothing else
    expect(manifest.files.map((f) => f.path).sort()).toEqual(
      [...entries.keys()].filter((k) => k !== 'manifest.json').sort(),
    )
    for (const f of manifest.files) {
      const bytes = entries.get(f.path) as Uint8Array
      expect(sha256(bytes)).toBe(f.sha256)
      expect(bytes.byteLength).toBe(f.size)
    }
    const has = (path: string) => {
      expect(entries.has(path)).toBe(true)
    }
    for (const path of [
      'settings.json',
      'library/reports/q1.md',
      'library/notes/ünï.txt',
      'library/data/blob.bin',
      'memory/profile.md',
      'agents/lead/agent.json',
      'agents/lead/persona.md',
      'agents/lead/heartbeat.json',
      'agents/forecaster/agent.json',
      'agents/forecaster/persona.md',
      'agents/forecaster/heartbeat.json',
      'agents/forecaster/memory/profile.md',
      'agents/forecaster/memory/HEARTBEAT.md',
      'agents/forecaster/programs/weekly-report.json',
      'agents/forecaster/programs/weekly-report.brief.md',
      'connections/company-docs.json',
    ]) {
      has(path)
    }
    const routine = [...entries.keys()].find((k) => k.startsWith('agents/forecaster/routines/'))
    expect(routine).toBeDefined()
    expect([...entries.keys()].some((k) => k.startsWith('people/'))).toBe(true)

    const agent = JSON.parse(textOf(entries.get('agents/forecaster/agent.json') as Uint8Array))
    expect(agent).toMatchObject({
      slug: 'forecaster',
      name: 'Forecaster',
      permissionMode: 'manual',
      rules: { allow: ['Read'] },
    })
    // enablement is by connection key, not by id
    expect(agent.connectors['conn:company-docs']).toMatchObject({ enabled: 'on' })
    expect(textOf(entries.get('agents/forecaster/persona.md') as Uint8Array)).toContain(
      'Short and exact.',
    )
    expect(
      textOf(entries.get('agents/forecaster/programs/weekly-report.brief.md') as Uint8Array),
    ).toContain('Collect the weekly numbers.')
    const conn = JSON.parse(textOf(entries.get('connections/company-docs.json') as Uint8Array))
    expect(conn).toMatchObject({ connector: 'mcp-remote', label: 'Company docs' })
    expect(conn.secrets).toContain('secrets not exported')

    // no secret anywhere in the zip (also not the token in the url's query)
    const all = [...entries.values()].map((b) => Buffer.from(b).toString('latin1')).join('\n')
    expect(all).not.toContain(SECRET)
  })

  test('is downloadable on demand and holds the live state', async () => {
    const world = await populate(instance())
    const res = await world.server.app.request('/backups/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const entries = unzip(new Uint8Array(await res.arrayBuffer()))
    expect(entries.has('agents/forecaster/agent.json')).toBe(true)
    expect(entries.has('manifest.json')).toBe(true)
  })
})

describe('round trip', () => {
  test('export -> wipe -> import restores equal data', async () => {
    const world = await populate(instance())
    const { server, analystId } = world
    const before = await stateOf(server)
    const backup = await newBackup(server)

    // wipe: remove the program, routine, person, files and memory; change settings, persona,
    // heartbeat and definition; archive the analyst
    const deps = server.deps
    const analystPrograms = deps.programs.list({ agentId: analystId })
    for (const p of analystPrograms) {
      const { deleteProgram } = await import('../src/app/programs.ts')
      deleteProgram(deps, p.id)
    }
    for (const r of deps.routines.list({ agentId: analystId })) deps.routines.delete(r.id)
    for (const p of (await deps.people.list({ page: 1, limit: 100 })).items)
      await deps.people.remove(p.id)
    const fs = libraryFs(server.conn.sqlite)
    await fs.delete('/library/reports/q1.md')
    await fs.write('/library/notes/ünï.txt', 'edited')
    await fs.delete('/library/data/blob.bin')
    await fs.delete(`/memories/agents/${analystId}/HEARTBEAT.md`)
    await fs.write('/memories/workspace/profile.md', 'changed')
    patchSettings(deps, { teamName: 'Other' })
    editPersona(deps, analystId, { voice: 'Chatty.' })
    await setHeartbeat(deps, analystId, { everyMinutes: 15 })
    updateAgent(deps, analystId, { description: 'Something else' })
    const { archiveAgent } = await import('../src/app/agents.ts')
    archiveAgent(deps, analystId)
    expect(await stateOf(server)).not.toEqual(before)

    const preview = await previewImport(deps, { backupId: backup.id })
    expect(preview.items.length).toBeGreaterThan(5)
    const result = await applyImport(deps, { backupId: backup.id }, undefined, { by: 'web' })
    expect(result.counts.failed).toBe(0)
    expect(result.restorePointId).not.toBeNull()
    // the analyst came back under the same id (matched by slug), not as a new agent
    expect(deps.agents.getBySlug('forecaster')?.id).toBe(analystId)
    expect(deps.agents.getBySlug('forecaster')?.archivedAt).toBeNull()
    expect(await stateOf(server)).toEqual(before)
    // a second import finds nothing to do
    const again = await previewImport(deps, { backupId: backup.id })
    expect(again.items.filter((i) => i.status !== 'only-live')).toEqual([])
  })

  test('into an empty workspace the entities are created with new ids and references remapped', async () => {
    const a = await populate(instance())
    const backup = await newBackup(a.server)
    const raw = backupZip(a.server, backup.id)

    const b = instance()
    await b.connectorsReady
    const staged = await stage(b, raw)
    const preview = await previewImport(b.deps, { uploadId: staged.uploadId })
    const analyst = item(preview, 'agents/forecaster/agent.json')
    expect(analyst?.status).toBe('added')
    // the connection does not exist in this workspace: its enablement is dropped with a note
    expect(analyst?.notes.join(' ')).toContain('company-docs')
    const res = await applyImport(b.deps, { uploadId: staged.uploadId }, undefined, { by: 'web' })
    expect(res.counts.failed).toBe(0)
    const created = b.deps.agents.getBySlug('forecaster')
    expect(created).toBeDefined()
    expect(created?.id).not.toBe(a.analystId)
    expect(created?.permissionMode).toBe('manual')
    const programs = b.deps.programs.list({ agentId: created?.id as string })
    expect(programs.map((p) => p.name)).toEqual(['Weekly report'])
    expect(programs[0]?.agentId).toBe(created?.id)
    expect(programs[0]?.brief).toContain('Collect the weekly numbers.')
    expect(b.deps.routines.list({ agentId: created?.id as string }).map((r) => r.name)).toEqual([
      'Morning check',
    ])
    // memory moved to the new agent's own folder
    const mem = await b.deps.library.read(`/memories/agents/${created?.id}/HEARTBEAT.md`)
    expect(mem?.text).toContain('watch the weekly report')
    // the persona came along
    expect(b.deps.persona.latest(created?.id as string)?.voice).toBe('Short and exact.\nNo filler.')
    // a second import of the same zip creates no duplicates (matched by slug, name, path)
    const again = await previewImport(b.deps, { uploadId: staged.uploadId })
    expect(
      again.items.filter((i) => i.applicable && (i.status === 'added' || i.status === 'changed')),
    ).toEqual([])
    // secrets never imported: the connection is not created
    expect((await b.deps.connectors.connections()).filter((c) => !c.builtin)).toEqual([])
  })
})

describe('preview', () => {
  test('counts per section, readable diffs, changed fields, only-in-workspace items', async () => {
    const world = await populate(instance())
    const { server, analystId } = world
    const deps = server.deps
    const backup = await newBackup(server)
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/reports/q1.md', '# Q1\nrevenue up a lot\nmargin flat')
    await fs.delete('/library/notes/ünï.txt')
    await fs.write('/library/new-since.md', 'written after the backup')
    updateAgent(deps, analystId, {
      description: 'Changed after the backup',
      permissionMode: 'auto',
    })
    patchSettings(deps, { teamName: 'Renamed' })

    const p = await previewImport(deps, { backupId: backup.id })
    const section = (id: string) => p.sections.find((s) => s.id === id)
    expect(section('library')).toMatchObject({ added: 1, changed: 1, onlyLive: 1 })
    expect(section('agents')?.changed).toBe(1)
    expect(section('settings')?.changed).toBe(1)
    expect(section('connections')?.applicable).toBe(false)

    const changed = item(p, 'library/reports/q1.md')
    expect(changed?.status).toBe('changed')
    expect(changed?.diff).toContain('- revenue up a lot')
    expect(changed?.diff).toContain('+ revenue up')
    expect(item(p, 'library/notes/ünï.txt')?.status).toBe('added')
    const onlyLive = item(p, 'library/new-since.md')
    expect(onlyLive?.status).toBe('only-live')

    const agent = item(p, 'agents/forecaster/agent.json')
    expect(agent?.fields.map((f) => f.field).sort()).toEqual(['description', 'permissionMode'])
    expect(agent?.fields.find((f) => f.field === 'description')).toMatchObject({
      before: 'Changed after the backup',
      after: 'Looks at numbers',
    })
    const settings = item(p, 'settings.json')
    expect(settings?.fields[0]).toMatchObject({
      field: 'settings.teamName',
      before: 'Renamed',
      after: 'Acme Team',
    })
    // a preview writes nothing
    expect((await deps.library.read('/library/notes/ünï.txt')) === undefined).toBe(true)
    expect(listRestorePoints(deps)).toEqual([])
  })

  test('shows what an import would grant: permission mode, rules, connectors, program authority, roles', async () => {
    const a = await populate(instance())
    const backup = await newBackup(a.server)
    const b = instance()
    await b.connectorsReady
    const staged = await stage(b, backupZip(a.server, backup.id))
    const p = await previewImport(b.deps, { uploadId: staged.uploadId })
    const agent = item(p, 'agents/forecaster/agent.json')
    expect(agent?.authority).toContain('permission mode: manual')
    expect(agent?.authority.join('\n')).toContain('always allowed tool rules: Read')
    expect(
      item(p, 'agents/forecaster/programs/weekly-report.json')?.authority.join('\n'),
    ).toContain('program may write: /library/reports/')
    expect(
      item(p, 'agents/forecaster/programs/weekly-report.json')?.authority.join('\n'),
    ).toContain('runs on a schedule')
    const person = p.items.find((i) => i.section === 'people')
    expect(person?.authority).toContain('directory role: admin')
    // connections are for reading
    const conn = item(p, 'connections/company-docs.json')
    expect(conn).toMatchObject({ applicable: false, status: 'added' })
    expect(conn?.notes.join(' ')).toContain('reconnect after import')
  })

  test('an agent made by a zip with bypass permissions is shown as such', async () => {
    const server = instance()
    const agent = {
      slug: 'rogue',
      name: 'Rogue',
      role: 'custom',
      avatar: null,
      color: '#000000',
      description: '',
      instructions: 'Do things.',
      model: null,
      modelProfile: null,
      toolAccess: null,
      taskConcurrency: 1,
      contextWindow: null,
      compactAtPercent: 80,
      skills: [],
      permissionMode: 'bypassPermissions',
      rules: { allow: ['Bash(*)'], ask: [], deny: [] },
      connectors: { 'builtin:files': { enabled: 'on' } },
    }
    const staged = await stage(
      server,
      makeZip({ 'agents/rogue/agent.json': JSON.stringify(agent) }),
    )
    const p = await previewImport(server.deps, { uploadId: staged.uploadId })
    const lines = item(p, 'agents/rogue/agent.json')?.authority.join('\n') ?? ''
    expect(lines).toContain('permission mode: bypassPermissions')
    expect(lines).toContain('always allowed tool rules: Bash(*)')
    expect(lines).toContain('connector builtin:files: on')
  })
})

describe('apply', () => {
  test('unticking a section or a single item leaves it out', async () => {
    const world = await populate(instance())
    const { server, analystId } = world
    const deps = server.deps
    const backup = await newBackup(server)
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/reports/q1.md', 'edited one')
    await fs.write('/memories/workspace/profile.md', 'edited memory')
    updateAgent(deps, analystId, { description: 'edited agent' })
    patchSettings(deps, { teamName: 'Renamed' })

    // settings unticked as a section, the memory file unticked as an item
    const res = await applyImport(
      deps,
      { backupId: backup.id },
      {
        sections: ['agents', 'library', 'memory', 'programs', 'routines', 'people'],
        exclude: ['memory/profile.md'],
      },
      { by: 'web' },
    )
    expect(res.counts.failed).toBe(0)
    expect((await deps.library.read('/library/reports/q1.md'))?.text).toContain('# Q1')
    expect((await deps.library.read('/memories/workspace/profile.md'))?.text).toBe('edited memory')
    expect(deps.agents.get(analystId)?.description).toBe('Looks at numbers')
    expect(deps.settings.get().teamName).toBe('Renamed')
    // reference sections cannot be ticked
    await expect(
      applyImport(deps, { backupId: backup.id }, { sections: ['connections'] }, { by: 'web' }),
    ).rejects.toThrow(/reading only/)
  })

  test('never deletes unless the section is ticked for removal; agents are archived, not deleted', async () => {
    const world = await populate(instance())
    const { server } = world
    const deps = server.deps
    const base = await newBackup(server)
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/extra.md', 'only here')
    const extra = createAgent(deps, { name: 'Extra', instructions: 'Extra agent.' })
    createProgram(deps, { agentId: extra.id, name: 'Extra program', brief: 'x' })
    await deps.people.create({ displayName: 'Only Live' })

    const keep = await applyImport(deps, { backupId: base.id }, undefined, { by: 'web' })
    expect(keep.counts.removed).toBe(0)
    expect((await deps.library.read('/library/extra.md'))?.text).toBe('only here')
    expect(deps.agents.getBySlug('extra')?.archivedAt).toBeNull()
    expect(deps.programs.list({ agentId: extra.id })).toHaveLength(1)

    // the library alone is ticked: the file goes, the rest stays
    const lib = await applyImport(
      deps,
      { backupId: base.id },
      { removeSections: ['library'] },
      { by: 'web' },
    )
    expect(lib.counts.removed).toBe(1)
    expect(await deps.library.read('/library/extra.md')).toBeUndefined()
    expect(deps.agents.getBySlug('extra')?.archivedAt).toBeNull()
    expect(
      (await deps.people.list({ page: 1, limit: 100 })).items.map((p) => p.displayName),
    ).toContain('Only Live')

    // all ticked: program and person are deleted, the agent is archived (history stays)
    await applyImport(
      deps,
      { backupId: base.id },
      { removeSections: ['library', 'programs', 'people', 'agents', 'memory', 'routines'] },
      { by: 'web' },
    )
    expect(deps.programs.list({ agentId: extra.id })).toHaveLength(0)
    expect(
      (await deps.people.list({ page: 1, limit: 100 })).items.map((p) => p.displayName),
    ).not.toContain('Only Live')
    expect(deps.agents.getBySlug('extra')?.archivedAt).not.toBeNull()
    expect(deps.agents.getBySlug('lead')?.archivedAt).toBeNull()
  })

  test('nothing selected to change takes no safety backup and records no restore point', async () => {
    const world = await populate(instance())
    const backup = await newBackup(world.server)
    const count = world.server.deps.backups?.list().length
    const res = await applyImport(world.server.deps, { backupId: backup.id }, undefined, {
      by: 'web',
    })
    expect(res.restorePointId).toBeNull()
    expect(res.safetyBackupId).toBeNull()
    expect(world.server.deps.backups?.list().length).toBe(count)
  })

  test('a failed safety backup applies nothing', async () => {
    const world = await populate(instance())
    const { server } = world
    const backup = await newBackup(server)
    await libraryFs(server.conn.sqlite).write('/library/reports/q1.md', 'edited')
    const real = server.deps.backups as NonNullable<typeof server.deps.backups>
    server.deps.backups = { ...real, create: () => Promise.reject(new Error('disk full')) }
    await expect(
      applyImport(server.deps, { backupId: backup.id }, undefined, { by: 'web' }),
    ).rejects.toThrow(/safety backup failed/)
    expect((await server.deps.library.read('/library/reports/q1.md'))?.text).toBe('edited')
    server.deps.backups = real
  })

  test('one failing item does not stop the rest and is listed as failed', async () => {
    const server = instance()
    const bad = {
      slug: 'broken',
      name: 'Broken',
      role: 'custom',
      avatar: null,
      color: '#111111',
      description: '',
      instructions: 'x',
      model: null,
      modelProfile: null,
      toolAccess: null,
      taskConcurrency: 99,
      contextWindow: null,
      compactAtPercent: 80,
      skills: [],
      permissionMode: 'manual',
      rules: { allow: [], ask: [], deny: [] },
      connectors: {},
    }
    const good = { ...bad, slug: 'fine', name: 'Fine', taskConcurrency: 1 }
    const staged = await stage(
      server,
      makeZip({
        'agents/broken/agent.json': JSON.stringify(bad),
        'agents/fine/agent.json': JSON.stringify(good),
        'library/z.md': 'hello',
      }),
    )
    const res = await applyImport(server.deps, { uploadId: staged.uploadId }, undefined, {
      by: 'web',
    })
    expect(res.counts.failed).toBe(1)
    expect(res.items.find((i) => i.action === 'failed')?.key).toBe('agents/broken/agent.json')
    expect(server.deps.agents.getBySlug('fine')).toBeDefined()
    expect(server.deps.agents.getBySlug('broken')).toBeUndefined()
    expect((await server.deps.library.read('/library/z.md'))?.text).toBe('hello')
  })
})

describe('restore points and undo', () => {
  test('an import records a restore point and its undo returns the exact previous state; the undo can be undone', async () => {
    const world = await populate(instance())
    const { server, analystId } = world
    const deps = server.deps
    const backup = await newBackup(server)
    const fs = libraryFs(server.conn.sqlite)

    // the workspace moves on after the backup
    await fs.write('/library/reports/q1.md', 'v2 after the backup')
    await fs.write('/library/added-later.md', 'later')
    updateAgent(deps, analystId, { description: 'v2 description' })
    patchSettings(deps, { teamName: 'V2' })
    const stateV2 = await stateOf(server)

    // import the older backup, removing what it does not have (a rollback)
    const imp = await applyImport(
      deps,
      { backupId: backup.id },
      { removeSections: ['library'] },
      { by: 'web' },
    )
    expect(imp.restorePointId).not.toBeNull()
    const stateV1 = await stateOf(server)
    expect(stateV1).not.toEqual(stateV2)
    expect(await deps.library.read('/library/added-later.md')).toBeUndefined()

    const [point] = listRestorePoints(deps)
    expect(point).toMatchObject({
      id: imp.restorePointId,
      kind: 'import',
      by: 'web',
      source: { kind: 'backup', backupId: backup.id },
      safetyBackupId: imp.safetyBackupId,
      undoneBy: null,
    })
    expect(point?.counts.changed).toBeGreaterThan(0)
    expect(point?.counts.removed).toBe(1)
    expect(deps.backups?.get(imp.safetyBackupId as string)?.reason).toContain('before: import')
    expect(deps.backups?.get(imp.safetyBackupId as string)?.verified).toBe(true)

    // undo: the preview offers the safety backup with the touched sections ticked for removal
    const undo = await previewUndo(deps, point?.id as string)
    expect(undo.source).toEqual({ backupId: imp.safetyBackupId as string })
    expect(undo.selection.removeSections).toContain('library')
    const undone = await applyImport(deps, undo.source, undo.selection, {
      by: 'web',
      undoOf: point?.id,
    })
    expect(undone.counts.failed).toBe(0)
    // the exact previous state, including the file the import removed
    expect(await stateOf(server)).toEqual(stateV2)
    expect(listRestorePoints(deps).find((p) => p.id === point?.id)?.undoneBy).toBe(
      undone.restorePointId,
    )
    const undoPoint = listRestorePoints(deps).find((p) => p.id === undone.restorePointId)
    expect(undoPoint).toMatchObject({ kind: 'undo', undoOf: point?.id })
    // the same restore point cannot be undone twice
    await expect(previewUndo(deps, point?.id as string)).rejects.toThrow(/already undone/)

    // undo of the undo: back to the imported state
    const again = await previewUndo(deps, undone.restorePointId as string)
    await applyImport(deps, again.source, again.selection, {
      by: 'web',
      undoOf: undone.restorePointId as string,
    })
    expect(await stateOf(server)).toEqual(stateV1)
  })

  test('a files restore from a snapshot also leaves a restore point', async () => {
    const world = await populate(instance())
    const { server } = world
    const backup = await newBackup(server)
    await libraryFs(server.conn.sqlite).delete('/library/reports/q1.md')
    const r = await restoreFiles(server.deps, backup.id, { path: '/', mode: 'missing' })
    expect(r.restorePointId).not.toBeNull()
    expect(listRestorePoints(server.deps)[0]).toMatchObject({
      kind: 'files-restore',
      safetyBackupId: r.safetyBackupId,
    })
  })
})

describe('refused zips', () => {
  const refuses = async (server: Server, bytes: Uint8Array, message: RegExp): Promise<void> => {
    await expect(stage(server, bytes)).rejects.toThrow(message)
  }

  test('a corrupt zip, a flipped byte, a missing or foreign manifest', async () => {
    const world = await populate(instance())
    const { server } = world
    const backup = await newBackup(server)
    const good = backupZip(server, backup.id)
    expect((await stage(server, good)).uploadId).toMatch(/^up-/)

    await refuses(server, bytesOf('not a zip at all, definitely'), /not a zip/)
    // a flipped byte in an entry: the CRC (and the hash) no longer match
    const flipped = good.slice()
    const at = flipped.findIndex((_, i) => i > 200 && flipped[i] !== 0)
    flipped[at] = (flipped[at] as number) ^ 0xff
    await expect(stage(server, flipped)).rejects.toThrow(/refused/)
    // truncated
    await refuses(server, good.slice(0, 300), /zip/)
    // no manifest
    await refuses(
      server,
      zip([{ path: 'settings.json', bytes: bytesOf('{}') }]),
      /manifest.json is missing/,
    )
    // an older files-only manifest has no format marker
    await refuses(
      server,
      zip([{ path: 'manifest.json', bytes: bytesOf(JSON.stringify({ createdAt: 1, files: [] })) }]),
      /format marker/,
    )
    // a newer format
    await refuses(
      server,
      makeZip({}, { manifest: (m) => ({ ...m, formatVersion: 99 }) }),
      /newer than this server/,
    )
  })

  test('tampered content with a valid CRC fails the manifest hash; extra and missing files are caught', async () => {
    const server = instance()
    const wrongHash = makeZip(
      { 'library/a.md': 'tampered text' },
      {
        manifest: (m) => ({
          ...m,
          files: [{ path: 'library/a.md', size: 13, sha256: 'a'.repeat(64) }],
        }),
      },
    )
    await refuses(server, wrongHash, /does not match its hash/)
    const extra = makeZip(
      { 'library/a.md': 'a', 'library/b.md': 'b' },
      {
        manifest: (m) => ({
          ...m,
          files: (m.files as unknown[]).slice(0, 1),
        }),
      },
    )
    await refuses(server, extra, /not in the manifest/)
    const missing = makeZip(
      { 'library/a.md': 'a' },
      {
        manifest: (m) => ({
          ...m,
          files: [
            ...(m.files as unknown[]),
            { path: 'library/ghost.md', size: 1, sha256: 'b'.repeat(64) },
          ],
        }),
      },
    )
    await refuses(server, missing, /missing from the zip/)
  })

  test('zip-slip: paths that escape or fall outside the expected folders', async () => {
    const server = instance()
    for (const name of [
      '../evil.txt',
      '/etc/passwd',
      'library/../../evil.txt',
      'agents/../../x.json',
      'library\\..\\evil.txt',
      'evil/x.md',
      'agents/lead/../other/agent.json',
      'agents/Lead/agent.json',
      'agents/lead/secrets.txt',
      'C:/windows/x',
      'library//double.md',
    ]) {
      const bytes = makeZip({ [name]: 'x' })
      await expect(stage(server, bytes)).rejects.toThrow(/refused/)
    }
    // nothing was written outside, and nothing was staged
    expect(
      server.deps.library.list({ prefix: '/', limit: 100000 }).some((m) => m.path.includes('evil')),
    ).toBe(false)
  })

  test('a zip over the size limit, over the entry limit, or declaring a huge entry is refused', async () => {
    const server = instance()
    await refuses(server, new Uint8Array(IMPORT_LIMITS.zipBytes + 1), /larger than/)
    // an entry that declares more than the limit (central directory lies about the size)
    const lying = zip([
      { path: 'library/big.md', bytes: bytesOf('tiny') },
      { path: 'manifest.json', bytes: bytesOf('{}') },
    ])
    const view = new DataView(lying.buffer, lying.byteOffset, lying.byteLength)
    let end = lying.byteLength - 22
    while (view.getUint32(end, true) !== 0x06054b50) end--
    const cd = view.getUint32(end + 16, true)
    view.setUint32(cd + 24, IMPORT_LIMITS.entryBytes + 1, true)
    await refuses(server, lying, /larger than/)
    // a zip bomb: a deflated entry that inflates past what it declares
    const body = new Uint8Array(100_000)
    const deflated = (await new Response(
      new Blob([body]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer()) as ArrayBuffer
    const bomb = rawZip('library/bomb.md', new Uint8Array(deflated), 10, 8)
    await refuses(server, bomb, /bomb|inflates/)
  })

  test('over HTTP: upload, refusal with the reason, preview, import, restore points, undo', async () => {
    const world = await populate(instance())
    const { server } = world
    const backup = await newBackup(server)
    const good = backupZip(server, backup.id)
    const bad = await server.app.request('/backups/imports?name=x.zip', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: bytesOf('nope') as unknown as BodyInit,
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('IMPORT_REFUSED')

    const up = await server.app.request('/backups/imports?name=mine.zip', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: good as unknown as BodyInit,
    })
    expect(up.status).toBe(200)
    const { uploadId } = (await up.json()) as { uploadId: string }
    await libraryFs(server.conn.sqlite).write('/library/reports/q1.md', 'edited over http')
    const post = (path: string, body: unknown) =>
      server.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const preview = (await (
      await post('/backups/import-preview', { source: { uploadId } })
    ).json()) as ImportPreview
    expect(
      preview.items.some((i) => i.key === 'library/reports/q1.md' && i.status === 'changed'),
    ).toBe(true)
    const done = (await (await post('/backups/import', { source: { uploadId } })).json()) as {
      restorePointId: string
      counts: { changed: number }
    }
    expect(done.counts.changed).toBe(1)
    expect((await world.server.deps.library.read('/library/reports/q1.md'))?.text).toContain('# Q1')
    const points = (await (await server.app.request('/backups/restore-points')).json()) as {
      restorePoints: Array<{ id: string }>
    }
    expect(points.restorePoints[0]?.id).toBe(done.restorePointId)
    const undo = (await (
      await server.app.request(`/backups/restore-points/${done.restorePointId}/undo`)
    ).json()) as {
      source: unknown
      selection: unknown
    }
    const undone = await post('/backups/import', {
      source: undo.source,
      selection: undo.selection,
      undoOf: done.restorePointId,
    })
    expect(undone.status).toBe(200)
    expect((await server.deps.library.read('/library/reports/q1.md'))?.text).toBe(
      'edited over http',
    )
    expect(
      (await post('/backups/import-preview', { source: { uploadId: 'up-0000000000000000' } }))
        .status,
    ).toBe(404)
    expect(
      (
        await post('/backups/import', {
          source: { uploadId },
          selection: { sections: ['connections'] },
        })
      ).status,
    ).toBe(400)
  })
})

describe('secrets', () => {
  test('connection secrets are absent from the zip and the preview, and never imported', async () => {
    const world = await populate(instance())
    const backup = await newBackup(world.server)
    const raw = backupZip(world.server, backup.id)
    expect(Buffer.from(raw).includes(Buffer.from(SECRET))).toBe(false)
    expect(Buffer.from(raw).includes(Buffer.from('token='))).toBe(false)
    const staged = await stage(world.server, raw)
    const preview = await previewImport(world.server.deps, { uploadId: staged.uploadId })
    expect(JSON.stringify(preview)).not.toContain(SECRET)
    const entries = unzip(raw)
    const conn = textOf(entries.get('connections/company-docs.json') as Uint8Array)
    expect(conn).not.toContain('X-Api-Key')
    writeFileSync(join(dirs[0] as string, 'conn.json'), conn)
  })
})

/** A zip with one entry, the sizes written as given (to craft a deflate bomb). */
function rawZip(name: string, data: Uint8Array, declared: number, method: number): Uint8Array {
  const n = bytesOf(name)
  const crc = (() => {
    // the CRC of the declared (short) content does not matter: the bomb is caught first
    return 0
  })()
  const local = new DataView(new ArrayBuffer(30))
  local.setUint32(0, 0x04034b50, true)
  local.setUint16(4, 20, true)
  local.setUint16(8, method, true)
  local.setUint32(14, crc, true)
  local.setUint32(18, data.byteLength, true)
  local.setUint32(22, declared, true)
  local.setUint16(26, n.byteLength, true)
  const cd = new DataView(new ArrayBuffer(46))
  cd.setUint32(0, 0x02014b50, true)
  cd.setUint16(4, 20, true)
  cd.setUint16(6, 20, true)
  cd.setUint16(10, method, true)
  cd.setUint32(16, crc, true)
  cd.setUint32(20, data.byteLength, true)
  cd.setUint32(24, declared, true)
  cd.setUint16(28, n.byteLength, true)
  cd.setUint32(42, 0, true)
  const head = [new Uint8Array(local.buffer), n, data]
  const offset = head.reduce((s, b) => s + b.byteLength, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, 1, true)
  end.setUint16(10, 1, true)
  end.setUint32(12, 46 + n.byteLength, true)
  end.setUint32(16, offset, true)
  const parts = [...head, new Uint8Array(cd.buffer), n, new Uint8Array(end.buffer)]
  const out = new Uint8Array(parts.reduce((s, b) => s + b.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
