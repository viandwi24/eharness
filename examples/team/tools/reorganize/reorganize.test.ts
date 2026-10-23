import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseManifest, textOf } from '../../server/src/domain/workspace-export.ts'
import { readZip } from '../../server/src/infra/backup/zip-reader.ts'
import { packWorkspace } from './pack.ts'
import { formatReport, libraryPathsIn, staticPrefix, validateWorkspace } from './validate.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const put = (root: string, path: string, content: unknown): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  )
}

/** A small reorganized workspace: one company folder, one program, one agent, one API agent. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'reorg-'))
  dirs.push(root)
  put(root, 'manifest.json', {
    format: 'eharness-team-workspace',
    formatVersion: 2,
    app: { name: 'eharness-team', version: '0.0.0' },
    createdAt: 1,
    counts: {},
    files: [],
    excluded: [],
    secrets: { included: false, count: 0 },
    notice: 'n',
  })
  put(root, 'settings.json', { settings: { worksRoot: '/library/acme/works' }, digest: {} })
  put(root, 'library/acme/profile.md', '# Acme\n')
  put(root, 'library/acme/organization.md', '# Org\n')
  put(root, 'library/acme/divisions/sales/sop.md', '# SOP\n')
  put(root, 'library/acme/reports/weekly/2026-W01.md', '# W1\n')
  put(root, 'library/acme/works/2026/01/02.md', '# Works\n')
  put(root, 'library/programs/weekly/brief.md', 'brief')
  put(root, 'library/programs/weekly/notes.md', '- note')
  put(root, 'agents/lead/agent.json', { slug: 'lead', rules: { allow: [], ask: [], deny: [] } })
  put(root, 'agents/lead/programs/weekly.json', {
    name: 'weekly',
    authority: { read: ['/library/acme/**'], write: ['/library/acme/reports/weekly/**'] },
    deliverables: [{ path: '/library/acme/reports/weekly/{date}.md', kind: 'markdown' }],
    briefPath: '/library/programs/weekly/brief.md',
    notesPath: '/library/programs/weekly/notes.md',
    notes: [],
  })
  put(root, 'agents/lead/programs/weekly.brief.md', 'brief')
  put(root, 'agents/lead/memory/rules.md', '- Facts: /library/acme/profile.md\n')
  put(root, 'agents/lead/memory/index.md', '- /library/acme/organization.md\n')
  put(
    root,
    'agents/lead/memory/HEARTBEAT.md',
    '- Watch the tracker. <!-- order:o1 by:x name:A role:admin report:web:s1 mention:no at:1 ledger:%2Flibrary%2Facme%2Freports%2Fweekly%2F2026-W01.md -->\n',
  )
  put(root, 'data/api_agents/001.json', {
    format: 'eharness-team-rows',
    table: 'api_agents',
    part: 1,
    rows: [{ id: 'a1', slug: 'bot', readFolders: ['/library/acme/divisions/'], writeFolder: null }],
  })
  put(root, 'migrations/moves.json', [
    { from: '/library/old/', to: '/library/acme/divisions/' },
    { from: '/library/profile.md', to: '/library/acme/profile.md', note: 'renamed' },
  ])
  return root
}

const errors = (root: string): string[] =>
  validateWorkspace(root)
    .findings.filter((f) => f.level === 'error')
    .map((f) => `${f.where}: ${f.message}`)

describe('validate', () => {
  test('a reorganized workspace passes', () => {
    const report = validateWorkspace(fixture())
    expect(report.findings.filter((f) => f.level !== 'info')).toEqual([])
    expect(formatReport(report)).toContain('OK')
  })

  test('helpers', () => {
    expect(libraryPathsIn('see /library/a/b.md, and (/library/c/).')).toEqual([
      '/library/a/b.md',
      '/library/c/',
    ])
    expect(staticPrefix('/library/x/{date}.md').prefix).toBe('/library/x/')
    expect(staticPrefix('/library/x/**').dynamic).toBe(true)
  })

  test('bad JSON, missing files and a missing brief', () => {
    const root = fixture()
    put(root, 'people/p1.json', '{ nope')
    rmSync(join(root, 'settings.json'))
    rmSync(join(root, 'agents/lead/programs/weekly.brief.md'))
    const e = errors(root).join('\n')
    expect(e).toContain('people/p1.json: invalid JSON')
    expect(e).toContain('settings.json: required file is missing')
    expect(e).toContain('weekly.brief.md is missing')
  })

  test('moves: "to" must exist and "from" must be gone', () => {
    const root = fixture()
    put(root, 'migrations/moves.json', [
      { from: '/library/acme/profile.md', to: '/library/acme/nowhere.md' },
      { from: '/library/a/', to: '/library/b' },
    ])
    const e = errors(root).join('\n')
    expect(e).toContain('"to" does not exist: /library/acme/nowhere.md')
    expect(e).toContain('"from" still exists: /library/acme/profile.md')
    expect(e).toContain('trailing slash')
  })

  test('moves: a memory file may move into the library, by agent slug or id', () => {
    const root = fixture()
    put(root, 'agents/lead/agent.json', {
      id: 'ag-1',
      slug: 'lead',
      rules: { allow: [], ask: [], deny: [] },
    })
    put(root, 'agents/lead/memory/old-note.md', 'still here')
    put(root, 'migrations/moves.json', [
      { from: '/memories/agents/lead/company.md', to: '/library/acme/profile.md' },
      { from: '/memories/agents/ag-1/team.md', to: '/library/acme/organization.md' },
      { from: '/memories/agents/ag-1/old-note.md', to: '/library/acme/profile.md' },
      { from: '/library/acme/profile.md', to: '/memories/agents/lead/x.md' },
    ])
    const e = errors(root).join('\n')
    expect(e).not.toContain('company.md')
    expect(e).not.toContain('team.md')
    expect(e).toContain('"from" still exists: /memories/agents/ag-1/old-note.md')
    expect(e).toContain('moves.json[3]')
  })

  test('stale references are errors and name where the path moved', () => {
    const root = fixture()
    put(root, 'migrations/moves.json', [
      { from: '/library/reports/', to: '/library/acme/reports/' },
    ])
    put(root, 'agents/lead/memory/rules.md', '- Reports: /library/reports/weekly/2026-W01.md\n')
    const prog = JSON.parse(readFileSync(join(root, 'agents/lead/programs/weekly.json'), 'utf8'))
    prog.authority.write = ['/library/reports/**']
    prog.briefPath = '/library/programs/weekly/missing.md'
    put(root, 'agents/lead/programs/weekly.json', prog)
    put(root, 'data/api_agents/001.json', {
      rows: [
        { slug: 'bot', read_folders: ['/library/ghost/'], write_folder: '/library/acme/reports/' },
      ],
    })
    const e = errors(root).join('\n')
    expect(e).toContain(
      'rules.md: reference points to a moved path: /library/reports/weekly/2026-W01.md',
    )
    expect(e).toContain('authority: reference points to a moved path: /library/reports/**')
    expect(e).toContain('briefPath: file does not exist')
    expect(e).toContain('API agent bot: reference does not resolve: /library/ghost/')
  })

  test('a standing order ledger that does not resolve is an error', () => {
    const root = fixture()
    put(
      root,
      'agents/lead/memory/HEARTBEAT.md',
      '- Track. <!-- order:o1 ledger:%2Flibrary%2Fdata%2Fgone.md -->\n',
    )
    expect(errors(root).join('\n')).toContain(
      'HEARTBEAT.md: reference does not resolve: /library/data/gone.md',
    )
  })

  test('secrets in plain text are errors', () => {
    const root = fixture()
    put(root, 'connections/work.json', { label: 'work', settings: { apiKey: 'abcdef' } })
    put(root, 'library/acme/knowledge/x.md', 'key sk-abcdefghijklmnopqrstuvwxyz123456\n')
    const e = errors(root).join('\n')
    expect(e).toContain('connections/work.json: field settings.apiKey')
    expect(e).toContain('library/acme/knowledge/x.md: looks like an API key')
  })

  test('memory limits and stray memory files', () => {
    const root = fixture()
    put(root, 'agents/lead/memory/rules.md', 'x'.repeat(9_000))
    put(root, 'agents/lead/memory/notes.md', 'old note')
    const report = validateWorkspace(root)
    expect(
      report.findings.some((f) => f.level === 'error' && f.message.includes('over the limit')),
    ).toBe(true)
    expect(report.findings.some((f) => f.level === 'warning' && f.where.endsWith('notes.md'))).toBe(
      true,
    )
  })

  test('files outside the template are warnings, not errors', () => {
    const root = fixture()
    put(root, 'library/stray.md', 'x')
    put(root, 'library/acme/misc/a.md', 'x')
    put(root, 'library/random/b.md', 'x')
    const report = validateWorkspace(root)
    expect(report.errors).toBe(0)
    const where = report.findings.filter((f) => f.level === 'warning').map((f) => f.where)
    expect(where).toEqual(
      expect.arrayContaining(['library/stray.md', 'library/acme/misc/a.md', 'library/random/b.md']),
    )
  })
})

describe('pack', () => {
  test('recomputes the manifest and writes a zip the importer can read', async () => {
    const root = fixture()
    const out = join(root, '..', `${Date.now()}-out.zip`)
    dirs.push(out)
    const result = packWorkspace(root, out, 1_700_000_000_000)
    expect(result.counts.agents).toBe(1)
    expect(result.counts.programs).toBe(1)
    expect(result.counts.api_agents).toBe(1)
    expect(result.counts.memoryFiles).toBe(3)
    const entries = await readZip(new Uint8Array(readFileSync(out)), {
      zipBytes: 1e8,
      entries: 1000,
      entryBytes: 1e7,
      totalBytes: 1e8,
    })
    const manifest = parseManifest(JSON.parse(textOf(entries.get('manifest.json') as Uint8Array)))
    expect(manifest.files.length).toBe(entries.size - 1)
    expect(entries.has('migrations/moves.json')).toBe(true)
    const hasher = new Bun.CryptoHasher('sha256')
    for (const f of manifest.files) {
      expect(hasher.update(entries.get(f.path) as Uint8Array).digest('hex')).toBe(f.sha256)
    }
  })

  test('a hand-edited hash is replaced and a bad entry name is refused', () => {
    const root = fixture()
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    manifest.files = [{ path: 'settings.json', size: 1, sha256: 'a'.repeat(64) }]
    put(root, 'manifest.json', manifest)
    const out = join(root, '..', `${Date.now()}-b.zip`)
    dirs.push(out)
    packWorkspace(root, out)
    put(root, 'weird/file.txt', 'x')
    expect(() => packWorkspace(root, out)).toThrow('unexpected path')
  })
})
