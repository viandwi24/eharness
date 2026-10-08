/** `diskFs`: conformance, containment, binary/large files, ignore rules and grep. */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSystemConformance } from 'eharness/testing'
import { diskFs } from '../src/workspace/disk-fs.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coder-diskfs-')))
  dirs.push(dir)
  return dir
}
async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
}

describe('diskFs conformance', () => {
  for (const c of fileSystemConformance(async () => diskFs(await temp()), {
    requireStat: true,
    requireGrep: true,
    requireMove: true,
  })) {
    test(c.name, c.run)
  }
  afterAll(cleanup)
})

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
    const fs = diskFs(root)
    expect(await fs.read(join(other, 'secret.txt'))).toBeNull()
  })

  test('writes create parent directories', async () => {
    const root = await temp()
    const fs = diskFs(root)
    expect((await fs.write('/x/y/z/file.txt', 'deep')).ok).toBe(true)
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
    await expect(fs.list('/linkdir/')).rejects.toThrow('path outside the workspace')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    expect((await fs.list()).map((m) => m.path)).toEqual(['/ok.txt'])
    expect((await fs.grep?.(/secret/))?.length).toBe(0)
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

  test('binary and >2 MB files: read throws, list skips', async () => {
    const root = await temp()
    await writeFile(join(root, 'bin.dat'), new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28]))
    await writeFile(join(root, 'big.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))
    await writeFile(join(root, 'small.txt'), 'ok')
    const fs = diskFs(root)
    await expect(fs.read('/bin.dat')).rejects.toThrow('binary or too large file')
    await expect(fs.read('/big.txt')).rejects.toThrow('binary or too large file')
    expect((await fs.list()).map((m) => m.path)).toEqual(['/small.txt'])
    expect(await fs.stat?.('/bin.dat')).toBeNull()
    expect(await fs.stat?.('/big.txt')).toBeNull()
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

  test('ignored paths are hidden from list and grep but readable by path', async () => {
    const root = await ignoreTree()
    const fs = diskFs(root)
    expect((await fs.list()).map((m) => m.path)).toEqual(['/.gitignore', '/src.ts'])
    expect((await fs.grep?.(/needle/))?.map((h) => h.path)).toEqual(['/src.ts'])
    expect((await fs.read('/dist/out.js'))?.content).toBe('needle dist')
    expect((await fs.read('/node_modules/pkg/index.js'))?.content).toBe('needle nm')
    expect((await fs.read('/.git/config'))?.content).toBe('needle git')
    expect((await fs.read('/debug.log'))?.content).toBe('needle log')
  })

  test('grep falls back to the JS implementation without rg', async () => {
    const root = await ignoreTree()
    await writeFile(join(root, 'multi.txt'), 'one\nNeedle two\nthree needle\r\n')
    const fs = diskFs(root)
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      expect(Bun.which('rg')).toBeNull()
      const hits = await fs.grep?.(/needle/i)
      expect(hits).toEqual([
        { path: '/multi.txt', line: 2, text: 'Needle two' },
        { path: '/multi.txt', line: 3, text: 'three needle' },
        { path: '/src.ts', line: 1, text: 'needle src' },
      ])
      expect((await fs.grep?.(/needle/, { maxHits: 1 }))?.length).toBe(1)
      expect((await fs.grep?.(/needle/i, { prefix: '/multi' }))?.length).toBe(2)
    } finally {
      process.env.PATH = path
    }
  })

  test.skipIf(!Bun.which('rg'))('grep with rg matches the fallback', async () => {
    const root = await ignoreTree()
    await writeFile(join(root, 'multi.txt'), 'one\nNeedle two\nthree needle\n')
    const fs = diskFs(root)
    const withRg = await fs.grep?.(/needle/i)
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    let without: typeof withRg
    try {
      without = await fs.grep?.(/needle/i)
    } finally {
      process.env.PATH = path
    }
    expect(withRg).toEqual(without)
    expect(withRg?.map((h) => h.path)).toEqual(['/multi.txt', '/multi.txt', '/src.ts'])
  })
})
