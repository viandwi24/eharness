import { describe, expect, test } from 'bun:test'
import type { Deps } from '../src/app/ports.ts'
import { appendWorksJournal, journalBeat, journalProgramRun } from '../src/app/works-journal.ts'
import { teamMemoryProtocol } from '../src/domain/library-structure.ts'
import { checkSettingsPatch } from '../src/domain/settings.ts'
import {
  appendJournal,
  checkWorksRoot,
  journalLine,
  journalPath,
  WORKS_ROOT_DEFAULT,
} from '../src/domain/works-journal.ts'

// 2026-03-04 23:30 UTC is already 2026-03-05 in Jakarta
const AT = Date.UTC(2026, 2, 4, 23, 30)

describe('works journal (domain)', () => {
  test('the path follows the team timezone', () => {
    expect(journalPath('/library/works', AT, 'UTC')).toBe('/library/works/2026/03/04.md')
    expect(journalPath('/library/works/', AT, 'Asia/Jakarta')).toBe('/library/works/2026/03/05.md')
  })

  test('a line is one bullet with time, author and a link', () => {
    const line = journalLine(
      { by: 'heartbeat ana', text: 'two\nlines', link: '/library/a b.md' },
      AT,
      'UTC',
    )
    expect(line).toBe('- 23:30 [heartbeat ana] two lines ([report](/library/a%20b.md))')
    expect(line.includes('\n')).toBe(false)
  })

  test('append creates the heading once and keeps earlier lines', () => {
    const one = appendJournal(null, { by: 'ana', text: 'first' }, AT, 'UTC')
    const two = appendJournal(one, { by: 'ana', text: 'second' }, AT, 'UTC')
    expect(two.startsWith('# Works 2026-03-04\n')).toBe(true)
    expect(two.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2)
    expect(two.startsWith(one)).toBe(true)
  })

  test('the root is checked and normalized', () => {
    expect(checkWorksRoot(' /library/acme/works/ ')).toBe('/library/acme/works')
    for (const bad of ['/library', '/etc/works', '/library/../x', '/library//a', '/library/a\\b']) {
      expect(() => checkWorksRoot(bad)).toThrow('worksRoot')
    }
    expect(() => checkSettingsPatch({ worksRoot: '/nope' })).toThrow('worksRoot')
    expect(() => checkSettingsPatch({ worksRoot: WORKS_ROOT_DEFAULT })).not.toThrow()
  })

  test('the memory protocol tells agents where the journal is', () => {
    expect(teamMemoryProtocol('/library/acme/works')).toContain('/library/acme/works/YYYY/MM/DD.md')
    expect(teamMemoryProtocol(WORKS_ROOT_DEFAULT)).toContain('Daily journal')
  })
})

/** The slice of Deps the journal uses: an in-memory library with version checks. */
function fakeDeps(settings = { worksRoot: '/library/works', timezone: 'UTC' }) {
  const files = new Map<string, { text: string; version: number }>()
  const deps = {
    clock: { now: () => AT },
    settings: { get: () => settings },
    library: {
      read: async (path: string) => {
        const f = files.get(path)
        return f === undefined
          ? undefined
          : { meta: { version: String(f.version) }, text: f.text, bytes: null }
      },
      writeText: async (path: string, text: string, ifVersion?: string | null) => {
        const f = files.get(path)
        if (ifVersion === null && f !== undefined) return { ok: false, reason: 'exists' }
        if (typeof ifVersion === 'string' && String(f?.version) !== ifVersion) {
          return { ok: false, reason: 'conflict' }
        }
        files.set(path, { text, version: (f?.version ?? 0) + 1 })
        return { ok: true, version: String((f?.version ?? 0) + 1) }
      },
    },
  } as unknown as Deps
  return { deps, files }
}

describe('works journal (app)', () => {
  test('appends to today in the configured root and keeps order', async () => {
    const { deps, files } = fakeDeps({ worksRoot: '/library/acme/works', timezone: 'UTC' })
    await appendWorksJournal(deps, { by: 'ana', text: 'one' })
    const path = await appendWorksJournal(deps, { by: 'ana', text: 'two' })
    expect(path).toBe('/library/acme/works/2026/03/04.md')
    const text = files.get(path as string)?.text ?? ''
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('two'))
  })

  test('a program run and a beat leave one line each with a link', async () => {
    const { deps, files } = fakeDeps()
    await journalProgramRun(
      deps,
      { name: 'weekly' },
      {
        id: 't1',
        status: 'done',
        summary: 'Report written.',
        report: { outputs: ['/library/reports/w1.md'] },
      },
    )
    await journalBeat(
      deps,
      'ana',
      [{ title: 'Tracker overdue', links: ['/library/data/t.md'] }],
      AT,
    )
    const text = files.get('/library/works/2026/03/04.md')?.text ?? ''
    expect(text).toContain(
      '[program weekly] done: Report written. ([report](/library/reports/w1.md))',
    )
    expect(text).toContain(
      '[heartbeat ana] 1 item(s): Tracker overdue ([report](/library/data/t.md))',
    )
  })

  test('a failing library never fails the caller', async () => {
    const { deps } = fakeDeps()
    ;(deps.library as { read: unknown }).read = async () => {
      throw new Error('disk')
    }
    expect(await appendWorksJournal(deps, { by: 'ana', text: 'x' })).toBeUndefined()
  })
})
