/** Read isolation, resource limits and scratch sandboxes. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectOsSandbox, readPolicy, seatbeltProfile, wrapCommand } from './os-sandbox.ts'
import { localSandbox, removeStaleScratch, scratchSandbox } from './sandbox-local.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eh-iso-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('read policy and generation', () => {
  test('home is denied, the root inside it is re-allowed', () => {
    const p = readPolicy({
      root: '/h/me/proj',
      allowWrite: ['/h/me/out', '/elsewhere'],
      allowRead: ['/h/me/env'],
      denyReadHome: true,
      home: '/h/me',
    })
    expect(p.deny).toEqual(['/h/me'])
    expect(p.reallow).toEqual(['/h/me/proj', '/h/me/out', '/h/me/env'])
    expect(readPolicy({ root: '/a', allowWrite: [] }).deny).toEqual([])
  })

  test('seatbelt: deny, then re-allow, plus metadata of parents', () => {
    const profile = seatbeltProfile({
      root: '/h/me/proj',
      allowWrite: [],
      network: false,
      denyRead: ['/secret'],
      denyReadHome: true,
      home: '/h/me',
    })
    const deny = profile.indexOf('(deny file-read* (subpath "/h/me"))')
    const allow = profile.indexOf('(allow file-read* (subpath "/h/me/proj"))')
    expect(deny).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(deny)
    expect(profile).toContain('(deny file-read* (subpath "/secret"))')
    expect(profile).toContain('(allow file-read-metadata (literal "/h/me"))')
    expect(seatbeltProfile({ root: '/w', allowWrite: [], network: true })).not.toContain(
      'file-read',
    )
  })

  test('bubblewrap: tmpfs for dirs, /dev/null for files, binds after', async () => {
    const base = await temp()
    const home = join(base, 'home')
    const root = join(home, 'proj')
    await mkdir(root, { recursive: true })
    const file = join(base, 'secret.txt')
    await writeFile(file, 'x')
    const argv = wrapCommand('true', {
      root,
      allowWrite: [],
      network: false,
      kind: 'bubblewrap',
      toolPath: 'bwrap',
      denyRead: [file],
      denyReadHome: true,
      home,
    })
    const joined = argv.join(' ')
    expect(joined).toContain(`--ro-bind /dev/null ${file}`)
    const tmpfs = argv.indexOf('--tmpfs', argv.indexOf('--tmpfs') + 1)
    expect(argv[tmpfs + 1]).toBe(home)
    // the root is re-bound (writable) after the deny that hides its parent
    const rebind = argv.lastIndexOf('--bind')
    expect(rebind).toBeGreaterThan(tmpfs)
    expect(rebind).toBeGreaterThan(argv.indexOf('/dev/null'))
    expect(argv.slice(rebind, rebind + 3)).toEqual(['--bind', root, root])
  })

  test('bubblewrap: a deny inside the root or allowWrite comes after the writable binds', async () => {
    const base = await temp()
    const root = join(base, 'proj')
    const extra = join(base, 'extra')
    await mkdir(join(root, 'secret'), { recursive: true })
    await mkdir(join(extra, 'keys'), { recursive: true })
    const argv = wrapCommand('true', {
      root,
      allowWrite: [extra],
      network: false,
      kind: 'bubblewrap',
      toolPath: 'bwrap',
      denyRead: [join(root, 'secret'), join(extra, 'keys'), join(base, 'missing')],
    })
    const at = (flag: string, path: string): number =>
      argv.findIndex((a, i) => a === flag && argv[i + 1] === path)
    expect(at('--tmpfs', join(root, 'secret'))).toBeGreaterThan(at('--bind', root))
    expect(at('--tmpfs', join(extra, 'keys'))).toBeGreaterThan(at('--bind', extra))
    expect(argv).not.toContain(join(base, 'missing'))
  })

  test('bubblewrap: re-allowed paths that do not exist are skipped', async () => {
    const base = await temp()
    const home = join(base, 'home')
    const root = join(home, 'proj')
    await mkdir(root, { recursive: true })
    const argv = wrapCommand('true', {
      root,
      allowWrite: [],
      network: false,
      kind: 'bubblewrap',
      toolPath: 'bwrap',
      denyReadHome: true,
      allowRead: [join(home, 'nope')],
      home,
    })
    expect(argv).not.toContain(join(home, 'nope'))
    expect(argv.lastIndexOf('--bind')).toBeGreaterThan(
      argv.indexOf('--tmpfs', argv.indexOf('--tmpfs') + 1),
    )
  })
})

describe('limits validation', () => {
  test('invalid values throw EH_CONFIG_INVALID', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => localSandbox({ root: '/x', limits: { cpuSeconds: bad } })).toThrow(
        /limits\.cpuSeconds/,
      )
    }
    expect(() => localSandbox({ root: '/x', limits: { fileBytes: 0 } })).toThrow(/fileBytes/)
  })
})

describe.skipIf(process.platform === 'win32')('limits (real runs)', () => {
  test('fileBytes stops a runaway write', async () => {
    const root = await temp()
    const sb = localSandbox({ root, limits: { fileBytes: 64 * 1024 } })
    const r = await sb.run({ command: 'yes > big; echo done' })
    expect(r.stdout).toContain('done')
    const size = (await Bun.file(join(root, 'big')).stat()).size
    expect(size).toBeLessThanOrEqual(64 * 1024)
    expect(size).toBeGreaterThan(0)
  })

  test('cpuSeconds kills a busy loop', async () => {
    const sb = localSandbox({ root: await temp(), limits: { cpuSeconds: 1 } })
    const r = await sb.run({ command: 'while :; do :; done' })
    expect(r.exitCode).not.toBe(0)
  })

  test('without limits nothing changes', async () => {
    const sb = localSandbox({ root: await temp() })
    expect((await sb.run({ command: 'yes | head -c 200000 > f; wc -c < f' })).stdout.trim()).toBe(
      '200000',
    )
  })
})

describe.skipIf(detectOsSandbox().kind === 'none')('denyRead (real runs)', () => {
  test('denyReadHome hides the home but not the root', async () => {
    const home = await temp()
    const root = join(home, 'work')
    await mkdir(root)
    await writeFile(join(home, 'secret.txt'), 'top-secret')
    await writeFile(join(root, 'ok.txt'), 'visible')
    const sb = localSandbox({ root, os: { enabled: true, denyReadHome: true, home } })
    expect(sb.state().denyRead).toEqual([home])
    const secret = await sb.run({ command: `cat '${join(home, 'secret.txt')}'` })
    expect(secret.stdout).not.toContain('top-secret')
    expect(secret.exitCode).not.toBe(0)
    const ok = await sb.run({ command: 'cat ok.txt && echo y > new.txt && cat new.txt && pwd' })
    expect(ok.stdout).toContain('visible')
    expect(ok.stdout).toContain(root)
    expect(ok.exitCode).toBe(0)
  })

  test('allowRead re-allows a directory inside the home', async () => {
    const home = await temp()
    const root = join(home, 'work')
    const env = join(home, 'env')
    await mkdir(root)
    await mkdir(env)
    await writeFile(join(env, 'lib.txt'), 'lib')
    await writeFile(join(home, 'secret.txt'), 'top-secret')
    const sb = localSandbox({
      root,
      os: { enabled: true, denyReadHome: true, home, allowRead: [env] },
    })
    expect((await sb.run({ command: `cat '${join(env, 'lib.txt')}'` })).stdout).toBe('lib')
    expect((await sb.run({ command: `cat '${join(home, 'secret.txt')}'` })).exitCode).not.toBe(0)
  })

  test('explicit denyRead of a directory and a file', async () => {
    const base = await temp()
    const root = join(base, 'work')
    const hidden = join(base, 'hidden')
    await mkdir(root)
    await mkdir(hidden)
    await writeFile(join(hidden, 'a.txt'), 'dir-secret')
    await writeFile(join(base, 'f.txt'), 'file-secret')
    const sb = localSandbox({
      root,
      os: { enabled: true, denyRead: [hidden, join(base, 'f.txt')] },
    })
    expect((await sb.run({ command: `cat '${join(hidden, 'a.txt')}'` })).stdout).not.toContain(
      'secret',
    )
    expect((await sb.run({ command: `cat '${join(base, 'f.txt')}'` })).stdout).not.toContain(
      'secret',
    )
    expect((await sb.run({ command: 'echo ok' })).stdout).toBe('ok\n')
  })

  test('off by default: the same file is readable', async () => {
    const home = await temp()
    const root = join(home, 'work')
    await mkdir(root)
    await writeFile(join(home, 'secret.txt'), 'top-secret')
    const sb = localSandbox({ root, os: { enabled: true, home } })
    expect(sb.state().denyRead).toEqual([])
    expect((await sb.run({ command: `cat '${join(home, 'secret.txt')}'` })).stdout).toBe(
      'top-secret',
    )
  })
})

describe('scratch sandboxes', () => {
  test('create, run, dispose (idempotent)', async () => {
    const parent = await temp()
    const sb = await scratchSandbox({ parent, prefix: 'eh-test-' })
    expect(sb.root.startsWith(join(parent, 'eh-test-'))).toBe(true)
    expect((await sb.run({ command: 'echo hi > f && cat f' })).stdout).toBe('hi\n')
    await sb.dispose()
    await sb.dispose()
    expect(existsSync(sb.root)).toBe(false)
  })

  test('dispose kills a running command first', async () => {
    const sb = await scratchSandbox({ parent: await temp() })
    const proc = await sb.spawn({ command: 'sleep 30' })
    const pid = proc.pid as number
    await sb.dispose()
    await Promise.resolve(proc.wait()).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('removeStaleScratch removes only old matching directories', async () => {
    const parent = await temp()
    await mkdir(join(parent, 'eh-code-old'))
    await mkdir(join(parent, 'eh-code-new'))
    await mkdir(join(parent, 'other-old'))
    const old = new Date(Date.now() - 48 * 3600 * 1000)
    await utimes(join(parent, 'eh-code-old'), old, old)
    await utimes(join(parent, 'other-old'), old, old)
    expect(await removeStaleScratch({ parent })).toBe(1)
    expect(existsSync(join(parent, 'eh-code-old'))).toBe(false)
    expect(existsSync(join(parent, 'eh-code-new'))).toBe(true)
    expect(existsSync(join(parent, 'other-old'))).toBe(true)
    expect(await removeStaleScratch({ parent: join(parent, 'missing') })).toBe(0)
  })
})

describe('scratch sandbox disposal', () => {
  test('after dispose, file operations and spawn throw', async () => {
    const sb = await scratchSandbox({ parent: await temp() })
    await sb.writeTextFile({ path: 'a.txt', content: 'x' })
    await sb.dispose()
    await expect(sb.writeTextFile({ path: 'b.txt', content: 'x' })).rejects.toThrow(
      'sandbox disposed',
    )
    await expect(sb.readTextFile({ path: 'a.txt' })).rejects.toThrow('sandbox disposed')
    await expect(sb.spawn({ command: 'true' })).rejects.toThrow('sandbox disposed')
    await sb.dispose()
  })
})
