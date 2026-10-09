/** `diskFs`: conformance, containment, binary/large files, ignore rules, grep, modes. */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileSystemConformance } from '../../testing/file-system.conformance.ts'
import { diskFs } from './disk-fs.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eh-diskfs-')))
  dirs.push(dir)
  return dir
}
async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
}
const rgOnPath = (): boolean =>
  (process.env.PATH ?? '')
    .split(delimiter)
    .some((d) => d !== '' && Bun.file(join(d, 'rg')).size > 0)

async function withoutRg<T>(work: () => Promise<T>): Promise<T> {
  const path = process.env.PATH
  process.env.PATH = '/nonexistent'
  try {
    return await work()
  } finally {
    process.env.PATH = path
  }
}

for (const grep of ['auto', 'js'] as const) {
  describe(`diskFs conformance (grep: ${grep})`, () => {
    for (const c of fileSystemConformance(async () => diskFs(await temp(), { grep }), {
      requireStat: true,
      requireGrep: true,
      requireMove: true,
      requireGlob: true,
      requireBytes: true,
    })) {
      test(c.name, c.run)
    }
    afterAll(cleanup)
  })
}

describe('diskFs', () => {
  afterEach(cleanup)

  test('normalised paths and ".." are rejected', async () => {
    const root = await temp()
    const fs = diskFs(root)
    await fs.write('/a/./b//c.txt', 'x')
    expect(await readFile(join(root, 'a/b/c.txt'), 'utf8')).toBe('x')
    await expect(fs.read('/a/../../etc/passwd')).rejects.toThrow('path outside the workspace')
    await expect(fs.write('/../evil.txt', 'x')).rejects.toThrow('path outside the workspace')
    await expect(fs.read('relative.txt')).rejects.toThrow('path outside the workspace')
  })

  test('an absolute real path is just a virtual path below the root', async () => {
    const root = await temp()
    const other = await temp()
    await writeFile(join(other, 'secret.txt'), 'secret')
    expect(await diskFs(root).read(join(other, 'secret.txt'))).toBeNull()
  })

  test('writes create parent directories', async () => {
    const root = await temp()
    expect((await diskFs(root).write('/x/y/z/file.txt', 'deep')).ok).toBe(true)
    expect(await readFile(join(root, 'x/y/z/file.txt'), 'utf8')).toBe('deep')
  })

  test('symlinked file and directory pointing outside are refused or skipped', async () => {
    const root = await temp()
    const outside = await temp()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    await symlink(outside, join(root, 'linkdir'))
    await writeFile(join(root, 'ok.txt'), 'ok')
    const fs = diskFs(root)

    await expect(fs.read('/link.txt')).rejects.toThrow('path outside the workspace')
    await expect(fs.read('/linkdir/secret.txt')).rejects.toThrow('path outside the workspace')
    await expect(fs.write('/link.txt', 'pwn')).rejects.toThrow('path outside the workspace')
    await expect(fs.write('/linkdir/new.txt', 'pwn')).rejects.toThrow('path outside the workspace')
    await expect(fs.delete('/link.txt')).rejects.toThrow('path outside the workspace')
    await expect(fs.move?.('/ok.txt', '/linkdir/x.txt')).rejects.toThrow('path outside')
    await expect(fs.list('/linkdir/')).rejects.toThrow('path outside the workspace')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    expect((await fs.list()).map((m) => m.path)).toEqual(['/ok.txt'])
    expect((await fs.grep?.(/secret/))?.length).toBe(0)
    expect(await fs.glob?.('**/*.txt', { prefix: '/', limit: 10 })).toHaveLength(1)
  })

  test('a symlink to a file inside the root is readable and listed', async () => {
    const root = await temp()
    await writeFile(join(root, 'real.txt'), 'hello')
    await symlink(join(root, 'real.txt'), join(root, 'alias.txt'))
    const fs = diskFs(root)
    expect((await fs.read('/alias.txt'))?.content).toBe('hello')
    expect((await fs.list()).map((m) => m.path)).toEqual(['/alias.txt', '/real.txt'])
  })

  test('a symlink swapped in between a read and a write is caught', async () => {
    const root = await temp()
    const outside = await temp()
    await writeFile(join(outside, 'target.txt'), 'outside')
    await writeFile(join(root, 'file.txt'), 'one')
    const fs = diskFs(root)
    expect((await fs.read('/file.txt'))?.content).toBe('one')
    await rm(join(root, 'file.txt'))
    await symlink(join(outside, 'target.txt'), join(root, 'file.txt'))
    await expect(fs.write('/file.txt', 'two')).rejects.toThrow('path outside the workspace')
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside')
  })

  test('binary and oversized text files: read throws a readable error; binary files are listed', async () => {
    const root = await temp()
    await writeFile(join(root, 'bin.dat'), new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28]))
    await writeFile(join(root, 'big.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))
    await writeFile(join(root, 'small.txt'), 'ok')
    const fs = diskFs(root)
    await expect(fs.read('/bin.dat')).rejects.toThrow('binary file: /bin.dat')
    await expect(fs.read('/big.txt')).rejects.toThrow(
      'too large file: /big.txt (text files up to 2 MB only)',
    )
    expect((await fs.list()).map((m) => m.path)).toEqual(['/bin.dat', '/small.txt'])
    expect((await fs.stat?.('/bin.dat'))?.binary).toBe(true)
    expect((await fs.stat?.('/small.txt'))?.binary).toBeUndefined()
    expect(await fs.stat?.('/big.txt')).toBeNull()
  })

  test('maxFileBytes changes the limit and the message', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.txt'), 'a'.repeat(3000))
    const fs = diskFs(root, { maxFileBytes: 2048 })
    await expect(fs.read('/a.txt')).rejects.toThrow('text files up to 2 KB only')
    expect(await fs.list()).toEqual([])
  })

  test('read-only mode rejects write, delete and move', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.txt'), 'a')
    const fs = diskFs(root, { readonly: true })
    await expect(fs.write('/a.txt', 'b')).rejects.toThrow('read-only directory')
    await expect(fs.delete('/a.txt')).rejects.toThrow('read-only directory')
    await expect(fs.move?.('/a.txt', '/b.txt')).rejects.toThrow('read-only directory')
    expect((await fs.read('/a.txt'))?.content).toBe('a')
  })

  test('concurrent create-only writes: exactly one wins', async () => {
    const fs = diskFs(await temp())
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => fs.write('/race.txt', `v${i}`, { ifVersion: null })),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  test('mode is preserved by write (atomic temp + rename leaves no temp files)', async () => {
    const root = await temp()
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n')
    await chmod(join(root, 'run.sh'), 0o755)
    const fs = diskFs(root)
    expect((await fs.write('/run.sh', '#!/bin/sh\necho hi\n')).ok).toBe(true)
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect((await fs.list()).map((m) => m.path)).toEqual(['/run.sh'])
  })

  async function ignoreTree(): Promise<string> {
    const root = await temp()
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
    await mkdir(join(root, 'sub/node_modules'), { recursive: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n')
    await writeFile(join(root, '.git/config'), 'needle git')
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'needle nm')
    await writeFile(join(root, 'sub/node_modules/x.js'), 'needle nested nm')
    await writeFile(join(root, 'dist/out.js'), 'needle dist')
    await writeFile(join(root, 'debug.log'), 'needle log')
    await writeFile(join(root, 'src.ts'), 'needle src')
    return root
  }

  test('ignored paths are hidden from list, grep and glob but readable by path', async () => {
    const root = await ignoreTree()
    const fs = diskFs(root)
    expect((await fs.list()).map((m) => m.path)).toEqual(['/.gitignore', '/src.ts'])
    expect((await fs.grep?.(/needle/))?.map((h) => h.path)).toEqual(['/src.ts'])
    expect((await fs.glob?.('**/*', { prefix: '/', limit: 10 }))?.map((m) => m.path)).toEqual([
      '/src.ts',
    ])
    expect((await fs.read('/dist/out.js'))?.content).toBe('needle dist')
    expect((await fs.read('/node_modules/pkg/index.js'))?.content).toBe('needle nm')
    expect((await fs.read('/.git/config'))?.content).toBe('needle git')
    expect((await fs.read('/debug.log'))?.content).toBe('needle log')
  })

  test('ignore options: gitignore false and extra hidden patterns', async () => {
    const root = await ignoreTree()
    const all = diskFs(root, { ignore: { gitignore: false } })
    expect((await all.list()).map((m) => m.path)).toEqual([
      '/.gitignore',
      '/debug.log',
      '/dist/out.js',
      '/src.ts',
    ])
    const extra = diskFs(root, { ignore: { hidden: ['src.ts'] } })
    expect((await extra.list()).map((m) => m.path)).toEqual(['/.gitignore'])
    expect(await extra.grep?.(/needle/)).toEqual([])
  })

  test('grep without rg (JS fallback) and grep: "js"', async () => {
    const root = await ignoreTree()
    await writeFile(join(root, 'multi.txt'), 'one\nNeedle two\nthree needle\r\n')
    const expected = [
      { path: '/multi.txt', line: 2, text: 'Needle two' },
      { path: '/multi.txt', line: 3, text: 'three needle' },
      { path: '/src.ts', line: 1, text: 'needle src' },
    ]
    const fs = diskFs(root)
    await withoutRg(async () => {
      expect(await fs.grep?.(/needle/i)).toEqual(expected)
      expect((await fs.grep?.(/needle/, { maxHits: 1 }))?.length).toBe(1)
      expect((await fs.grep?.(/needle/i, { prefix: '/multi' }))?.length).toBe(2)
    })
    expect(await diskFs(root, { grep: 'js' }).grep?.(/needle/i)).toEqual(expected)
  })

  test.skipIf(!rgOnPath())('grep with rg matches the JS implementation', async () => {
    const root = await ignoreTree()
    await writeFile(join(root, 'multi.txt'), 'one\nNeedle two\nthree needle\n')
    const withRg = await diskFs(root).grep?.(/needle/i)
    const js = await diskFs(root, { grep: 'js' }).grep?.(/needle/i)
    expect(withRg).toEqual(js)
    expect(withRg?.map((h) => h.path)).toEqual(['/multi.txt', '/multi.txt', '/src.ts'])
  })
})

describe.skipIf(process.platform === 'win32')('diskFs grep through an rg-compatible binary', () => {
  afterEach(cleanup)

  /** A fake `rg` that answers like `rg --json` and records its arguments. */
  async function fakeRg(exitCode: number): Promise<{ bin: string; args: string }> {
    const bin = await temp()
    const args = join(bin, 'args.txt')
    const script = `#!/bin/sh
printf '%s\\n' "$@" > "${args}"
for last; do :; done
printf '{"type":"match","data":{"path":{"text":"%s/src.ts"},"lines":{"text":"needle src\\\\n"},"line_number":1}}\\n' "$last"
printf '{"type":"match","data":{"path":{"text":"%s/dist/out.js"},"lines":{"text":"needle dist\\\\n"},"line_number":4}}\\n' "$last"
exit ${exitCode}
`
    await writeFile(join(bin, 'rg'), script)
    await chmod(join(bin, 'rg'), 0o755)
    return { bin, args }
  }

  test('hits are parsed, ignored files dropped, flags passed; auto uses it, js does not', async () => {
    const root = await temp()
    await writeFile(join(root, '.gitignore'), 'dist/\n')
    await writeFile(join(root, 'src.ts'), 'needle src')
    const { bin, args } = await fakeRg(0)
    const path = process.env.PATH
    process.env.PATH = bin
    try {
      const hits = await diskFs(root).grep?.(/needle/i)
      expect(hits).toEqual([{ path: '/src.ts', line: 1, text: 'needle src' }])
      const seen = (await readFile(args, 'utf8')).split('\n')
      expect(seen).toContain('--ignore-case')
      expect(seen).toContain('--no-ignore')
      expect(seen).toContain(String(2 * 1024 * 1024))
      await rm(args)
      await diskFs(root, { grep: 'js' }).grep?.(/needle/i)
      await expect(readFile(args, 'utf8')).rejects.toThrow()
    } finally {
      process.env.PATH = path
    }
  })

  test('an rg failure (exit 2) falls back to the JS implementation', async () => {
    const root = await temp()
    await writeFile(join(root, 'real.ts'), 'needle real')
    const { bin } = await fakeRg(2)
    const path = process.env.PATH
    process.env.PATH = bin
    try {
      expect(await diskFs(root).grep?.(/needle/)).toEqual([
        { path: '/real.ts', line: 1, text: 'needle real' },
      ])
    } finally {
      process.env.PATH = path
    }
  })
})
