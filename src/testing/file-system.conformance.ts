import { assertJsonEqual, assertTrue } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/*
 * `eharness/testing` imports core only through `src/index.ts` and never another subpath
 * (ADR-0008), so the `FileSystem` contract of `eharness/filesystem` is mirrored structurally here.
 * Any `FileSystem` is assignable to `FileSystemUnderTest`.
 */

/** Metadata returned by the adapter under test (mirror of `FileMeta` from `eharness/filesystem`). */
interface MetaUnderTest {
  path: string
  version: string
  size: number
  updatedAt?: number
}

/**
 * The `FileSystem` contract of `eharness/filesystem` (spec 08 §1), as checked by
 * {@link fileSystemConformance}. Every `FileSystem` satisfies it.
 */
export interface FileSystemUnderTest {
  read(path: string): Promise<(MetaUnderTest & { content: string }) | null>
  write(
    path: string,
    content: string,
    opts?: { ifVersion?: string | null },
  ): Promise<
    | { ok: true; version: string }
    | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
  >
  delete(
    path: string,
    opts?: { ifVersion?: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }>
  list(prefix?: string): Promise<MetaUnderTest[]>
  stat?(path: string): Promise<MetaUnderTest | null>
  grep?(
    pattern: RegExp,
    opts?: { prefix?: string; maxHits?: number },
  ): Promise<Array<{ path: string; line: number; text: string }>>
  move?(
    from: string,
    to: string,
    opts?: { ifVersion?: string },
  ): Promise<
    { ok: true } | { ok: false; reason: 'missing' | 'exists' | 'conflict'; currentVersion?: string }
  >
}

/** Options of {@link fileSystemConformance}. */
export interface FileSystemConformanceOptions {
  /** Require the optional `stat`. Default false: the case runs only when the adapter has it. */
  requireStat?: boolean
  /** Require the optional `grep`. Default false: the case runs only when the adapter has it. */
  requireGrep?: boolean
  /** Require the optional `move`. Default false: the case runs only when the adapter has it. */
  requireMove?: boolean
}

const encoder = new TextEncoder()
const utf8 = (text: string): number => encoder.encode(text).byteLength

async function written(fs: FileSystemUnderTest, path: string, content: string): Promise<string> {
  const result = await fs.write(path, content)
  assertTrue(result.ok, `unconditional write of ${path} failed: ${JSON.stringify(result)}`)
  return (result as { version: string }).version
}

async function contentOf(fs: FileSystemUnderTest, path: string): Promise<string | null> {
  return (await fs.read(path))?.content ?? null
}

function metaOf(meta: MetaUnderTest): { path: string; version: string; size: number } {
  return { path: meta.path, version: meta.version, size: meta.size }
}

/**
 * Conformance cases for a `FileSystem` adapter (spec 08 §1): read/write/delete round trips with
 * UTF-8 sizes, versions that change iff the content changes, `ifVersion` semantics (`null` =
 * create only, string = compare-and-set, concurrent writers), `DeleteResult` reasons, `list`
 * (recursive, sorted, prefix, metadata only), copies on read, and `stat` / `grep` when
 * implemented, and `move` when implemented.
 *
 * `factory` is called once per case and must return an **empty** file system (e.g. a fresh
 * namespace in a shared database). Paths used are normalized absolute POSIX paths.
 *
 * @example
 * ```ts
 * for (const c of fileSystemConformance(() => postgresFs(db, crypto.randomUUID())))
 *   test(c.name, c.run)
 * ```
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 * @see docs/engineering/testing.md#conformance-suites-public-in-eharnesstesting
 */
export function fileSystemConformance(
  factory: () => FileSystemUnderTest | Promise<FileSystemUnderTest>,
  options: FileSystemConformanceOptions = {},
): ConformanceCase[] {
  return [
    {
      name: 'starts empty; read of a missing file returns null',
      run: async () => {
        const fs = await factory()
        assertJsonEqual(await fs.list(), [], 'list() of a fresh file system')
        assertTrue((await fs.read('/missing.md')) === null, 'read of a missing file must be null')
      },
    },
    {
      name: 'write then read round-trips text, path, version and UTF-8 size',
      run: async () => {
        const fs = await factory()
        const content = '# Title\n\nø — ünïcødé ✓ 🚀\r\nlast line without newline'
        const version = await written(fs, '/docs/a.md', content)
        assertTrue(typeof version === 'string' && version.length > 0, 'version must be non-empty')
        const entry = await fs.read('/docs/a.md')
        assertTrue(entry !== null, 'read after write returned null')
        assertJsonEqual(
          {
            path: entry?.path,
            content: entry?.content,
            version: entry?.version,
            size: entry?.size,
          },
          { path: '/docs/a.md', content, version, size: utf8(content) },
          'read after write',
        )
        if (entry?.updatedAt !== undefined) {
          assertTrue(Number.isFinite(entry.updatedAt), 'updatedAt must be a finite number')
        }
      },
    },
    {
      name: 'stores the empty string as a file',
      run: async () => {
        const fs = await factory()
        await written(fs, '/empty.txt', '')
        const entry = await fs.read('/empty.txt')
        assertTrue(entry !== null && entry.content === '' && entry.size === 0, 'empty file')
      },
    },
    {
      name: 'version changes iff the content changes',
      run: async () => {
        const fs = await factory()
        const v1 = await written(fs, '/a.md', 'one')
        const same = await written(fs, '/a.md', 'one')
        assertTrue(same === v1, 'rewriting identical content must keep the version')
        const v2 = await written(fs, '/a.md', 'two')
        assertTrue(v2 !== v1, 'different content must change the version')
        const back = await written(fs, '/a.md', 'one')
        assertTrue(back === v1, 'the version depends on the content only (not on time or counters)')
        assertTrue((await fs.read('/a.md'))?.version === v1, 'read reports the current version')
      },
    },
    {
      name: 'ifVersion null creates only when the file does not exist',
      run: async () => {
        const fs = await factory()
        const created = await fs.write('/new.md', 'first', { ifVersion: null })
        assertTrue(
          created.ok,
          `create-only write of a missing file failed: ${JSON.stringify(created)}`,
        )
        const again = await fs.write('/new.md', 'second', { ifVersion: null })
        assertTrue(
          !again.ok && again.reason === 'exists',
          `expected 'exists', got ${JSON.stringify(again)}`,
        )
        if (!again.ok && again.currentVersion !== undefined) {
          assertTrue(
            again.currentVersion === (created as { version: string }).version,
            'currentVersion must be the stored version',
          )
        }
        assertTrue(
          (await contentOf(fs, '/new.md')) === 'first',
          'a rejected write must not change the file',
        )
      },
    },
    {
      name: 'ifVersion string writes only when the version matches',
      run: async () => {
        const fs = await factory()
        const v1 = await written(fs, '/a.md', 'one')
        const ok = await fs.write('/a.md', 'two', { ifVersion: v1 })
        assertTrue(ok.ok, `matching ifVersion must write: ${JSON.stringify(ok)}`)
        const v2 = (ok as { version: string }).version
        assertTrue(
          v2 !== v1 && (await fs.read('/a.md'))?.version === v2,
          'returned version is current',
        )

        const stale = await fs.write('/a.md', 'three', { ifVersion: v1 })
        assertTrue(
          !stale.ok && stale.reason === 'conflict',
          `expected 'conflict', got ${JSON.stringify(stale)}`,
        )
        if (!stale.ok && stale.currentVersion !== undefined) {
          assertTrue(stale.currentVersion === v2, 'currentVersion must be the stored version')
        }
        assertTrue(
          (await contentOf(fs, '/a.md')) === 'two',
          'a conflicting write must not change the file',
        )

        const missing = await fs.write('/missing.md', 'x', { ifVersion: v1 })
        assertTrue(
          !missing.ok && missing.reason === 'conflict',
          `ifVersion on a missing file must conflict, got ${JSON.stringify(missing)}`,
        )
        assertTrue(
          (await fs.read('/missing.md')) === null,
          'a conflicting write must not create the file',
        )
      },
    },
    {
      name: 'concurrent conditional writers: exactly one wins',
      run: async () => {
        const fs = await factory()
        const v1 = await written(fs, '/race.md', 'base')
        const results = await Promise.all(
          ['a', 'b', 'c', 'd'].map((text) => fs.write('/race.md', text, { ifVersion: v1 })),
        )
        assertTrue(
          results.filter((r) => r.ok).length === 1,
          `expected one winner: ${JSON.stringify(results)}`,
        )
        const creates = await Promise.all(
          ['a', 'b', 'c'].map((text) => fs.write('/fresh.md', text, { ifVersion: null })),
        )
        assertTrue(
          creates.filter((r) => r.ok).length === 1,
          `expected one creator: ${JSON.stringify(creates)}`,
        )
      },
    },
    {
      name: 'delete reports missing and conflict, and removes the file',
      run: async () => {
        const fs = await factory()
        const missing = await fs.delete('/nope.md')
        assertTrue(
          !missing.ok && missing.reason === 'missing',
          `expected 'missing', got ${JSON.stringify(missing)}`,
        )
        const v1 = await written(fs, '/a.md', 'one')
        const v2 = await written(fs, '/a.md', 'two')
        const conflict = await fs.delete('/a.md', { ifVersion: v1 })
        assertTrue(
          !conflict.ok && conflict.reason === 'conflict',
          `expected 'conflict', got ${JSON.stringify(conflict)}`,
        )
        if (!conflict.ok && conflict.currentVersion !== undefined) {
          assertTrue(conflict.currentVersion === v2, 'currentVersion must be the stored version')
        }
        assertTrue(
          (await contentOf(fs, '/a.md')) === 'two',
          'a conflicting delete must keep the file',
        )
        const deleted = await fs.delete('/a.md', { ifVersion: v2 })
        assertTrue(deleted.ok, `matching ifVersion must delete: ${JSON.stringify(deleted)}`)
        assertTrue((await fs.read('/a.md')) === null, 'read after delete must be null')
        await written(fs, '/b.md', 'b')
        assertTrue((await fs.delete('/b.md')).ok, 'unconditional delete')
        assertJsonEqual(await fs.list(), [], 'list after deleting every file')
        const after = await fs.write('/a.md', 'again', { ifVersion: null })
        assertTrue(after.ok, 'a deleted file can be created again')
      },
    },
    {
      name: 'list is recursive, sorted by path and filtered by prefix',
      run: async () => {
        const fs = await factory()
        const files: Record<string, string> = {
          '/src/z.ts': 'z',
          '/README.md': '# readme',
          '/src/deep/nested/b.ts': 'ünï',
          '/src/a.ts': 'a',
          '/srcx/c.ts': 'c',
          '/A.md': 'upper',
        }
        const versions: Record<string, string> = {}
        for (const [path, content] of Object.entries(files))
          versions[path] = await written(fs, path, content)
        const expected = (paths: string[]) =>
          paths.map((path) => ({
            path,
            version: versions[path],
            size: utf8(files[path] as string),
          }))

        const all = await fs.list()
        assertJsonEqual(
          all.map(metaOf),
          expected([
            '/A.md',
            '/README.md',
            '/src/a.ts',
            '/src/deep/nested/b.ts',
            '/src/z.ts',
            '/srcx/c.ts',
          ]),
          'list() sorted by path (code unit order)',
        )
        assertJsonEqual(
          (await fs.list('/')).map(metaOf),
          all.map(metaOf),
          "list('/') equals list()",
        )
        assertJsonEqual(
          (await fs.list('/src/')).map(metaOf),
          expected(['/src/a.ts', '/src/deep/nested/b.ts', '/src/z.ts']),
          "list('/src/')",
        )
        assertJsonEqual(
          (await fs.list('/src/deep/')).map(metaOf),
          expected(['/src/deep/nested/b.ts']),
          "list('/src/deep/')",
        )
        assertJsonEqual(await fs.list('/nothing/'), [], 'list of an empty prefix')
        for (const meta of all) {
          assertTrue(!('content' in meta), `list() must return metadata only (${meta.path})`)
        }
      },
    },
    {
      name: 'returned objects are copies',
      run: async () => {
        const fs = await factory()
        await written(fs, '/a.md', 'one')
        const entry = await fs.read('/a.md')
        if (entry !== null) {
          entry.content = 'mutated'
          entry.version = 'mutated'
          entry.path = '/mutated'
        }
        const [meta] = await fs.list()
        if (meta !== undefined) meta.version = 'mutated'
        const again = await fs.read('/a.md')
        assertTrue(again?.content === 'one' && again.version !== 'mutated', 'stored file changed')
        assertTrue((await fs.list())[0]?.path === '/a.md', 'stored listing changed')
      },
    },
    {
      name: 'stat returns metadata or null',
      run: async () => {
        const fs = await factory()
        if (fs.stat === undefined) {
          assertTrue(!options.requireStat, 'stat is required but not implemented')
          return
        }
        assertTrue((await fs.stat('/a.md')) === null, 'stat of a missing file must be null')
        const version = await written(fs, '/a.md', 'ø')
        const meta = await fs.stat('/a.md')
        assertTrue(meta !== null, 'stat of an existing file returned null')
        assertJsonEqual(
          metaOf(meta as MetaUnderTest),
          { path: '/a.md', version, size: utf8('ø') },
          'stat',
        )
        await fs.delete('/a.md')
        assertTrue((await fs.stat('/a.md')) === null, 'stat after delete must be null')
      },
    },
    {
      name: 'grep returns 1-based hits sorted by path and line, with prefix and maxHits',
      run: async () => {
        const fs = await factory()
        if (fs.grep === undefined) {
          assertTrue(!options.requireGrep, 'grep is required but not implemented')
          return
        }
        await written(fs, '/src/b.ts', 'const x = 1\nTODO: b\nlet y\n// TODO again')
        await written(fs, '/src/a.ts', 'TODO: a\r\nnothing')
        await written(fs, '/docs/c.md', 'no match\nTODO in docs')
        const hits = await fs.grep(/TODO/)
        assertJsonEqual(
          hits,
          [
            { path: '/docs/c.md', line: 2, text: 'TODO in docs' },
            { path: '/src/a.ts', line: 1, text: 'TODO: a' },
            { path: '/src/b.ts', line: 2, text: 'TODO: b' },
            { path: '/src/b.ts', line: 4, text: '// TODO again' },
          ],
          'grep(/TODO/)',
        )
        assertJsonEqual(
          (await fs.grep(/TODO/g, { prefix: '/src/' })).map((h) => `${h.path}:${h.line}`),
          ['/src/a.ts:1', '/src/b.ts:2', '/src/b.ts:4'],
          'grep with a global regex and a prefix',
        )
        assertJsonEqual(
          (await fs.grep(/TODO/, { maxHits: 2 })).map((h) => `${h.path}:${h.line}`),
          ['/docs/c.md:2', '/src/a.ts:1'],
          'grep with maxHits',
        )
        assertJsonEqual(await fs.grep(/absent/), [], 'grep without matches')
      },
    },
    {
      name: 'move renames atomically and reports missing, exists and conflict',
      run: async () => {
        const fs = await factory()
        if (fs.move === undefined) {
          assertTrue(!options.requireMove, 'move is required but not implemented')
          return
        }
        const missing = await fs.move('/nope.md', '/b.md')
        assertTrue(
          !missing.ok && missing.reason === 'missing',
          `expected 'missing', got ${JSON.stringify(missing)}`,
        )
        const v1 = await written(fs, '/a.md', 'ø one')
        const moved = await fs.move('/a.md', '/dir/b.md')
        assertTrue(moved.ok, `move failed: ${JSON.stringify(moved)}`)
        assertTrue((await fs.read('/a.md')) === null, 'the source must be gone after a move')
        const entry = await fs.read('/dir/b.md')
        assertJsonEqual(
          { content: entry?.content, version: entry?.version, size: entry?.size },
          { content: 'ø one', version: v1, size: utf8('ø one') },
          'the target keeps content, version and size',
        )
        assertJsonEqual(
          (await fs.list()).map((m) => m.path),
          ['/dir/b.md'],
          'list after a move',
        )

        await written(fs, '/c.md', 'c')
        const exists = await fs.move('/c.md', '/dir/b.md')
        assertTrue(
          !exists.ok && exists.reason === 'exists',
          `moving onto an existing file must fail with 'exists', got ${JSON.stringify(exists)}`,
        )
        assertTrue(
          (await contentOf(fs, '/c.md')) === 'c' && (await contentOf(fs, '/dir/b.md')) === 'ø one',
          'a rejected move must change nothing',
        )

        const v2 = await written(fs, '/c.md', 'c2')
        const conflict = await fs.move('/c.md', '/d.md', { ifVersion: v1 })
        assertTrue(
          !conflict.ok && conflict.reason === 'conflict',
          `a stale ifVersion must fail with 'conflict', got ${JSON.stringify(conflict)}`,
        )
        if (!conflict.ok && conflict.currentVersion !== undefined) {
          assertTrue(conflict.currentVersion === v2, 'currentVersion must be the stored version')
        }
        assertTrue(
          (await fs.read('/d.md')) === null,
          'a conflicting move must not create the target',
        )
        const ok = await fs.move('/c.md', '/d.md', { ifVersion: v2 })
        assertTrue(ok.ok, `matching ifVersion must move: ${JSON.stringify(ok)}`)
        assertTrue((await contentOf(fs, '/d.md')) === 'c2', 'moved content')

        const move = fs.move.bind(fs)
        const races = await Promise.all(['/e.md', '/f.md', '/g.md'].map((to) => move('/d.md', to)))
        assertTrue(
          races.filter((r) => r.ok).length === 1,
          `concurrent moves of one file: expected one winner, got ${JSON.stringify(races)}`,
        )
      },
    },
  ]
}
