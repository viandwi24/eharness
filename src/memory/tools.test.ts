import { describe, expect, test } from 'bun:test'
import { memoryFs } from '../filesystem/memory.ts'
import { normalizePath } from '../filesystem/paths.ts'
import type { FileSystem } from '../filesystem/types.ts'
import { contentVersion } from '../filesystem/version.ts'
import { isHarnessError } from '../index.ts'
import {
  executeMemoryCommand,
  type MemoryCommand,
  type MemoryExecuteOptions,
  type MemoryRoot,
  type MemoryWriteEvent,
} from './execute.ts'
import { normalizeMemoryPath } from './paths.ts'

const roots: MemoryRoot[] = [
  { path: '/memories/u1', write: true, label: 'notes about this user' },
  { path: '/org/', label: 'company policies' },
]

function env(fs: FileSystem, extra: Partial<MemoryExecuteOptions> = {}) {
  const events: MemoryWriteEvent[] = []
  const options: MemoryExecuteOptions = {
    fs,
    roots,
    onWrite: (e) => {
      events.push(e)
    },
    ...extra,
  }
  const run = (input: MemoryCommand | Record<string, unknown>) =>
    executeMemoryCommand(input as MemoryCommand, options)
  return { run, events }
}

/** An adapter without `move` (the plugin falls back to write + delete). */
function withoutMove(fs: FileSystem): FileSystem {
  const { move: _move, ...rest } = fs
  return rest
}

describe('executeMemoryCommand: view', () => {
  test('a file is shown cat -n style; view_range is 1-based inclusive; -1 means the end', async () => {
    const { run } = env(memoryFs({ '/memories/u1/a.md': 'one\ntwo\nthree\n' }))
    expect(await run({ command: 'view', path: '/memories/u1/a.md' })).toBe(
      '     1\tone\n     2\ttwo\n     3\tthree',
    )
    expect(await run({ command: 'view', path: '/memories/u1/a.md', view_range: [2, 3] })).toBe(
      '     2\ttwo\n     3\tthree',
    )
    expect(await run({ command: 'view', path: '/memories/u1/a.md', view_range: [2, -1] })).toBe(
      '     2\ttwo\n     3\tthree',
    )
    // an end past the last line is clamped
    expect(await run({ command: 'view', path: '/memories/u1/a.md', view_range: [3, 9] })).toBe(
      '     3\tthree',
    )
  })

  test('view_range bounds', async () => {
    const { run } = env(memoryFs({ '/memories/u1/a.md': 'one\ntwo\nthree' }))
    for (const range of [
      [0, 2],
      [4, 4],
      [3, 2],
      [2, -2],
    ] as Array<[number, number]>) {
      expect(await run({ command: 'view', path: '/memories/u1/a.md', view_range: range })).toBe(
        `ERROR: invalid view_range [${range[0]}, ${range[1]}]: /memories/u1/a.md has 3 lines.`,
      )
    }
  })

  test('the output of a large file is capped at maxFileChars with a view_range hint', async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const fs = memoryFs({ '/memories/u1/big.md': content, '/memories/u1/wide.md': 'x'.repeat(500) })
    const { run } = env(fs, { maxFileChars: 100 })
    const out = await run({ command: 'view', path: '/memories/u1/big.md' })
    const [shown, note] = out.split('\n(') as [string, string]
    expect(shown.length).toBeLessThanOrEqual(100)
    expect(shown).toStartWith('     1\tline 1\n')
    const lastShown = shown.split('\n').length
    expect(note).toBe(
      `Output truncated at 100 characters; view the rest with view_range [${lastShown + 1}, -1].)`,
    )
    expect(await run({ command: 'view', path: '/memories/u1/big.md', view_range: [49, -1] })).toBe(
      '    49\tline 49\n    50\tline 50',
    )
    const wide = await run({ command: 'view', path: '/memories/u1/wide.md' })
    expect(wide).toStartWith(`     1\t${'x'.repeat(93)} … [line truncated]`)
    expect(wide).not.toContain('view_range')
  })

  test('an empty file', async () => {
    const { run } = env(memoryFs({ '/memories/u1/e.md': '' }))
    expect(await run({ command: 'view', path: '/memories/u1/e.md' })).toBe('(empty file)')
  })

  test('a directory lists its files with sizes; an empty root says so', async () => {
    const { run } = env(
      memoryFs({
        '/memories/u1/b.md': 'ø',
        '/memories/u1/sub/a.md': 'abc',
        '/memories/u2/secret.md': 'hidden',
      }),
    )
    expect(await run({ command: 'view', path: '/memories/u1' })).toBe(
      '/memories/u1/ (2 files):\n/memories/u1/b.md\t2 bytes\n/memories/u1/sub/a.md\t3 bytes',
    )
    expect(await run({ command: 'view', path: '/memories/u1/sub/' })).toBe(
      '/memories/u1/sub/ (1 file):\n/memories/u1/sub/a.md\t3 bytes',
    )
    expect(await run({ command: 'view', path: '/org' })).toBe('/org/ is empty.')
    expect(await run({ command: 'view', path: '/memories/u1/nope' })).toBe(
      'ERROR: /memories/u1/nope does not exist.',
    )
  })
})

describe('executeMemoryCommand: mutations', () => {
  test('create, str_replace, insert, delete and rename with exact results and write events', async () => {
    const fs = memoryFs()
    const { run, events } = env(fs, { toolCallId: 'call-1' })
    expect(await run({ command: 'create', path: '/memories/u1/a.md', file_text: 'hello\n' })).toBe(
      'Created /memories/u1/a.md.',
    )
    expect(
      await run({
        command: 'str_replace',
        path: '/memories/u1/a.md',
        old_str: 'hello',
        new_str: 'hi',
      }),
    ).toBe('Edited /memories/u1/a.md.')
    expect(
      await run({
        command: 'insert',
        path: '/memories/u1/a.md',
        insert_line: 0,
        insert_text: '# Notes\n',
      }),
    ).toBe('Inserted text at the start of /memories/u1/a.md.')
    expect(
      await run({
        command: 'insert',
        path: '/memories/u1/a.md',
        insert_line: 2,
        insert_text: 'end',
      }),
    ).toBe('Inserted text after line 2 of /memories/u1/a.md.')
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('# Notes\nhi\nend\n')
    expect(
      await run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toBe('Renamed /memories/u1/a.md to /memories/u1/b.md.')
    expect(await run({ command: 'delete', path: '/memories/u1/b.md' })).toBe(
      'Deleted /memories/u1/b.md.',
    )
    expect(await fs.list()).toEqual([])

    const v = (text: string) => contentVersion(text)
    expect(events).toEqual([
      {
        op: 'create',
        path: '/memories/u1/a.md',
        after: { version: await v('hello\n'), size: 6 },
        toolCallId: 'call-1',
      },
      {
        op: 'str_replace',
        path: '/memories/u1/a.md',
        before: { version: await v('hello\n'), size: 6 },
        after: { version: await v('hi\n'), size: 3 },
        toolCallId: 'call-1',
      },
      {
        op: 'insert',
        path: '/memories/u1/a.md',
        before: { version: await v('hi\n'), size: 3 },
        after: { version: await v('# Notes\nhi\n'), size: 11 },
        toolCallId: 'call-1',
      },
      {
        op: 'insert',
        path: '/memories/u1/a.md',
        before: { version: await v('# Notes\nhi\n'), size: 11 },
        after: { version: await v('# Notes\nhi\nend\n'), size: 15 },
        toolCallId: 'call-1',
      },
      {
        op: 'rename',
        path: '/memories/u1/a.md',
        to: '/memories/u1/b.md',
        before: { version: await v('# Notes\nhi\nend\n'), size: 15 },
        after: { version: await v('# Notes\nhi\nend\n'), size: 15 },
        toolCallId: 'call-1',
      },
      {
        op: 'delete',
        path: '/memories/u1/b.md',
        before: { version: await v('# Notes\nhi\nend\n'), size: 15 },
        toolCallId: 'call-1',
      },
    ])
  })

  test('insert into a file without a final line break and into an empty file', async () => {
    const fs = memoryFs({ '/memories/u1/a.md': 'a\nb', '/memories/u1/e.md': '' })
    const { run } = env(fs)
    await run({ command: 'insert', path: '/memories/u1/a.md', insert_line: 1, insert_text: 'x' })
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('a\nx\nb')
    await run({ command: 'insert', path: '/memories/u1/a.md', insert_line: 3, insert_text: 'z' })
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('a\nx\nb\nz')
    await run({ command: 'insert', path: '/memories/u1/e.md', insert_line: 0, insert_text: 'y' })
    expect((await fs.read('/memories/u1/e.md'))?.content).toBe('y\n')
    expect(
      await run({ command: 'insert', path: '/memories/u1/a.md', insert_line: 5, insert_text: 'q' }),
    ).toBe('ERROR: invalid insert_line 5: /memories/u1/a.md has 4 lines.')
  })

  test('insert of an empty text is an error', async () => {
    const fs = memoryFs({ '/memories/u1/a.md': 'a\n' })
    expect(
      await env(fs).run({
        command: 'insert',
        path: '/memories/u1/a.md',
        insert_line: 0,
        insert_text: '',
      }),
    ).toBe('ERROR: insert_text must not be empty.')
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('a\n')
  })

  test('expected failures are prefixed strings', async () => {
    const fs = memoryFs({
      '/memories/u1/a.md': 'x x',
      '/memories/u1/dir/f.md': 'f',
      '/org/policy.md': 'p',
    })
    const { run, events } = env(fs)
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { command: 'create', path: '/memories/u1/a.md', file_text: 'y' },
        'ERROR: /memories/u1/a.md already exists. Change it with str_replace or insert, or delete it first.',
      ],
      [
        { command: 'create', path: '/memories/u1/dir', file_text: 'y' },
        'ERROR: /memories/u1/dir is a directory.',
      ],
      [
        { command: 'create', path: '/memories/u1', file_text: 'y' },
        'ERROR: /memories/u1 is a directory.',
      ],
      [
        { command: 'str_replace', path: '/memories/u1/a.md', old_str: 'x', new_str: 'y' },
        'ERROR: old_str occurs 2 times in /memories/u1/a.md; include more surrounding text so it is unique.',
      ],
      [
        { command: 'str_replace', path: '/memories/u1/a.md', old_str: 'z', new_str: 'y' },
        'ERROR: old_str was not found in /memories/u1/a.md.',
      ],
      [
        { command: 'str_replace', path: '/memories/u1/a.md', old_str: '', new_str: 'y' },
        'ERROR: old_str must not be empty.',
      ],
      [
        { command: 'str_replace', path: '/memories/u1/n.md', old_str: 'a', new_str: 'b' },
        'ERROR: /memories/u1/n.md does not exist.',
      ],
      [
        { command: 'delete', path: '/memories/u1/n.md' },
        'ERROR: /memories/u1/n.md does not exist.',
      ],
      [
        { command: 'delete', path: '/memories/u1/dir' },
        'ERROR: /memories/u1/dir is a directory; delete its files one by one.',
      ],
      [
        { command: 'rename', old_path: '/memories/u1/a.md', new_path: '/memories/u1/dir/f.md' },
        'ERROR: /memories/u1/dir/f.md already exists.',
      ],
      [
        { command: 'rename', old_path: '/memories/u1/n.md', new_path: '/memories/u1/m.md' },
        'ERROR: /memories/u1/n.md does not exist.',
      ],
      [
        { command: 'rename', old_path: '/memories/u1/dir', new_path: '/memories/u1/dir2' },
        'ERROR: /memories/u1/dir is a directory; rename its files one by one.',
      ],
      [{ command: 'delete', path: '/org/policy.md' }, 'REJECTED: /org/policy.md is read-only.'],
      [
        { command: 'create', path: '/org/new.md', file_text: 'x' },
        'REJECTED: /org/new.md is read-only.',
      ],
      [
        { command: 'rename', old_path: '/org/policy.md', new_path: '/memories/u1/p.md' },
        'REJECTED: /org/policy.md is read-only.',
      ],
      [
        { command: 'rename', old_path: '/memories/u1/a.md', new_path: '/org/a.md' },
        'REJECTED: /org/a.md is read-only.',
      ],
      [{ command: 'view', path: '/memories' }, 'REJECTED: /memories is outside the memory roots.'],
      [
        { command: 'view', path: '/memories/u2/secret.md' },
        'REJECTED: /memories/u2/secret.md is outside the memory roots.',
      ],
      [{ command: 'move', path: '/a' }, 'ERROR: invalid input: unknown command "move".'],
      [{ command: 'view' }, 'ERROR: invalid input: `path` must be a string.'],
      [
        { command: 'insert', path: '/memories/u1/a.md', insert_line: -1, insert_text: 'q' },
        'ERROR: invalid input: `insert_line` must be an integer ≥ 0.',
      ],
    ]
    for (const [input, expected] of cases) expect(await run(input)).toBe(expected)
    expect(await run(null as unknown as Record<string, unknown>)).toBe(
      'ERROR: invalid input: expected an object with a `command`.',
    )
    expect(events).toEqual([])
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('x x')
  })

  test('traversal and invalid paths never reach outside the roots', async () => {
    const fs = memoryFs({ '/memories/u2/secret.md': 'secret', '/etc/passwd': 'root' })
    const { run } = env(fs)
    expect(await run({ command: 'view', path: '/memories/u1/../u2/secret.md' })).toBe(
      'REJECTED: /memories/u2/secret.md is outside the memory roots.',
    )
    expect(await run({ command: 'view', path: '/memories/u1/../../etc/passwd' })).toBe(
      'REJECTED: /etc/passwd is outside the memory roots.',
    )
    expect(await run({ command: 'view', path: '/../../etc/passwd' })).toBe(
      'ERROR: invalid path: the path escapes the root',
    )
    expect(await run({ command: 'view', path: '/memories/u1\\..\\u2' })).toBe(
      "ERROR: invalid path: use '/' as separator, not '\\'",
    )
    expect(await run({ command: 'view', path: '/memories/u1/a\u0000.md' })).toBe(
      'ERROR: invalid path: the path contains a NUL character',
    )
    // `//` collapses and relative paths resolve from `/`
    expect(await run({ command: 'create', path: 'memories//u1/./x.md', file_text: 'x' })).toBe(
      'Created /memories/u1/x.md.',
    )
    // a sibling with the same prefix is not inside the root (directory semantics)
    expect(await run({ command: 'create', path: '/memories/u1x/a.md', file_text: 'x' })).toBe(
      'REJECTED: /memories/u1x/a.md is outside the memory roots.',
    )
  })

  test('size limit on create and after an edit', async () => {
    const fs = memoryFs({ '/memories/u1/a.md': '12345' })
    const { run } = env(fs, { maxFileChars: 6 })
    expect(await run({ command: 'create', path: '/memories/u1/b.md', file_text: '1234567' })).toBe(
      'ERROR: /memories/u1/b.md would exceed 6 characters.',
    )
    expect(
      await run({
        command: 'str_replace',
        path: '/memories/u1/a.md',
        old_str: '5',
        new_str: '567',
      }),
    ).toBe('ERROR: /memories/u1/a.md would exceed 6 characters.')
    expect(
      await run({
        command: 'insert',
        path: '/memories/u1/a.md',
        insert_line: 1,
        insert_text: 'abc',
      }),
    ).toBe('ERROR: /memories/u1/a.md would exceed 6 characters.')
    expect((await fs.read('/memories/u1/a.md'))?.content).toBe('12345')
  })

  test('a concurrent writer between read and write → CONFLICT, nothing written', async () => {
    const base = memoryFs({ '/memories/u1/a.md': 'one' })
    let interfere = true
    let writes = 0
    const racing: FileSystem = {
      ...base,
      read: async (path) => {
        const entry = await base.read(path)
        if (interfere && entry !== null) {
          interfere = false
          await base.write(path, `someone else ${writes++}`)
        }
        return entry
      },
    }
    const { run, events } = env(racing)
    expect(
      await run({
        command: 'str_replace',
        path: '/memories/u1/a.md',
        old_str: 'one',
        new_str: '1',
      }),
    ).toBe(
      'CONFLICT: /memories/u1/a.md was changed meanwhile; nothing was written. Run the command again.',
    )
    expect((await base.read('/memories/u1/a.md'))?.content).toBe('someone else 0')
    interfere = true
    expect(await run({ command: 'delete', path: '/memories/u1/a.md' })).toStartWith('CONFLICT:')
    expect(events).toEqual([])
    // a create that loses the race reports the existing file
    const creating: FileSystem = {
      ...base,
      write: async (path, content, opts) => {
        await base.write(path, 'first', { ifVersion: null })
        return base.write(path, content, opts)
      },
    }
    expect(
      await env(creating).run({ command: 'create', path: '/memories/u1/new.md', file_text: 'x' }),
    ).toStartWith('ERROR: /memories/u1/new.md already exists.')
  })

  test('rename without move falls back to write + delete', async () => {
    const fs = withoutMove(memoryFs({ '/memories/u1/a.md': 'a' }))
    const { run, events } = env(fs)
    expect(
      await run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toBe('Renamed /memories/u1/a.md to /memories/u1/b.md.')
    expect((await fs.list()).map((f) => f.path)).toEqual(['/memories/u1/b.md'])
    expect(events.map((e) => e.op)).toEqual(['rename'])
  })

  test('rename fallback: a failure after the copy removes the copy and returns CONFLICT', async () => {
    const base = withoutMove(memoryFs({ '/memories/u1/a.md': 'a' }))
    const fs: FileSystem = {
      ...base,
      write: async (path, content, opts) => {
        const result = await base.write(path, content, opts)
        // someone edits the source right after the copy was written
        await base.write('/memories/u1/a.md', 'changed')
        return result
      },
    }
    const { run, events } = env(fs)
    expect(
      await run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toBe(
      'CONFLICT: /memories/u1/a.md was changed meanwhile; nothing was written. Run the command again.',
    )
    expect((await base.list()).map((f) => f.path)).toEqual(['/memories/u1/a.md'])
    expect(events).toEqual([])
  })

  test('rename fallback: an adapter error on the source delete removes the copy and propagates', async () => {
    const base = withoutMove(memoryFs({ '/memories/u1/a.md': 'a' }))
    const fs: FileSystem = {
      ...base,
      delete: async (path, opts) => {
        if (path === '/memories/u1/a.md') throw new Error('disk on fire')
        return base.delete(path, opts)
      },
    }
    const { run, events } = env(fs)
    let error: unknown
    try {
      await run({ command: 'rename', old_path: '/memories/u1/a.md', new_path: '/memories/u1/b.md' })
    } catch (e) {
      error = e
    }
    expect(String(error)).toContain('disk on fire')
    expect((await base.list()).map((f) => f.path)).toEqual(['/memories/u1/a.md'])
    expect(events).toEqual([])
  })

  test('rename fallback: the event carries the version of the copy', async () => {
    const base = withoutMove(memoryFs({ '/memories/u1/a.md': 'a' }))
    const fs: FileSystem = {
      ...base,
      write: async (path, content, opts) => {
        const result = await base.write(path, content, opts)
        return result.ok ? { ok: true, version: `copy-${result.version}` } : result
      },
    }
    const { run, events } = env(fs)
    expect(
      await run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toBe('Renamed /memories/u1/a.md to /memories/u1/b.md.')
    expect(events[0]?.after?.version).toBe(`copy-${await contentVersion('a')}`)
    expect(events[0]?.before?.version).toBe(await contentVersion('a'))
  })

  test('rename with move: a conflicting move is CONFLICT; the target exists is ERROR', async () => {
    const base = memoryFs({ '/memories/u1/a.md': 'a' })
    const fs: FileSystem = {
      ...base,
      move: async () => ({ ok: false, reason: 'conflict' }),
    }
    expect(
      await env(fs).run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toStartWith('CONFLICT: /memories/u1/a.md')
    const exists: FileSystem = { ...base, move: async () => ({ ok: false, reason: 'exists' }) }
    expect(
      await env(exists).run({
        command: 'rename',
        old_path: '/memories/u1/a.md',
        new_path: '/memories/u1/b.md',
      }),
    ).toBe('ERROR: /memories/u1/b.md already exists.')
  })

  test('onWrite errors never change the result; they go to onWriteError', async () => {
    const errors: unknown[] = []
    const { run } = env(memoryFs(), {
      onWrite: () => {
        throw new Error('audit down')
      },
      onWriteError: (error) => {
        errors.push(error)
      },
    })
    expect(await run({ command: 'create', path: '/memories/u1/a.md', file_text: 'a' })).toBe(
      'Created /memories/u1/a.md.',
    )
    expect(String(errors[0])).toContain('audit down')
  })

  test('the most specific root decides write access', async () => {
    const fs = memoryFs()
    const run = (input: MemoryCommand) =>
      executeMemoryCommand(input, {
        fs,
        roots: [{ path: '/m' }, { path: '/m/mine', write: true }],
      })
    expect(await run({ command: 'create', path: '/m/mine/a.md', file_text: 'a' })).toBe(
      'Created /m/mine/a.md.',
    )
    expect(await run({ command: 'create', path: '/m/other.md', file_text: 'a' })).toBe(
      'REJECTED: /m/other.md is read-only.',
    )
  })

  test('invalid roots are a programmer error (EH_CONFIG_INVALID)', async () => {
    const fs = memoryFs()
    const codeOf = (promise: Promise<string>) =>
      promise.then(
        () => 'resolved',
        (e: unknown) => (isHarnessError(e, 'EH_CONFIG_INVALID') ? 'EH_CONFIG_INVALID' : String(e)),
      )
    expect(
      await codeOf(
        executeMemoryCommand({ command: 'view', path: '/a' }, { fs, roots: [{ path: '/../x' }] }),
      ),
    ).toBe('EH_CONFIG_INVALID')
    expect(
      await codeOf(
        executeMemoryCommand(
          { command: 'view', path: '/a' },
          { fs, roots: 'nope' as unknown as MemoryRoot[] },
        ),
      ),
    ).toBe('EH_CONFIG_INVALID')
  })

  test('no roots: everything is outside', async () => {
    const out = await executeMemoryCommand(
      { command: 'view', path: '/' },
      { fs: memoryFs(), roots: [] },
    )
    expect(out).toBe('REJECTED: / is outside the memory roots.')
  })
})

describe('paths', () => {
  test('normalizeMemoryPath mirrors normalizePath of eharness/filesystem', () => {
    const samples = [
      '/a/b',
      'a//b/./c/',
      '/a/../b',
      '/../x',
      '..',
      '',
      '   ',
      'a\\b',
      'a\u0000b',
      '/',
      '//',
      '/a/b/../../..',
      `/${'x'.repeat(5000)}`,
    ]
    for (const sample of samples) expect(normalizeMemoryPath(sample)).toEqual(normalizePath(sample))
  })
})

describe('property: no path outside the roots is read or written', () => {
  /** Deterministic PRNG (mulberry32). */
  function rng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const segments = ['..', '.', '', 'memories', 'u1', 'u2', 'org', 'u1x', 'a.md', 'secret.md', ' ']

  test('random paths and commands', async () => {
    const random = rng(42)
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
    const genPath = () => {
      const n = 1 + Math.floor(random() * 6)
      const parts = Array.from({ length: n }, () => pick(segments))
      return (random() < 0.8 ? '/' : '') + parts.join('/')
    }
    const outside = { '/memories/u2/secret.md': 'TOP-SECRET-U2', '/secret.md': 'TOP-SECRET-ROOT' }
    for (const fsKind of ['move', 'no-move'] as const) {
      const base = memoryFs({ ...outside, '/org/a.md': 'org', '/memories/u1/a.md': 'mine' })
      const fs = fsKind === 'move' ? base : withoutMove(base)
      const { run } = env(fs)
      for (let i = 0; i < 400; i++) {
        const command = pick([
          'view',
          'create',
          'str_replace',
          'insert',
          'delete',
          'rename',
        ] as const)
        const input: Record<string, unknown> =
          command === 'rename'
            ? { command, old_path: genPath(), new_path: genPath() }
            : command === 'view'
              ? { command, path: genPath() }
              : command === 'create'
                ? { command, path: genPath(), file_text: 'x' }
                : command === 'str_replace'
                  ? { command, path: genPath(), old_str: 'TOP', new_str: 'leak' }
                  : command === 'insert'
                    ? { command, path: genPath(), insert_line: 0, insert_text: 'x' }
                    : { command, path: genPath() }
        const out = await run(input)
        expect(out).not.toContain('TOP-SECRET')
      }
      for (const [path, content] of Object.entries(outside)) {
        expect((await base.read(path))?.content).toBe(content)
      }
      const files = (await base.list()).map((f) => f.path)
      for (const path of files) {
        const allowed = path in outside || path === '/org/a.md' || path.startsWith('/memories/u1/')
        expect(allowed).toBe(true)
      }
      expect((await base.read('/org/a.md'))?.content).toBe('org')
    }
  })
})
