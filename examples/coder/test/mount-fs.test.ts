/** `mountFs` routing and `createWorkspace` mounts. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoderConfig, Mount } from '../src/contracts.ts'
import { createWorkspace, mountFs } from '../src/workspace/index.ts'

const dirs: string[] = []
async function temp(name = 'd'): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'coder-mount-')))
  dirs.push(base)
  const dir = join(base, name)
  await mkdir(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const config = (root: string, data: string, extra: string[] = []): CoderConfig =>
  ({ root, projectDataDir: data, additionalDirectories: extra }) as unknown as CoderConfig

describe('mountFs', () => {
  test('longest prefix wins; listing is merged, sorted and not duplicated', async () => {
    const root = await temp('root')
    const lib = await temp('lib')
    await mkdir(join(root, '@dirs/lib'), { recursive: true })
    await writeFile(join(root, 'b.txt'), 'root b')
    await writeFile(join(root, 'a.txt'), 'root a')
    await writeFile(join(root, '@dirs/lib/shadow.txt'), 'shadowed by root')
    await writeFile(join(lib, 'x.txt'), 'lib x')
    const mounts: Mount[] = [
      { virtual: '/', real: root, readonly: false },
      { virtual: '/@dirs/lib/', real: lib, readonly: false },
    ]
    const fs = mountFs(() => mounts)
    expect((await fs.read('/@dirs/lib/x.txt'))?.content).toBe('lib x')
    expect((await fs.read('/@dirs/lib/x.txt'))?.path).toBe('/@dirs/lib/x.txt')
    expect((await fs.read('/@dirs/lib/shadow.txt'))?.content ?? null).toBeNull()
    expect((await fs.list()).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt', '/a.txt', '/b.txt'])
    expect((await fs.list('/@dirs/lib/')).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt'])
    expect((await fs.list('/@dirs/')).map((m) => m.path)).toEqual(['/@dirs/lib/x.txt'])
    expect((await fs.stat?.('/@dirs/lib/x.txt'))?.path).toBe('/@dirs/lib/x.txt')
    const hits = await fs.grep?.(/lib|root/)
    expect(hits?.map((h) => h.path)).toEqual(['/@dirs/lib/x.txt', '/a.txt', '/b.txt'])
    expect(await fs.write('/@dirs/lib/new.txt', 'n')).toMatchObject({ ok: true })
    expect(await readFile(join(lib, 'new.txt'), 'utf8')).toBe('n')
  })

  test('mounts added at runtime are visible immediately; unmounted paths throw', async () => {
    const root = await temp('root')
    const extra = await temp('extra')
    await writeFile(join(extra, 'e.txt'), 'e')
    const mounts: Mount[] = [{ virtual: '/@dirs/root/', real: root, readonly: false }]
    const fs = mountFs(() => mounts)
    await expect(fs.read('/nowhere.txt')).rejects.toThrow('path outside the workspace')
    mounts.push({ virtual: '/@dirs/extra/', real: extra, readonly: false })
    expect((await fs.read('/@dirs/extra/e.txt'))?.content).toBe('e')
  })

  test('move across mounts copies then deletes; same mount uses rename', async () => {
    const root = await temp('root')
    const lib = await temp('lib')
    await writeFile(join(root, 'a.txt'), 'A')
    const fs = mountFs(() => [
      { virtual: '/', real: root, readonly: false },
      { virtual: '/@dirs/lib/', real: lib, readonly: false },
    ])
    expect(await fs.move?.('/a.txt', '/@dirs/lib/a.txt')).toEqual({ ok: true })
    expect(await readFile(join(lib, 'a.txt'), 'utf8')).toBe('A')
    expect((await fs.read('/a.txt')) ?? null).toBeNull()
    expect(await fs.move?.('/@dirs/lib/a.txt', '/@dirs/lib/b.txt')).toEqual({ ok: true })
    expect(await fs.move?.('/missing.txt', '/c.txt')).toEqual({ ok: false, reason: 'missing' })
  })

  test('a readonly mount refuses writes', async () => {
    const root = await temp('root')
    const fs = mountFs(() => [{ virtual: '/', real: root, readonly: true }])
    await expect(fs.write('/a.txt', 'x')).rejects.toThrow('read-only directory')
  })
})

describe('createWorkspace', () => {
  test('mounts root, additional dirs and tool-outputs', async () => {
    const root = await temp('project')
    const lib = await temp('lib')
    const data = await temp('data')
    const ws = await createWorkspace(config(root, data, [lib]))
    expect(ws.root).toBe(root)
    expect(ws.mounts()).toEqual([
      { virtual: '/', real: root, readonly: false },
      { virtual: '/@dirs/lib/', real: lib, readonly: false },
      { virtual: '/.coder/tool-outputs/', real: join(data, 'tool-outputs'), readonly: false },
    ])
    await ws.fs.write('/.coder/tool-outputs/out.txt', 'big')
    expect(await readFile(join(data, 'tool-outputs/out.txt'), 'utf8')).toBe('big')
  })

  test('toReal and toVirtual', async () => {
    const root = await temp('project')
    const lib = await temp('lib')
    const data = await temp('data')
    const ws = await createWorkspace(config(root, data, [lib]))
    expect(await ws.toReal('/src/a.ts')).toBe(join(root, 'src/a.ts'))
    expect(await ws.toReal('/')).toBe(root)
    expect(await ws.toReal('/@dirs/lib')).toBe(lib)
    expect(await ws.toReal('/@dirs/lib/x.txt')).toBe(join(lib, 'x.txt'))
    expect(await ws.toReal('/a/../b')).toBeNull()
    expect(await ws.toReal('relative')).toBeNull()
    expect(ws.toVirtual(join(root, 'src/a.ts'))).toBe('/src/a.ts')
    expect(ws.toVirtual(root)).toBe('/')
    expect(ws.toVirtual(lib)).toBe('/@dirs/lib/')
    expect(ws.toVirtual(join(lib, 'x/y.txt'))).toBe('/@dirs/lib/x/y.txt')
    expect(ws.toVirtual('/definitely/elsewhere')).toBeNull()
  })

  test('addDirectory is idempotent and dedupes names with -2', async () => {
    const root = await temp('project')
    const data = await temp('data')
    const a = await temp('shared')
    const b = await temp('shared')
    const ws = await createWorkspace(config(root, data))
    expect(await ws.addDirectory(a)).toBe('/@dirs/shared/')
    expect(await ws.addDirectory(a)).toBe('/@dirs/shared/')
    expect(await ws.addDirectory(b)).toBe('/@dirs/shared-2/')
    await expect(ws.addDirectory(join(a, 'missing'))).rejects.toThrow()
    await writeFile(join(a, 'f.txt'), 'f')
    await expect(ws.addDirectory(join(a, 'f.txt'))).rejects.toThrow('not a directory')
    expect((await ws.fs.read('/@dirs/shared-2/f.txt')) ?? null).toBeNull()
    expect((await ws.fs.read('/@dirs/shared/f.txt'))?.content).toBe('f')
  })
})
