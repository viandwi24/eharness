/**
 * A library and memory reorganization made offline (the owner downloads the workspace zip, an AI agent
 * moves and renames files and folders, the owner imports it again): the moves of `migrations/moves.json`
 * and the ones found by content, mirror mode (removal only with its tick), conflicts (changed here
 * after the export are kept), the reference check and its rewrite, the redirects agents follow through
 * the real file and memory tools, and the undo that returns paths and references.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createProgram, updateProgram } from '../src/app/programs.ts'
import { collectEntities } from '../src/app/workspace-export.ts'
import {
  applyImport,
  listMigrations,
  previewImport,
  previewUndo,
} from '../src/app/workspace-import.ts'
import {
  mapPath,
  movedFolder,
  PathIndex,
  parseMovesFile,
  resolveMoved,
  rewriteText,
} from '../src/domain/library-moves.ts'
import { bytesOf, type ImportPreview } from '../src/domain/workspace-export.ts'
import { zip } from '../src/infra/artifacts/zip.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SECRET_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

/** Calls the next `session.send` makes; the scripted model reads it when the step runs. */
let nextCalls: Array<{ toolName: string; input: unknown }> = []

function instance(): Server {
  const dir = mkdtempSync(join(tmpdir(), 'team-moves-'))
  dirs.push(dir)
  const steps: ScriptedStepInput[] = []
  for (let i = 0; i < 20; i++) {
    steps.push(() => ({ toolCalls: nextCalls }), { text: 'done' })
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'moves-test',
    models: scriptedModelConfig(scriptedModel(steps) as never),
    env: { TEAM_SECRET_KEY: SECRET_KEY },
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  return server
}

const ORDER_LINE =
  '- Keep the tracker <!-- order:ord1 by:web%3Aowner name:Ana role:admin report:web:s1 mention:no at:1 kind:ledger ledger:%2Flibrary%2Ftracker%2Fledger.md refs:%2Flibrary%2Fnotes%2Fa.md -->'

interface World {
  server: Server
  leadId: string
  programId: string
}

/** One workspace: notes, reports, a tracker, a program that names them, memory that mentions them. */
async function populate(server: Server): Promise<World> {
  const deps = server.deps
  const lead = deps.agents.getBySlug('lead')
  if (lead === undefined) throw new Error('no lead agent')
  const fs = libraryFs(server.conn.sqlite)
  await fs.write('/library/notes/a.md', 'alpha notes')
  await fs.write('/library/notes/b.md', 'beta notes')
  await fs.write('/library/reports/q1.md', '# Q1\nrevenue up')
  await fs.write('/library/reports/q2.md', '# Q2\nrevenue flat')
  await fs.write('/library/tracker/ledger.md', 'ledger rows')
  await fs.write(
    `/memories/agents/${lead.id}/index.md`,
    'Notes are in /library/notes/a.md and the ledger is /library/tracker/ledger.md.',
  )
  await fs.write(`/memories/agents/${lead.id}/HEARTBEAT.md`, `# Heartbeat\n${ORDER_LINE}\n`)
  const program = createProgram(deps, {
    agentId: lead.id,
    name: 'Weekly report',
    brief: 'Collect the numbers and write the report.',
    authority: { tools: [], read: ['/library/'], write: ['/library/reports/**'] },
    deliverables: [{ path: '/library/reports/{date}.md', kind: 'markdown' }],
  })
  return { server, leadId: lead.id, programId: program.id }
}

async function exportZip(server: Server): Promise<{ backupId: string }> {
  const out = await server.deps.backups?.create('manual', await collectEntities(server.deps))
  if (out === undefined) throw new Error('no backups')
  await Bun.sleep(5)
  return { backupId: out.id }
}

/** The zip of a backup, edited offline: the manifest keeps describing the export. */
async function reorganize(
  server: Server,
  backupId: string,
  edit: (files: Map<string, Uint8Array>, put: (path: string, text: string) => void) => void,
): Promise<{ uploadId: string }> {
  const parsed = await (
    server.deps.backups as NonNullable<typeof server.deps.backups>
  ).readWorkspace({
    backupId,
  })
  const files = new Map(parsed.entries)
  edit(files, (path, text) => files.set(path, bytesOf(text)))
  const bytes = zip([
    ...[...files].map(([path, b]) => ({ path, bytes: b })),
    { path: 'manifest.json', bytes: bytesOf(JSON.stringify(parsed.manifest)) },
  ])
  return (server.deps.backups as NonNullable<typeof server.deps.backups>).stageUpload(
    bytes,
    'reorganized.zip',
  )
}

const text = async (server: Server, path: string): Promise<string | undefined> =>
  (await server.deps.library.read(path))?.text ?? undefined

const kinds = (p: ImportPreview, kind: string) => p.items.filter((i) => i.kind === kind)

/** What the tools answered to the calls (scripted model, a real session of the lead agent). */
async function runTools(
  server: Server,
  calls: Array<{ toolName: string; input: unknown }>,
): Promise<Array<{ tool: string; output: string }>> {
  const lead = server.deps.agents.getBySlug('lead')
  if (lead === undefined) throw new Error('no lead agent')
  await server.factory.prepare(lead)
  nextCalls = calls
  const session = server.factory
    .agentFor(lead)
    .session(`dm:${lead.id}`, { lock: server.factory.lock })
  const result = await session.send('go').result
  expect(result.stop).toBe('complete')
  const messages = await session.messages()
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
  return (assistant?.parts ?? [])
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => ({
      tool: p.type.slice(5),
      output: String((p as { output?: unknown }).output ?? ''),
    }))
}

describe('the rules of moves (pure)', () => {
  test('moves.json: bad entries are told, good ones kept', () => {
    const r = parseMovesFile(
      JSON.stringify([
        { from: '/library/a.md', to: '/library/b.md', note: ' why ' },
        { from: 1 },
        'x',
      ]),
    )
    expect(r.moves).toEqual([{ from: '/library/a.md', to: '/library/b.md', note: 'why' }])
    expect(r.problems).toHaveLength(2)
    expect(parseMovesFile('nope').problems[0]).toMatch(/not valid JSON/)
    expect(parseMovesFile('{}').problems[0]).toMatch(/list/)
  })

  test('a file rule beats a folder rule; chains and folders resolve', () => {
    const rules = [
      { from: '/library/a/', to: '/library/b/', kind: 'prefix' as const, at: 1 },
      { from: '/library/a/x.md', to: '/library/other.md', kind: 'file' as const, at: 2 },
      { from: '/library/b/', to: '/library/c/', kind: 'prefix' as const, at: 3 },
    ]
    expect(mapPath('/library/a/x.md', rules)).toBe('/library/other.md')
    expect(mapPath('/library/a/y.md', rules)).toBe('/library/b/y.md')
    // a chain of two moves ends at the first path that exists
    expect(resolveMoved('/library/a/y.md', rules, () => false)).toBe('/library/c/y.md')
    expect(resolveMoved('/library/a/y.md', rules, (p) => p === '/library/b/y.md')).toBe(
      '/library/b/y.md',
    )
    expect(movedFolder('/library/a/', rules)).toBe('/library/b/')
    expect(movedFolder('/library/q/', rules)).toBeUndefined()
    // files that all went to the same relative place mean the folder moved
    const files = [
      { from: '/library/d/1.md', to: '/library/e/1.md', kind: 'file' as const },
      { from: '/library/d/2.md', to: '/library/e/2.md', kind: 'file' as const },
    ]
    expect(movedFolder('/library/d/', files)).toBe('/library/e/')
  })

  test('a text is rewritten only where a path points to nothing: never twice', () => {
    const rules = [{ from: '/library/r/', to: '/library/r/2024/', kind: 'prefix' as const }]
    const after = new PathIndex(['/library/r/2024/q1.md'])
    const original =
      'see /library/r/q1.md, and /library/r/2024/q1.md. Encoded: files:%2Flibrary%2Fr%2Fq1.md,x'
    const r = rewriteText(original, rules, after)
    expect(r.text).toBe(
      'see /library/r/2024/q1.md, and /library/r/2024/q1.md. Encoded: files:%2Flibrary%2Fr%2F2024%2Fq1.md,x',
    )
    expect(r.changes).toHaveLength(2)
    // the result is stable: a second pass changes nothing (the nested folder is not nested again)
    expect(rewriteText(r.text, rules, after).changes).toHaveLength(0)
  })
})

describe('moves in a zip', () => {
  test('stated moves (file and folder), seen in the preview, applied as moves with history, redirected, undone', async () => {
    const server = instance()
    const { leadId, programId } = await populate(server)
    const deps = server.deps
    const backup = await exportZip(server)
    const q1Version = (await deps.library.read('/library/reports/q1.md'))?.meta.version

    const upload = await reorganize(server, backup.backupId, (files, put) => {
      const move = (from: string, to: string): void => {
        files.set(to, files.get(from) as Uint8Array)
        files.delete(from)
      }
      move('library/notes/a.md', 'library/knowledge/a.md')
      move('library/reports/q1.md', 'library/finance/reports/q1.md')
      move('library/reports/q2.md', 'library/finance/reports/q2.md')
      put(
        'migrations/moves.json',
        JSON.stringify([
          { from: '/library/notes/a.md', to: '/library/knowledge/a.md', note: 'topic notes' },
          { from: '/library/reports/', to: '/library/finance/reports/' },
        ]),
      )
    })
    const preview = await previewImport(deps, upload)
    expect(preview.moves).toEqual({ files: 3, folders: 1, explicit: 2, detected: 0 })
    const moves = kinds(preview, 'move')
    expect(moves.map((m) => `${m.move?.from} -> ${m.move?.to}`)).toEqual([
      '/library/notes/a.md -> /library/knowledge/a.md',
      '/library/reports/ -> /library/finance/reports/',
    ])
    expect(moves[0]?.notes.join(' ')).toContain('topic notes')
    // the moved files are not "new here" and the old paths are not "only here"
    expect(kinds(preview, 'file')).toEqual([])
    expect(preview.sections.find((s) => s.id === 'library')?.moved).toBe(2)
    expect(preview.sections.find((s) => s.id === 'library')?.onlyLive).toBe(0)

    // the reference check: the program, the standing order, the memory note
    const dangling = preview.references.dangling.map(
      (r) => `${r.kind}|${r.where}|${r.ref}|${r.suggestion}`,
    )
    expect(dangling).toContain(
      'program|authority.write|/library/reports/**|/library/finance/reports/**',
    )
    expect(dangling).toContain(
      'program|deliverable|/library/reports/{date}.md|/library/finance/reports/{date}.md',
    )
    expect(dangling).toContain('memory|note|/library/notes/a.md|/library/knowledge/a.md')
    expect(dangling).toContain('order|standing order|/library/notes/a.md|/library/knowledge/a.md')
    expect(preview.references.rewritable).toBeGreaterThanOrEqual(4)
    expect(
      kinds(preview, 'reference')
        .map((i) => i.section)
        .sort(),
    ).toEqual(['memory', 'memory', 'programs'])

    // apply without the rewrite: the files move, the references stay (and are still reported)
    const first = await applyImport(deps, upload, {}, { by: 'web' })
    expect(first.counts.failed).toBe(0)
    expect(await text(server, '/library/notes/a.md')).toBeUndefined()
    expect(await text(server, '/library/knowledge/a.md')).toBe('alpha notes')
    expect(await text(server, '/library/finance/reports/q1.md')).toBe('# Q1\nrevenue up')
    // a move, not a copy: the same version, the history follows, the old path ends with a deletion
    expect((await deps.library.read('/library/finance/reports/q1.md'))?.meta.version).toBe(
      q1Version,
    )
    const actions = (path: string): string[] =>
      server.conn.sqlite
        .query<{ action: string; from_path: string | null }, [string]>(
          'SELECT action, from_path FROM library_history WHERE path = ? ORDER BY seq',
        )
        .all(path)
        .map((r) => `${r.action}${r.from_path === null ? '' : `:${r.from_path}`}`)
    expect(actions('/library/finance/reports/q1.md')).toContain('move:/library/reports/q1.md')
    expect(actions('/library/reports/q1.md').at(-1)).toBe('delete')
    expect(deps.programs.get(programId)?.authority.write).toEqual(['/library/reports/**'])
    const stored = listMigrations(deps)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ files: 1, folders: 1, canUndo: true })
    expect(stored[0]?.moves.map((m) => m.kind).sort()).toEqual(['file', 'prefix'])

    // agents that still use the old paths follow them, through the real tools
    const out = await runTools(server, [
      { toolName: 'read_file', input: { path: '/library/notes/a.md' } },
      { toolName: 'write_file', input: { path: '/library/reports/q3.md', content: '# Q3' } },
      { toolName: 'list_files', input: { prefix: '/library/reports' } },
    ])
    const by = (tool: string): string => out.find((o) => o.tool === tool)?.output ?? ''
    expect(by('read_file')).toStartWith(
      'Moved: /library/notes/a.md → /library/knowledge/a.md. Use the new path.',
    )
    expect(by('read_file')).toContain('alpha notes')
    expect(by('write_file')).toContain(
      'Written to /library/finance/reports/q3.md (moved from /library/reports/q3.md)',
    )
    expect(await text(server, '/library/finance/reports/q3.md')).toBe('# Q3')
    expect(await text(server, '/library/reports/q3.md')).toBeUndefined()
    expect(by('list_files')).toContain('This folder moved to /library/finance/reports/')
    // an edit through the old path, after reading it through the old path
    await runTools(server, [{ toolName: 'read_file', input: { path: '/library/reports/q2.md' } }])
    const edited = await runTools(server, [
      {
        toolName: 'edit_file',
        input: { path: '/library/reports/q2.md', old_string: 'flat', new_string: 'up' },
      },
    ])
    expect(edited[0]?.output).toContain('Written to /library/finance/reports/q2.md')
    expect(await text(server, '/library/finance/reports/q2.md')).toBe('# Q2\nrevenue up')
    expect(await text(server, '/library/reports/q2.md')).toBeUndefined()

    // undo: paths and everything else come back, the redirects end with the import
    const undo = await previewUndo(deps, first.restorePointId as string)
    // a.md and q1.md are found again by content; q2 was edited since, so it is a plain change
    expect(undo.preview.moves.files).toBe(2)
    const undone = await applyImport(deps, undo.source, undo.selection, {
      by: 'web',
      undoOf: first.restorePointId as string,
    })
    expect(undone.counts.failed).toBe(0)
    expect(await text(server, '/library/notes/a.md')).toBe('alpha notes')
    expect(await text(server, '/library/reports/q1.md')).toBe('# Q1\nrevenue up')
    expect(await text(server, '/library/knowledge/a.md')).toBeUndefined()
    expect(await text(server, '/library/finance/reports/q1.md')).toBeUndefined()
    expect(listMigrations(deps)).toEqual([])
    expect(server.conn.sqlite.query('SELECT count(*) AS n FROM library_moves').get()).toEqual({
      n: 0,
    })
    void leadId
  })

  test('a move found by content, in agent memory, keeps its history and redirects memory tools', async () => {
    const server = instance()
    const { leadId } = await populate(server)
    const deps = server.deps
    const backup = await exportZip(server)
    const upload = await reorganize(server, backup.backupId, (files) => {
      files.set(
        'agents/lead/memory/topics/index.md',
        files.get('agents/lead/memory/index.md') as Uint8Array,
      )
      files.delete('agents/lead/memory/index.md')
    })
    const preview = await previewImport(deps, upload)
    expect(preview.moves).toMatchObject({ files: 1, detected: 1, explicit: 0 })
    const move = kinds(preview, 'move')[0]
    expect(move?.move).toMatchObject({
      from: `/memories/agents/${leadId}/index.md`,
      to: `/memories/agents/${leadId}/topics/index.md`,
      source: 'detected',
    })
    expect(preview.sections.find((s) => s.id === 'memory')?.onlyLive).toBe(0)
    const res = await applyImport(deps, upload, {}, { by: 'web' })
    expect(res.counts.failed).toBe(0)
    const moved = `/memories/agents/${leadId}/topics/index.md`
    expect(await text(server, moved)).toContain('/library/notes/a.md')
    expect(await text(server, `/memories/agents/${leadId}/index.md`)).toBeUndefined()

    const out = await runTools(server, [
      { toolName: 'memory_view', input: { path: `/memories/agents/${leadId}/index.md` } },
      {
        toolName: 'memory_str_replace',
        input: {
          path: `/memories/agents/${leadId}/index.md`,
          old_str: 'Notes are in',
          new_str: 'Topics are in',
        },
      },
    ])
    expect(out[0]?.output).toStartWith(
      `Moved: /memories/agents/${leadId}/index.md → ${moved}. Use the new path.`,
    )
    expect(out[1]?.output).toContain(
      `Written to ${moved} (moved from /memories/agents/${leadId}/index.md)`,
    )
    expect(await text(server, moved)).toStartWith('Topics are in')
    expect(await text(server, `/memories/agents/${leadId}/index.md`)).toBeUndefined()
  })

  test('mirror mode: what is not in the zip stays unless its section is ticked; no duplicates', async () => {
    const server = instance()
    await populate(server)
    const deps = server.deps
    const backup = await exportZip(server)
    const upload = await reorganize(server, backup.backupId, (files, put) => {
      files.delete('library/notes/b.md')
      put('library/new/c.md', 'a new file')
      files.set('library/notes/aa.md', files.get('library/notes/a.md') as Uint8Array)
      files.delete('library/notes/a.md')
    })
    const preview = await previewImport(deps, upload)
    expect(kinds(preview, 'move').map((m) => m.move?.to)).toEqual(['/library/notes/aa.md'])
    const only = preview.items.filter((i) => i.status === 'only-live' && i.section === 'library')
    expect(only.map((i) => i.label)).toEqual(['/library/notes/b.md'])
    expect(only[0]?.conflict).toBe(false)
    expect(preview.items.some((i) => i.label === '/library/new/c.md' && i.status === 'added')).toBe(
      true,
    )

    const kept = await applyImport(deps, upload, {}, { by: 'web' })
    expect(kept.counts.failed).toBe(0)
    expect(await text(server, '/library/notes/b.md')).toBe('beta notes')
    expect(await text(server, '/library/new/c.md')).toBe('a new file')
    expect(await text(server, '/library/notes/aa.md')).toBe('alpha notes')
    // no duplicates: the old path is gone, not left next to the new one
    expect(await text(server, '/library/notes/a.md')).toBeUndefined()

    const mirrored = await applyImport(deps, upload, { removeSections: ['library'] }, { by: 'web' })
    expect(mirrored.counts.removed).toBe(1)
    expect(await text(server, '/library/notes/b.md')).toBeUndefined()
    expect(await text(server, '/library/notes/aa.md')).toBe('alpha notes')
  })

  test('a move that would overwrite, a copy and a missing file are told, not applied', async () => {
    const server = instance()
    await populate(server)
    const deps = server.deps
    const backup = await exportZip(server)
    const upload = await reorganize(server, backup.backupId, (files, put) => {
      files.delete('library/notes/a.md')
      put(
        'migrations/moves.json',
        JSON.stringify([
          { from: '/library/notes/a.md', to: '/library/notes/b.md' },
          { from: '/library/notes/b.md', to: '/library/copy/b.md' },
          { from: '/library/ghost.md', to: '/library/x.md' },
          { from: '/library/notes', to: '/library/other/' },
        ]),
      )
    })
    const preview = await previewImport(deps, upload)
    expect(preview.moves.files).toBe(0)
    const told = preview.warnings.join('\n')
    expect(told).toContain('is taken')
    expect(told).toContain('still in the zip')
    expect(told).toContain('no such file here')
    expect(told).toContain('both ends must be a folder')
  })
})

describe('conflicts: changed here after the export', () => {
  test('a changed file, a changed program and a newer file are flagged and kept unless ticked', async () => {
    const server = instance()
    const { programId } = await populate(server)
    const deps = server.deps
    const backup = await exportZip(server)
    const fs = libraryFs(server.conn.sqlite)
    // production moves on after the export
    await fs.write('/library/notes/b.md', 'beta notes, edited in production')
    await fs.write('/library/notes/new-in-production.md', 'written later')
    updateProgram(deps, programId, { escalation: 'ask the owner first' })
    const upload = await reorganize(server, backup.backupId, (_files, put) => {
      put('library/notes/b.md', 'beta notes, reorganized offline')
    })
    const preview = await previewImport(deps, upload)
    const changed = preview.items.find((i) => i.label === '/library/notes/b.md')
    expect(changed).toMatchObject({ status: 'changed', conflict: true })
    const newer = preview.items.find((i) => i.label === '/library/notes/new-in-production.md')
    expect(newer).toMatchObject({ status: 'only-live', conflict: true })
    expect(preview.sections.find((s) => s.id === 'library')?.conflicts).toBe(2)
    // the zip equals the export and the program was changed here since: a difference that is a conflict
    expect(preview.items.find((i) => i.kind === 'program')).toMatchObject({
      status: 'changed',
      conflict: true,
    })

    // the default keeps the live version, overwrite and the removal tick alone do not change that
    const plain = await applyImport(
      deps,
      upload,
      { overwrite: true, removeSections: ['library'] },
      { by: 'web' },
    )
    expect(plain.counts.failed).toBe(0)
    expect(await text(server, '/library/notes/b.md')).toBe('beta notes, edited in production')
    expect(await text(server, '/library/notes/new-in-production.md')).toBe('written later')
    expect(deps.programs.get(programId)?.escalation).toBe('ask the owner first')

    // the explicit tick replaces and removes them
    const forced = await applyImport(
      deps,
      upload,
      { overwrite: true, overwriteConflicts: true, removeSections: ['library'] },
      { by: 'web' },
    )
    expect(forced.counts.failed).toBe(0)
    expect(await text(server, '/library/notes/b.md')).toBe('beta notes, reorganized offline')
    expect(await text(server, '/library/notes/new-in-production.md')).toBeUndefined()
  })
})

describe('the reference check and the rewrite', () => {
  test('the rewrite is a tick: programs, orders and notes follow the moves, and the undo returns them', async () => {
    const server = instance()
    const { leadId, programId } = await populate(server)
    const deps = server.deps
    // an API agent that may read the reports folder
    const made = await server.app.request('/developer/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Support bot',
        instructions: 'Answer.',
        readFolders: ['/library/reports'],
      }),
    })
    expect(made.status).toBe(201)
    const apiId = ((await made.json()) as { id: string }).id
    const readFolders = async (): Promise<string[]> =>
      (
        (await (await server.app.request(`/developer/agents/${apiId}`)).json()) as {
          readFolders: string[]
        }
      ).readFolders
    const backup = await exportZip(server)
    const upload = await reorganize(server, backup.backupId, (files, put) => {
      for (const n of ['q1', 'q2']) {
        files.set(
          `library/finance/reports/${n}.md`,
          files.get(`library/reports/${n}.md`) as Uint8Array,
        )
        files.delete(`library/reports/${n}.md`)
      }
      files.set('library/knowledge/a.md', files.get('library/notes/a.md') as Uint8Array)
      files.delete('library/notes/a.md')
      put(
        'migrations/moves.json',
        JSON.stringify([{ from: '/library/reports/', to: '/library/finance/reports/' }]),
      )
    })
    const before = await previewImport(deps, upload)
    expect(before.references.dangling.length).toBeGreaterThan(0)
    expect(before.references.dangling.map((r) => r.kind)).toContain('api-agent')
    expect(kinds(before, 'reference').map((i) => i.section)).toContain('api')

    const applied = await applyImport(deps, upload, { rewriteReferences: true }, { by: 'web' })
    expect(applied.counts.failed).toBe(0)
    const program = deps.programs.get(programId)
    expect(program?.authority.write).toEqual(['/library/finance/reports/**'])
    expect(program?.deliverables[0]?.path).toBe('/library/finance/reports/{date}.md')
    // the note and the standing order name the moved note a.md (found by content)
    expect(await text(server, `/memories/agents/${leadId}/index.md`)).toBe(
      'Notes are in /library/knowledge/a.md and the ledger is /library/tracker/ledger.md.',
    )
    const orders = (await text(server, `/memories/agents/${leadId}/HEARTBEAT.md`)) ?? ''
    expect(orders).toContain('refs:%2Flibrary%2Fknowledge%2Fa.md')
    expect(orders).toContain('ledger:%2Flibrary%2Ftracker%2Fledger.md')

    expect(await readFolders()).toEqual(['/library/finance/reports'])
    // nothing dangling is left: the same zip, previewed again
    const after = await previewImport(deps, upload)
    expect(after.references.dangling).toEqual([])
    expect(after.moves.files).toBe(0)

    // undo returns the paths and the references
    const undo = await previewUndo(deps, applied.restorePointId as string)
    const undone = await applyImport(deps, undo.source, undo.selection, {
      by: 'web',
      undoOf: applied.restorePointId as string,
    })
    expect(undone.counts.failed).toBe(0)
    expect(deps.programs.get(programId)?.authority.write).toEqual(['/library/reports/**'])
    expect(deps.programs.get(programId)?.deliverables[0]?.path).toBe('/library/reports/{date}.md')
    expect(await readFolders()).toEqual(['/library/reports'])
    expect(await text(server, '/library/reports/q1.md')).toBe('# Q1\nrevenue up')
    expect(await text(server, `/memories/agents/${leadId}/index.md`)).toContain(
      '/library/notes/a.md',
    )
    expect(await text(server, `/memories/agents/${leadId}/HEARTBEAT.md`)).toContain(
      'refs:%2Flibrary%2Fnotes%2Fa.md',
    )
  })

  test('what a removal would break is reported before the tick is used', async () => {
    const server = instance()
    await populate(server)
    const backup = await exportZip(server)
    const upload = await reorganize(server, backup.backupId, (files) => {
      files.delete('library/reports/q1.md')
      files.delete('library/reports/q2.md')
    })
    const preview = await previewImport(server.deps, upload)
    expect(preview.references.dangling).toEqual([])
    expect(preview.references.atRisk.map((r) => `${r.where}|${r.ref}`)).toContain(
      'authority.write|/library/reports/**',
    )
  })
})
