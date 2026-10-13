import { describe, expect, test } from 'bun:test'
import { inMemoryFs } from '../filesystem/memory.ts'
import { type FilePolicyLike, type SyncedSandbox, syncedSandbox } from './sync.ts'
import { fakeSandbox, text, wrapRun } from './test-kit.ts'

const enc = new TextEncoder()

function setup(
  seed: Record<string, string | Uint8Array>,
  extra: Partial<Parameters<typeof syncedSandbox>[0]> = {},
) {
  const fs = inMemoryFs({ seed })
  const sandbox = fakeSandbox()
  const bridge = syncedSandbox({
    fs,
    sandbox,
    mounts: [{ virtual: '/work/' }],
    ...extra,
  })
  return { fs, sandbox, bridge }
}

async function cycle(bridge: SyncedSandbox, ok = true) {
  const into = await bridge.syncIn()
  const out = await bridge.syncOut(ok)
  return { into, out }
}

describe('sync-in', () => {
  test('copies the mounted files; the second run uploads nothing', async () => {
    const { sandbox, bridge } = setup({
      '/work/a.csv': 'x,y\n1,2\n',
      '/work/sub/b.txt': 'b',
      '/other/c.txt': 'c',
    })
    const first = await bridge.syncIn()
    expect(first.full).toBe(true)
    expect(first.uploaded).toEqual(['/work/a.csv', '/work/sub/b.txt'])
    expect(text(sandbox, 'work/a.csv')).toBe('x,y\n1,2\n')
    expect(sandbox.files.has('other/c.txt')).toBe(false)
    expect(text(sandbox, '.eh-code/list.py')).toContain('hashlib')
    sandbox.uploads.length = 0
    const second = await bridge.syncIn()
    expect(second.uploaded).toEqual([])
    expect(second.full).toBe(false)
    expect(sandbox.uploads).toEqual([])
  })

  test('a changed file is uploaded again, a deleted one removed', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': '1', '/work/b.txt': '2' })
    await bridge.syncIn()
    await fs.write('/work/a.txt', 'one')
    await fs.delete('/work/b.txt')
    const r = await bridge.syncIn()
    expect(r.uploaded).toEqual(['/work/a.txt'])
    expect(r.removed).toEqual(['/work/b.txt'])
    expect(text(sandbox, 'work/a.txt')).toBe('one')
    expect(sandbox.files.has('work/b.txt')).toBe(false)
  })

  test('hidden paths, refused reads and the reserved directory are never copied', async () => {
    const policy: FilePolicyLike = {
      isHidden: (p) => p.startsWith('/work/secret/'),
      isReadonly: () => false,
      extensionAllowed: () => true,
      isUndeletable: () => false,
    }
    const { sandbox, bridge } = setup(
      {
        '/work/ok.txt': 'ok',
        '/work/secret/k.txt': 'k',
        '/work/no.txt': 'n',
        '/work/.eh-code/x': 'x',
      },
      { policy, access: (p) => p !== '/work/no.txt' },
    )
    const r = await bridge.syncIn()
    expect(r.uploaded).toEqual(['/work/.eh-code/x', '/work/ok.txt'].sort())
    expect(sandbox.files.has('work/secret/k.txt')).toBe(false)
    expect(sandbox.files.has('work/no.txt')).toBe(false)
  })

  test('caps are reported, never silent', async () => {
    const { sandbox, bridge } = setup(
      { '/work/a': 'aaaa', '/work/b': 'bbbb', '/work/c': 'cccc', '/work/big': 'x'.repeat(100) },
      { limits: { maxFileBytes: 50, maxSyncFiles: 2 } },
    )
    const r = await bridge.syncIn()
    expect(r.uploaded).toEqual(['/work/a', '/work/b'])
    expect(r.notCopied).toEqual([
      { path: '/work/big', reason: 'larger than 1 MB' },
      { path: '/work/c', reason: 'too many files (limit 2)' },
    ])
    expect(sandbox.files.has('work/c')).toBe(false)
  })

  test('binary files go through readBytes + writeBinaryFile', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 254])
    const { sandbox, bridge } = setup({ '/work/p.png': png })
    await bridge.syncIn()
    expect(sandbox.files.get('work/p.png')).toEqual(png)
  })

  test('a wiped sandbox (marker gone) gets a full sync-in again', async () => {
    const { sandbox, bridge } = setup({ '/work/a.txt': 'a', '/work/b.txt': 'b' })
    await bridge.syncIn()
    sandbox.wipe()
    sandbox.uploads.length = 0
    const r = await bridge.syncIn()
    expect(r.full).toBe(true)
    expect(r.uploaded).toEqual(['/work/a.txt', '/work/b.txt'])
    expect(text(sandbox, 'work/a.txt')).toBe('a')
  })
})

describe('sync-out', () => {
  test('new, changed and deleted files are written back; the next sync-in uploads nothing', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': 'a', '/work/b.txt': 'b' })
    await bridge.syncIn()
    sandbox.files.set('work/a.txt', enc.encode('A'))
    sandbox.files.delete('work/b.txt')
    sandbox.files.set('work/new.md', enc.encode('# new'))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/a.txt', '/work/new.md'])
    expect(out.deleted).toEqual(['/work/b.txt'])
    expect((await fs.read('/work/a.txt'))?.content).toBe('A')
    expect((await fs.read('/work/new.md'))?.content).toBe('# new')
    expect(await fs.read('/work/b.txt')).toBeNull()
    sandbox.uploads.length = 0
    expect((await bridge.syncIn()).uploaded).toEqual([])
    expect(sandbox.uploads).toEqual([])
  })

  test('unchanged files are not rewritten', async () => {
    const { fs, bridge } = setup({ '/work/a.txt': 'a' })
    const before = (await fs.list('/work/'))[0]?.version
    const { out } = await cycle(bridge)
    expect(out.saved).toEqual([])
    expect((await fs.list('/work/'))[0]?.version).toBe(before)
  })

  test('CONFLICT: a file changed in the file system during the run is kept; the next sync-in restores it', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': 'a' })
    await bridge.syncIn()
    sandbox.files.set('work/a.txt', enc.encode('from sandbox'))
    await fs.write('/work/a.txt', 'from elsewhere')
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual([])
    expect(out.notSaved).toEqual([
      { path: '/work/a.txt', reason: 'changed in the file system while the code ran' },
    ])
    expect((await fs.read('/work/a.txt'))?.content).toBe('from elsewhere')
    await bridge.syncIn()
    expect(text(sandbox, 'work/a.txt')).toBe('from elsewhere')
  })

  test('a new file whose path appeared in the file system meanwhile is not overwritten', async () => {
    const { fs, sandbox, bridge } = setup({})
    await bridge.syncIn()
    sandbox.files.set('work/n.txt', enc.encode('sandbox'))
    await fs.write('/work/n.txt', 'other')
    const out = await bridge.syncOut(true)
    expect(out.notSaved.map((n) => n.path)).toEqual(['/work/n.txt'])
    expect((await fs.read('/work/n.txt'))?.content).toBe('other')
  })

  test('a failed run saves nothing; changed files come back, new ones are removed', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': 'a' })
    await bridge.syncIn()
    sandbox.files.set('work/a.txt', enc.encode('broken'))
    sandbox.files.set('work/partial.txt', enc.encode('p'))
    const out = await bridge.syncOut(false)
    expect(out).toEqual({ saved: [], deleted: [], notSaved: [], failedRun: 2 })
    expect((await fs.read('/work/a.txt'))?.content).toBe('a')
    expect(await fs.read('/work/partial.txt')).toBeNull()
    expect(sandbox.files.has('work/partial.txt')).toBe(false)
    await bridge.syncIn()
    expect(text(sandbox, 'work/a.txt')).toBe('a')
  })

  test('read-only mounts, policy, access and extensions decide per path', async () => {
    const policy: FilePolicyLike = {
      isHidden: () => false,
      isReadonly: (p) => p === '/work/ro.txt',
      extensionAllowed: (p) => !p.endsWith('.exe'),
      isUndeletable: (p) => p === '/work/keep.txt',
    }
    const fs = inMemoryFs({
      seed: { '/work/ro.txt': 'r', '/work/keep.txt': 'k', '/data/d.csv': 'd', '/work/x.txt': 'x' },
    })
    const sandbox = fakeSandbox()
    const bridge = syncedSandbox({
      fs,
      sandbox,
      mounts: [{ virtual: '/work/' }, { virtual: '/data/', readonly: true }],
      policy,
      access: (p, op) => !(p === '/work/x.txt' && op === 'write'),
    })
    await bridge.syncIn()
    sandbox.files.set('work/ro.txt', enc.encode('changed'))
    sandbox.files.delete('work/keep.txt')
    sandbox.files.set('data/d.csv', enc.encode('changed'))
    sandbox.files.set('data/new.csv', enc.encode('new'))
    sandbox.files.set('work/x.txt', enc.encode('changed'))
    sandbox.files.set('work/tool.exe', enc.encode('bin'))
    sandbox.files.set('work/ok.txt', enc.encode('ok'))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/ok.txt'])
    expect(Object.fromEntries(out.notSaved.map((n) => [n.path, n.reason]))).toEqual({
      '/data/d.csv': 'read-only',
      '/data/new.csv': 'read-only',
      '/work/keep.txt': 'cannot be deleted',
      '/work/ro.txt': 'read-only',
      '/work/tool.exe': 'extension not allowed',
      '/work/x.txt': 'not allowed',
    })
    expect((await fs.read('/work/ro.txt'))?.content).toBe('r')
    expect((await fs.read('/work/keep.txt'))?.content).toBe('k')
    // a refused change is undone by the next sync-in
    await bridge.syncIn()
    expect(text(sandbox, 'work/ro.txt')).toBe('r')
    expect(text(sandbox, 'work/keep.txt')).toBe('k')
  })

  test('binary outputs are written with writeBytes; text bytes as text', async () => {
    const { fs, sandbox, bridge } = setup({})
    await bridge.syncIn()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
    sandbox.files.set('work/chart.png', png)
    sandbox.files.set('work/r.md', enc.encode('hello'))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/chart.png', '/work/r.md'])
    expect((await fs.readBytes?.('/work/chart.png'))?.bytes).toEqual(png)
    expect((await fs.read('/work/r.md'))?.content).toBe('hello')
  })

  test('a file system without writeBytes reports binary outputs as not saved', async () => {
    const inner = inMemoryFs()
    const fs = {
      read: inner.read.bind(inner),
      write: inner.write.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    }
    const sandbox = fakeSandbox()
    const bridge = syncedSandbox({ fs, sandbox, mounts: [{ virtual: '/work/' }] })
    await bridge.syncIn()
    sandbox.files.set('work/b.bin', new Uint8Array([0, 1, 2, 255]))
    const out = await bridge.syncOut(true)
    expect(out.notSaved).toEqual([
      { path: '/work/b.bin', reason: 'binary files are not supported by this file system' },
    ])
  })

  test('odd names are skipped and listed; ignored paths never come back', async () => {
    const { fs, sandbox, bridge } = setup({})
    await bridge.syncIn()
    sandbox.files.set('work/two\nlines.txt', enc.encode('x'))
    sandbox.files.set('work/__pycache__/m.pyc', enc.encode('x'))
    sandbox.files.set('work/sub/.ipynb_checkpoints/n.json', enc.encode('{}'))
    sandbox.files.set('work/good.txt', enc.encode('g'))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/good.txt'])
    expect(out.notSaved).toEqual([
      { path: '/work/two\nlines.txt', reason: 'file name not supported' },
    ])
    expect(await fs.read('/work/__pycache__/m.pyc')).toBeNull()
  })

  test('maxWriteBackFiles caps the writes', async () => {
    const { sandbox, bridge } = setup({}, { limits: { maxWriteBackFiles: 2 } })
    await bridge.syncIn()
    for (const n of ['a', 'b', 'c']) sandbox.files.set(`work/${n}`, enc.encode(n))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/a', '/work/b'])
    expect(out.notSaved).toEqual([{ path: '/work/c', reason: 'too many files changed (limit 2)' }])
  })

  test('the driver fast path listFiles is used when present', async () => {
    const fs = inMemoryFs({ seed: { '/work/a.txt': 'a' } })
    const sandbox = fakeSandbox()
    const calls: string[] = []
    sandbox.listFiles = async (dir) => {
      calls.push(dir)
      return [...sandbox.files]
        .filter(([p]) => p.startsWith(`${dir}/`))
        .map(([path, b]) => ({
          path,
          size: b.length,
          sha1: `sha-${b.length}-${new TextDecoder().decode(b)}`,
        }))
    }
    const bridge = syncedSandbox({ fs, sandbox, mounts: [{ virtual: '/work/' }] })
    await bridge.syncIn()
    sandbox.files.set('work/n.txt', enc.encode('n'))
    const out = await bridge.syncOut(true)
    expect(calls).toContain('work')
    expect(out.saved).toEqual(['/work/n.txt'])
    expect(sandbox.commands.some((c) => c.includes('list.py'))).toBe(false)
  })

  test('mount "/" syncs the whole tree and keeps .eh-code out', async () => {
    const fs = inMemoryFs({ seed: { '/a.txt': 'a', '/d/b.txt': 'b' } })
    const sandbox = fakeSandbox()
    const bridge = syncedSandbox({ fs, sandbox, mounts: [{ virtual: '/' }] })
    await bridge.syncIn()
    sandbox.files.set('c.txt', enc.encode('c'))
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/c.txt'])
  })
})

test('exclusive sections run one at a time', async () => {
  const { bridge } = setup({})
  const order: string[] = []
  const slow = bridge.exclusive(async () => {
    order.push('a-start')
    await new Promise((r) => setTimeout(r, 20))
    order.push('a-end')
  })
  const fast = bridge.exclusive(async () => {
    order.push('b')
  })
  await Promise.all([slow, fast])
  expect(order).toEqual(['a-start', 'a-end', 'b'])
})

describe('hardening (review findings)', () => {
  test('sync-in removes symlinks under the mount dirs before uploading', async () => {
    const { sandbox, bridge } = setup({ '/work/a.txt': '1' }, { mounts: [{ virtual: '/work/' }] })
    await bridge.syncIn()
    const find = sandbox.commands.find((c) => c.startsWith('find '))
    expect(find).toBe("find 'work' -type l -delete 2>/dev/null; true")
    expect(sandbox.commands.indexOf(find as string)).toBeLessThan(
      sandbox.commands.length, // ran, and before the listing that follows the upload
    )
  })

  test('the lister and its args are rewritten before every listing; run isolated and quoted', async () => {
    const { sandbox, bridge } = setup(
      { '/work/a.txt': '1' },
      { listCommand: '/opt/my py/bin/python' },
    )
    await bridge.syncIn()
    sandbox.files.set('.eh-code/list.py', enc.encode('print("forged")'))
    await cycle(bridge)
    expect(text(sandbox, '.eh-code/list.py')).toContain('hashlib')
    const listing = sandbox.commands.filter((c) => c.includes('.eh-code/list.py'))
    expect(listing.length).toBeGreaterThan(0)
    for (const c of listing)
      expect(c.startsWith("'/opt/my py/bin/python' -I '.eh-code/list.py'")).toBe(true)
  })

  test('marker mismatch wipes the mount dirs: stale files are not resurrected as created', async () => {
    const { sandbox, bridge } = setup({ '/work/a.txt': '1' })
    await bridge.syncIn()
    sandbox.files.set('.eh-code/marker', enc.encode('another-sandbox'))
    sandbox.files.set('work/stale.txt', enc.encode('old'))
    const { out } = await cycle(bridge)
    expect(sandbox.files.has('work/stale.txt')).toBe(false)
    expect(out.saved).toEqual([])
  })

  test('a "/" mount wipes everything except .eh-code', async () => {
    const { sandbox, bridge } = setup({}, { mounts: [{ virtual: '/' }] })
    await bridge.syncIn()
    expect(sandbox.commands).toContain(
      'find . -mindepth 1 -maxdepth 1 ! -name .eh-code -exec rm -rf {} +',
    )
  })

  test('a failed write of one file does not hide the others; nothing is claimed unsaved after a write', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': '1' })
    await bridge.syncIn()
    sandbox.files.set('work/b.txt', enc.encode('b'))
    sandbox.files.set('work/c.txt', enc.encode('c'))
    const write = fs.write.bind(fs)
    fs.write = async (path, content, opts) => {
      if (path === '/work/b.txt') throw new Error('disk full')
      return write(path, content, opts)
    }
    const out = await bridge.syncOut(true)
    expect(out.saved).toEqual(['/work/c.txt'])
    expect(out.notSaved).toEqual([{ path: '/work/b.txt', reason: 'could not be saved: disk full' }])
  })

  test('a failing listing throws the dedicated error', async () => {
    const { sandbox, bridge } = setup({ '/work/a.txt': '1' })
    await bridge.syncIn()
    sandbox.onCommand = undefined
    wrapRun(sandbox, async (o, orig) =>
      o.command.includes('list.py')
        ? { exitCode: 1, stdout: '', stderr: 'boom' }
        : orig(o as never),
    )
    await expect(bridge.syncOut(true)).rejects.toThrow('boom')
  })

  test('a failed removal marks the bridge dirty: the next sync-in wipes the mount dirs', async () => {
    const { fs, sandbox, bridge } = setup({ '/work/a.txt': '1', '/work/b.txt': '2' })
    await bridge.syncIn()
    await fs.delete('/work/b.txt')
    let failing = true
    wrapRun(sandbox, async (o, orig) =>
      failing && o.command.startsWith('rm -f')
        ? { exitCode: 1, stdout: '', stderr: 'denied' }
        : orig(o as never),
    )
    await bridge.syncIn()
    failing = false
    sandbox.commands.length = 0
    const r = await bridge.syncIn()
    expect(sandbox.commands).toContain("rm -rf -- 'work'")
    expect(r.full).toBe(true)
  })
})
