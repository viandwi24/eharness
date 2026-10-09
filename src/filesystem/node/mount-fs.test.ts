/** `mountFs` routing and `nodeWorkspace`. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryFs } from '../memory.ts'
import { diskFs } from './disk-fs.ts'
import { type FsMount, mountFs } from './mount-fs.ts'
import { nodeWorkspace } from './workspace.ts'

const dirs: string[] = []
async function temp(name = 'd'): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'eh-mount-')))
  dirs.push(base)
  const dir = join(base, name)
  await mkdir(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('mountFs', () => {
  test('longest prefix wins; listing is merged, sorted and not duplicated', async () => {
    const root = await temp('root')
    const lib = await temp('lib')
    await mkdir(join(root, '@dirs/lib'), { recursive: true })
    await writeFile(join(root, 'b.txt'), 'root b')
    await writeFile(join(root, 'a.txt'), 'root a')
    await writeFile(join(root, '@dirs/lib/shadow.txt'), 'shadowed by root')
    await writeFile(join(lib, 'x.txt'), 'lib x')
    const mounts: FsMount[] = [
      { virtual: '/', fs: diskFs(root) },
      { virtual: '/@dirs/lib/', fs: diskFs(lib) },
    ]
    const fs = mountFs(() => mounts)
    expect((await fs.read('/@dirs/lib/x.txt'))?.content).toBe('lib x')
    expect((await fs.read('/@dirs/lib/x.txt'))?.path).toBe('/@dirs/lib/x.txt')
    expect(await fs.read('/@dirs/lib/shadow.txt')).toBeNull()
    expect((await fs.list()).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt', '/a.txt', '/b.txt'])
    expect((await fs.list('/@dirs/lib/')).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt'])
    expect((await fs.list('/@dirs/')).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt'])
    expect((await fs.stat?.('/@dirs/lib/x.txt'))?.path).toBe('/@dirs/lib/x.txt')
    const hits = await fs.grep?.(/lib|root/)
    expect(hits?.map((h) => h.path)).toEqual(['/@dirs/lib/x.txt', '/a.txt', '/b.txt'])
    expect((await fs.grep?.(/lib|root/, { maxHits: 2 }))?.length).toBe(2)
    expect((await fs.glob?.('*.txt', { prefix: '/', limit: 10 }))?.map((m) => m.path)).toEqual([
      '/a.txt',
      '/b.txt',
    ])
    expect(await fs.write('/@dirs/lib/new.txt', 'n')).toMatchObject({ ok: true })
    expect(await readFile(join(lib, 'new.txt'), 'utf8')).toBe('n')
  })

  test('mounts added at runtime are visible; unmounted paths throw; any FileSystem mounts', async () => {
    const mem = memoryFs({ '/e.txt': 'e' })
    const mounts: FsMount[] = [{ virtual: '/@dirs/root/', fs: memoryFs() }]
    const fs = mountFs(() => mounts)
    await expect(fs.read('/nowhere.txt')).rejects.toThrow('path outside the workspace')
    mounts.push({ virtual: '/@dirs/extra/', fs: mem })
    expect((await fs.read('/@dirs/extra/e.txt'))?.content).toBe('e')
    expect((await fs.stat?.('/@dirs/extra/e.txt'))?.path).toBe('/@dirs/extra/e.txt')
  })

  test('invalid virtual prefixes throw', async () => {
    const fs = mountFs(() => [{ virtual: '/x', fs: memoryFs() }])
    await expect(fs.read('/x/a')).rejects.toThrow(TypeError)
  })

  test('move across mounts copies then deletes; same mount uses rename', async () => {
    const root = await temp('root')
    const lib = await temp('lib')
    await writeFile(join(root, 'a.txt'), 'A')
    const fs = mountFs(() => [
      { virtual: '/', fs: diskFs(root) },
      { virtual: '/@dirs/lib/', fs: diskFs(lib) },
    ])
    expect(await fs.move?.('/a.txt', '/@dirs/lib/a.txt')).toEqual({ ok: true })
    expect(await readFile(join(lib, 'a.txt'), 'utf8')).toBe('A')
    expect(await fs.read('/a.txt')).toBeNull()
    expect(await fs.move?.('/@dirs/lib/a.txt', '/@dirs/lib/b.txt')).toEqual({ ok: true })
    expect(await fs.move?.('/missing.txt', '/c.txt')).toEqual({ ok: false, reason: 'missing' })
    await writeFile(join(root, 'again.txt'), 'x')
    await writeFile(join(lib, 'again.txt'), 'y')
    expect(await fs.move?.('/again.txt', '/@dirs/lib/again.txt')).toEqual({
      ok: false,
      reason: 'exists',
    })
    expect(await readFile(join(root, 'again.txt'), 'utf8')).toBe('x')
  })

  test('a readonly mount refuses writes, deletes and moves into it', async () => {
    const root = await temp('root')
    await writeFile(join(root, 'a.txt'), 'a')
    const fs = mountFs(() => [{ virtual: '/', fs: diskFs(root), readonly: true }])
    await expect(fs.write('/a.txt', 'x')).rejects.toThrow('read-only directory')
    await expect(fs.delete('/a.txt')).rejects.toThrow('read-only directory')
    await expect(fs.move?.('/a.txt', '/b.txt')).rejects.toThrow('read-only directory')
    expect((await fs.read('/a.txt'))?.content).toBe('a')
  })
})

describe('nodeWorkspace', () => {
  test('mounts root, extra dirs and tool outputs', async () => {
    const root = await temp('project')
    const lib = await temp('lib')
    const data = await temp('data')
    const ws = await nodeWorkspace({
      root,
      extraDirs: [lib],
      toolOutputsDir: join(data, 'tool-outputs'),
    })
    expect(ws.root).toBe(root)
    expect(ws.mounts()).toEqual([
      { virtual: '/', real: root, readonly: false },
      { virtual: '/@dirs/lib/', real: lib, readonly: false },
      { virtual: '/.eharness/tool-outputs/', real: join(data, 'tool-outputs'), readonly: false },
    ])
    await ws.fs.write('/.eharness/tool-outputs/out.txt', 'big')
    expect(await readFile(join(data, 'tool-outputs/out.txt'), 'utf8')).toBe('big')
  })

  test('no toolOutputsDir: no such mount', async () => {
    const ws = await nodeWorkspace({ root: await temp('project') })
    expect(ws.mounts()).toHaveLength(1)
  })

  test('toReal and toVirtual', async () => {
    const root = await temp('project')
    const lib = await temp('lib')
    const outside = await temp('outside')
    await symlink(outside, join(root, 'escape'))
    const ws = await nodeWorkspace({ root, extraDirs: [lib] })
    expect(await ws.toReal('/src/a.ts')).toBe(join(root, 'src/a.ts'))
    expect(await ws.toReal('/@dirs/lib/x.ts')).toBe(join(lib, 'x.ts'))
    expect(await ws.toReal('/escape/x.ts')).toBeNull()
    expect(await ws.toReal('/a/../b')).toBeNull()
    expect(await ws.toReal('relative')).toBeNull()
    expect(ws.toVirtual(join(root, 'src/a.ts'))).toBe('/src/a.ts')
    expect(ws.toVirtual(join(lib, 'x.ts'))).toBe('/@dirs/lib/x.ts')
    expect(ws.toVirtual(lib)).toBe('/@dirs/lib/')
    expect(ws.toVirtual(outside)).toBeNull()
  })

  test('addDirectory is idempotent, names are unique, files become visible', async () => {
    const root = await temp('project')
    const a = await temp('lib')
    const b = await temp('lib')
    await writeFile(join(b, 'x.txt'), 'x')
    const ws = await nodeWorkspace({ root })
    expect(await ws.addDirectory(a)).toBe('/@dirs/lib/')
    expect(await ws.addDirectory(a)).toBe('/@dirs/lib/')
    expect(await ws.addDirectory(b)).toBe('/@dirs/lib-2/')
    expect((await ws.fs.read('/@dirs/lib-2/x.txt'))?.content).toBe('x')
    await writeFile(join(root, 'file.txt'), 'f')
    await expect(ws.addDirectory(join(root, 'file.txt'))).rejects.toThrow('not a directory')
  })

  test('diskFs options apply to every mount', async () => {
    const root = await temp('project')
    await writeFile(join(root, 'a.txt'), 'a')
    const ws = await nodeWorkspace({ root, diskFs: { readonly: true } })
    await expect(ws.fs.write('/a.txt', 'b')).rejects.toThrow('read-only directory')
  })
})
