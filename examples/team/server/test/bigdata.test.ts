/**
 * Big-data toolkit (docs/plans/P40-team-autonomous-operations.md, phase D, decisions D7 and D8):
 * the collector and its ingest, the manifest, the `run_code` sandbox and the tools under a
 * program's authority. The auditor scenario on a 5 000-message day is in `bigdata-audit.test.ts`.
 * No model, no network.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { FileSystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import {
  type CollectedItem,
  cursorPath,
  groupByFile,
  itemPath,
  mergeJsonl,
} from '../src/domain/collectors.ts'
import {
  createManifest,
  MAX_CHUNK_ATTEMPTS,
  markChunk,
  nextChunks,
  progressOf,
} from '../src/domain/manifest.ts'
import { createCodeRunner } from '../src/infra/bigdata/code-sandbox.ts'
import { communityFixture } from '../src/infra/bigdata/fixture-collector.ts'
import { ingestSource } from '../src/infra/bigdata/ingest.ts'
import { bigData } from '../src/infra/bigdata/plugin.ts'

const fixtureDay = communityFixture()

describe('fixture collector', () => {
  test('is deterministic, has the requested size and plants the incidents it lists', () => {
    const a = communityFixture().items()
    const b = communityFixture().items()
    expect(a).toHaveLength(5000)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(communityFixture({ seed: 8 }).items())).not.toBe(JSON.stringify(a))
    // a realistic size: about 800 KB of JSON, several channels, unique ids in time order
    expect(JSON.stringify(a).length).toBeGreaterThan(700_000)
    expect(new Set(a.map((i) => i.channel)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(a.map((i) => i.id)).size).toBe(5000)
    expect([...a].sort((x, y) => x.at - y.at).map((i) => i.id)).toEqual(a.map((i) => i.id))
    const t = communityFixture().truth()
    expect(t.spamBursts).toHaveLength(3)
    for (const burst of t.spamBursts) expect(burst.ids.length).toBeGreaterThanOrEqual(20)
    expect(t.raid.joinIds.length).toBeGreaterThanOrEqual(40)
    expect(t.modAbuse.deleteIds.length).toBeGreaterThanOrEqual(10)
    const byId = new Map(a.map((i) => [i.id, i]))
    // a delete points at a real message of the victim
    const target = byId.get(String(byId.get(t.modAbuse.deleteIds[0] as string)?.targetId))
    expect(target?.author).toBe(t.modAbuse.victim)
    expect(byId.get(t.suspiciousRoleChangeId)).toMatchObject({ action: 'role_change' })
  })

  test('poll pages through the day with a cursor and ends with nothing', async () => {
    const f = communityFixture({ messages: 2500, pageSize: 1000 })
    const p1 = await f.poll(null)
    const p2 = await f.poll(p1.cursor)
    const p3 = await f.poll(p2.cursor)
    const p4 = await f.poll(p3.cursor)
    expect([p1.items.length, p2.items.length, p3.items.length, p4.items.length]).toEqual([
      1000, 1000, 500, 0,
    ])
    // the same cursor gives the same page (a crashed ingest can repeat it)
    expect((await f.poll(p1.cursor)).items.map((i) => i.id)).toEqual(p2.items.map((i) => i.id))
    expect(p4.cursor).toBe(p3.cursor)
  })
})

describe('collector paths and merge', () => {
  const at = Date.UTC(2026, 9, 11, 9, 30)
  test('an item lands in <source>/<channel>/<day>/<hour>.jsonl (UTC), channel sanitized', () => {
    expect(itemPath('community', { channel: 'general', at })).toBe(
      '/library/data/community/general/2026-10-11/09.jsonl',
    )
    expect(itemPath('x', { channel: '../Evil Chan!', at })).toBe(
      '/library/data/x/evil-chan/2026-10-11/09.jsonl',
    )
    expect(cursorPath('community')).toBe('/library/data/community/_cursor.json')
  })

  test('merging keeps old lines, skips known ids, sorts by time then id', () => {
    const mk = (id: string, t: number): CollectedItem => ({ id, channel: 'c', at: t })
    const first = mergeJsonl(undefined, [mk('b', at + 2), mk('a', at + 1)])
    expect(first.added).toBe(2)
    expect(
      first.text
        .trim()
        .split('\n')
        .map((l: string) => JSON.parse(l).id),
    ).toEqual(['a', 'b'])
    const second = mergeJsonl(first.text, [mk('b', at + 2), mk('c', at + 3)])
    expect(second.added).toBe(1)
    expect(second.text.trim().split('\n')).toHaveLength(3)
    const groups = groupByFile('s', [mk('a', at), mk('z', at + 3_600_000)])
    expect([...groups.keys()]).toEqual([
      '/library/data/s/c/2026-10-11/09.jsonl',
      '/library/data/s/c/2026-10-11/10.jsonl',
    ])
  })
})

describe('ingest', () => {
  const lines = async (fs: FileSystem, prefix: string): Promise<number> => {
    let n = 0
    for (const meta of await fs.list(prefix)) {
      if (!meta.path.endsWith('.jsonl')) continue
      n += ((await fs.read(meta.path))?.content ?? '').split('\n').filter((l) => l !== '').length
    }
    return n
  }

  test('writes the day as hourly files and a cursor; a second call has nothing new', async () => {
    const fs = inMemoryFs()
    const first = await ingestSource(fs, fixtureDay)
    expect(first).toMatchObject({ added: 5000, duplicates: 0, drained: true, total: 5000 })
    expect(first.channels).toContain('general')
    expect(first.firstDay).toBe('2026-10-11')
    expect(first.files).toBeGreaterThan(50)
    expect(await lines(fs, '/library/data/community/')).toBe(5000)
    const again = await ingestSource(fs, fixtureDay)
    expect(again).toMatchObject({ added: 0, duplicates: 0, drained: true })
    expect(await lines(fs, '/library/data/community/')).toBe(5000)
  })

  test('a bounded call drains a long backlog over several calls', async () => {
    const fs = inMemoryFs()
    const f = communityFixture({ messages: 2500, pageSize: 1000 })
    const a = await ingestSource(fs, f, { maxItems: 1000 })
    expect(a).toMatchObject({ added: 1000, drained: false })
    const b = await ingestSource(fs, f, { maxItems: 1000 })
    expect(b.added).toBe(1000)
    const c = await ingestSource(fs, f)
    expect(c).toMatchObject({ added: 500, drained: true, total: 2500 })
    expect(await lines(fs, '/library/data/community/')).toBe(2500)
  })

  test('a crash between the files and the cursor re-delivers a page without duplicates', async () => {
    const fs = inMemoryFs()
    const f = communityFixture({ messages: 1500, pageSize: 1000 })
    await ingestSource(fs, f, { maxItems: 1000 })
    // the cursor was lost (the process died after the files were stored)
    await fs.delete(cursorPath('community'))
    const r = await ingestSource(fs, f)
    expect(r.duplicates).toBe(1000)
    expect(r.added).toBe(500)
    expect(await lines(fs, '/library/data/community/')).toBe(1500)
  })

  test('a write outside the authority stops the page before anything of it is stored', async () => {
    const fs = inMemoryFs()
    await expect(ingestSource(fs, fixtureDay, { canWrite: () => false })).rejects.toThrow(
      /outside the write authority/,
    )
    expect(await fs.list('/library/data/')).toHaveLength(0)
  })
})

describe('manifest', () => {
  const specs = ['a', 'b', 'c'].map((id) => ({ id }))
  test('chunks start pending; done moves the cursor; failed gets three attempts', () => {
    let m = createManifest('r1', specs, 1, 'audit')
    expect(progressOf(m)).toMatchObject({ total: 3, pending: 3, complete: false, lastDone: null })
    const done = markChunk(
      m,
      'a',
      { status: 'done', findings: '/library/work/r1/findings/a.json' },
      2,
    )
    if (!done.ok) throw new Error(done.error)
    m = done.manifest
    expect(m.cursor.lastDone).toBe('a')
    expect(nextChunks(m, 5).map((c) => c.id)).toEqual(['b', 'c'])
    for (let i = 0; i < MAX_CHUNK_ATTEMPTS; i++) {
      const failed = markChunk(m, 'b', { status: 'failed', error: 'bad' }, 3)
      if (!failed.ok) throw new Error(failed.error)
      m = failed.manifest
    }
    // exhausted: no longer offered, and it does not block completion
    expect(nextChunks(m, 5).map((c) => c.id)).toEqual(['c'])
    expect(progressOf(m)).toMatchObject({ done: 1, pending: 1, exhausted: 1 })
    const last = markChunk(m, 'c', { status: 'done' }, 4)
    if (!last.ok) throw new Error(last.error)
    expect(progressOf(last.manifest)).toMatchObject({ complete: true, lastDone: 'c' })
    expect(markChunk(m, 'nope', { status: 'done' }, 5)).toMatchObject({ ok: false })
  })

  test('bad run ids and duplicate chunk ids are refused', () => {
    expect(() => createManifest('../x', specs, 1)).toThrow(/run id/)
    expect(() => createManifest('r', [{ id: 'a' }, { id: 'a' }], 1)).toThrow(/duplicate/)
    expect(() => createManifest('r', [], 1)).toThrow(/at least one/)
  })
})

describe('run_code sandbox', () => {
  const runner = createCodeRunner({ limits: { timeoutMs: 5000, maxOutputBytes: 2000 } })
  const inputs = new Map([
    ['/library/data/x/a.jsonl', new TextEncoder().encode('{"n":1}\n{"n":2}\n')],
    ['/library/data/x/b.jsonl', new TextEncoder().encode('{"n":3}\n')],
  ])
  const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b)

  test('runs code over the inputs with the helpers; new and changed files come back, unchanged ones do not', async () => {
    const r = await runner.run({
      inputs,
      code: `
        const rows = readJsonlDir('/library/data/x/')
        print({ n: rows.length, sum: rows.reduce((a, r) => a + r.n, 0), files: list('/library/data/x/') })
        writeJson('/library/work/out.json', { rows: rows.length })
        writeJsonl('/library/data/x/a.jsonl', [{ n: 10 }])
        writeText('/library/work/deep/er/note.txt', 'hi')
      `,
    })
    expect(r.error).toBeUndefined()
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      n: 3,
      sum: 6,
      files: ['/library/data/x/a.jsonl', '/library/data/x/b.jsonl'],
    })
    expect([...r.files.keys()].sort()).toEqual([
      '/library/data/x/a.jsonl',
      '/library/work/deep/er/note.txt',
      '/library/work/out.json',
    ])
    expect(text(r.files.get('/library/data/x/a.jsonl'))).toBe('{"n":10}\n')
    expect(JSON.parse(text(r.files.get('/library/work/out.json')))).toEqual({ rows: 3 })
  })

  test('a failing run saves nothing and reports stderr; a timeout stops the code', async () => {
    const bad = await runner.run({
      inputs,
      code: `writeText('/library/work/partial.txt', 'x'); throw new Error('boom')`,
    })
    expect(bad.exitCode).not.toBe(0)
    expect(bad.stderr).toContain('boom')
    expect(bad.files.size).toBe(0)
    const slow = await runner.run({ inputs, code: 'while (true) {}', timeoutMs: 600 })
    expect(slow).toMatchObject({ timedOut: true, exitCode: null })
    expect(slow.durationMs).toBeLessThan(5000)
  })

  test('output over the cap stops the run; a path with .. is refused by the helpers', async () => {
    const loud = await runner.run({
      inputs,
      code: `for (let i = 0; i < 100000; i++) console.log('x'.repeat(200))`,
    })
    expect(loud.outputTruncated).toBe(true)
    expect(loud.stdout.length).toBeLessThanOrEqual(2000)
    const esc = await runner.run({ inputs, code: `writeText('/library/../../escape.txt', 'x')` })
    expect(esc.exitCode).not.toBe(0)
    expect(esc.stderr).toContain('..')
  })

  test('the environment of the server is not visible to the code', async () => {
    process.env.TEAM_SECRET_PROBE = 'topsecret'
    try {
      const r = await runner.run({ inputs, code: `print(process.env.TEAM_SECRET_PROBE ?? 'none')` })
      expect(r.stdout.trim()).toBe('none')
    } finally {
      delete process.env.TEAM_SECRET_PROBE
    }
  })

  const PROBE = join(import.meta.dir, 'sandbox-escape-probe.txt')
  test('no network, and no writes outside the scratch directory (OS sandbox) or a soft guard without it', async () => {
    const r = await runner.run({
      inputs,
      code: `
        let net = 'reached'
        try { await fetch('http://127.0.0.1:9/'); } catch (e) { net = 'blocked' }
        let write = 'wrote'
        try { (await import('node:fs')).writeFileSync(${JSON.stringify(PROBE)}, 'x') } catch { write = 'blocked' }
        print({ net, write })
      `,
    })
    const escaped = existsSync(PROBE)
    rmSync(PROBE, { force: true })
    const out = JSON.parse(r.stdout) as { net: string; write: string }
    if (r.sandbox.os) expect(escaped).toBe(false)
    // fetching a closed local port fails either way; what matters is that it never "reaches"
    expect(out.net).toBe('blocked')
    if (r.sandbox.os) expect(out.write).toBe('blocked')
    // with the OS sandbox on this host, the sandbox says so; otherwise the fallback is stated
    expect(runner.describe().os).toBe(r.sandbox.os)
  })

  test('an OS sandbox that cannot start (no user namespaces) falls back instead of failing', async () => {
    const runner = createCodeRunner({
      probe: async () => ({ kind: 'bubblewrap', ok: false, reason: 'no namespaces' }),
    })
    const r = await runner.run({ inputs, code: `print(1 + 1)` })
    expect(r.error).toBeUndefined()
    expect(r.stdout).toContain('2')
    expect(r.sandbox.os).toBe(false)
    expect(runner.describe().os).toBe(false)
  })

  test('requireOsSandbox refuses to run unsandboxed', async () => {
    const strict = createCodeRunner({ osSandbox: false, requireOsSandbox: true })
    const r = await strict.run({ inputs, code: `print(1)` })
    expect(r.error).toContain('OS sandbox')
    // and the fallback runs with the soft guard
    const soft = createCodeRunner({ osSandbox: false })
    const s = await soft.run({
      inputs,
      code: `let e = 'none'; try { await fetch('https://example.com') } catch (x) { e = String(x.message) }; print(e)`,
    })
    expect(s.sandbox.os).toBe(false)
    expect(s.stdout).toContain('network access is not available')
  })
})

describe('tools outside a program run', () => {
  test('a session without a program has no authority: every tool says so and touches nothing', async () => {
    const fs = inMemoryFs()
    const plugin = bigData({
      fs,
      access: () => undefined,
      collectors: () => [fixtureDay],
      runner: createCodeRunner(),
    })
    const contribution = await plugin['~def'].session?.({ session: { id: 'dm:x' } } as never)
    const tools = (contribution?.tools ?? {}) as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<string> }
    >
    expect(Object.keys(tools).sort()).toEqual([
      'ingest_source',
      'manifest_create',
      'manifest_mark',
      'manifest_next',
      'manifest_status',
      'run_code',
    ])
    const calls: Array<[string, unknown]> = [
      ['run_code', { code: 'print(1)' }],
      ['ingest_source', { source: 'community' }],
      ['manifest_status', { run: 'r' }],
      ['manifest_create', { run: 'r', chunks: [{ id: 'a' }] }],
    ]
    for (const [name, input] of calls) {
      const out = await (tools[name] as (typeof tools)[string]).execute(input, {})
      expect(out).toStartWith(`ERROR: ${name} works inside a program run only`)
    }
    expect(await fs.list('/')).toHaveLength(0)
  })

  test('programOnly: a session without a program is not offered the tools at all', async () => {
    const plugin = bigData({
      fs: inMemoryFs(),
      access: () => undefined,
      collectors: () => [],
      runner: createCodeRunner(),
      programOnly: true,
    })
    const contribution = await plugin['~def'].session?.({ session: { id: 'dm:x' } } as never)
    expect(Object.keys(contribution?.tools ?? {})).toEqual([])
  })

  test('the connector capabilities choose the tools', async () => {
    const plugin = bigData({
      fs: inMemoryFs(),
      access: () => undefined,
      collectors: () => [],
      runner: createCodeRunner(),
      tools: ['run_code', 'manifest_next'],
    })
    const contribution = await plugin['~def'].session?.({ session: { id: 'p' } } as never)
    expect(Object.keys(contribution?.tools ?? {}).sort()).toEqual(['manifest_next', 'run_code'])
  })
})
