/** OS sandbox: profile/argv generation (all platforms) and real runs where the tool exists. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectOsSandbox, sbplString, seatbeltProfile, wrapCommand } from './os-sandbox.ts'
import { localSandbox } from './sandbox-local.ts'

describe('profile and argv', () => {
  test('sbplString escapes quotes and backslashes', () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"')
  })

  test('seatbelt profile: write allowlist and network rule', () => {
    const off = seatbeltProfile({ root: '/work/my "proj"', allowWrite: ['/extra'], network: false })
    expect(off).toContain('(deny file-write*)')
    expect(off).toContain('(subpath "/work/my \\"proj\\"")')
    expect(off).toContain('(subpath "/extra")')
    expect(off).toContain('(subpath "/private/tmp")')
    expect(off).toContain('(deny network*)')
    const on = seatbeltProfile({ root: '/work', allowWrite: [], network: true })
    expect(on).not.toContain('(deny network*)')
  })

  test('seatbelt argv', () => {
    const argv = wrapCommand('echo hi', {
      root: '/work',
      allowWrite: [],
      network: false,
      kind: 'seatbelt',
    })
    expect(argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(argv[1]).toBe('-p')
    expect(argv.slice(-3)[1]).toBe('-c')
    expect(argv.at(-1)).toBe('echo hi')
  })

  test('bubblewrap argv', () => {
    const argv = wrapCommand('ls', {
      root: '/work',
      allowWrite: ['/extra'],
      network: false,
      kind: 'bubblewrap',
    })
    const s = argv.join(' ')
    expect(s).toContain('--ro-bind / /')
    expect(s).toContain('--bind /work /work')
    expect(s).toContain('--bind /extra /extra')
    expect(s).toContain('--tmpfs /tmp')
    expect(s).toContain('--unshare-net')
    expect(s).toContain('--die-with-parent')
    expect(argv.indexOf('--tmpfs')).toBeLessThan(argv.indexOf('--bind'))
    const net = wrapCommand('ls', {
      root: '/work',
      allowWrite: [],
      network: true,
      kind: 'bubblewrap',
    })
    expect(net).not.toContain('--unshare-net')
  })

  test('none runs the plain shell; detect never claims a missing tool', () => {
    const argv = wrapCommand('ls', { root: '/w', allowWrite: [], network: false, kind: 'none' })
    expect(argv.slice(1)).toEqual(['-c', 'ls'])
    const d = detectOsSandbox()
    if (d.kind !== 'none') expect(existsSync(d.path as string)).toBe(true)
  })

  test('unavailable tool: sandbox reports not enabled and still runs', async () => {
    const sb = localSandbox('/tmp', {
      os: { enabled: false, network: false, allowWrite: [] },
    })
    expect(sb.state().enabled).toBe(false)
    expect(sb.description).toContain('not sandboxed')
  })
})

const available = detectOsSandbox().kind !== 'none'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe.skipIf(!available)('real OS sandbox', () => {
  async function setup(network = false) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'eh-os-')))
    dirs.push(root)
    const sb = localSandbox(root, { os: { enabled: true, network } })
    return { root, sb }
  }

  test('state and description', async () => {
    const { root, sb } = await setup()
    expect(sb.state()).toEqual({
      enabled: true,
      kind: detectOsSandbox().kind,
      network: false,
      writableRoots: [root],
    })
    expect(sb.description).toContain('OS sandbox')
    expect(sb.description).toContain(root)
    sb.setOs({ enabled: false })
    expect(sb.description).toContain('not sandboxed')
  })

  test('writes inside root succeed, outside root fail, reads work', async () => {
    const { root, sb } = await setup()
    const ok = await sb.run({ command: 'echo x > ok.txt && cat ok.txt' })
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'x\n' })
    const outside = join(homedir(), `eh-sandbox-test-${Math.random().toString(36).slice(2)}.txt`)
    try {
      const r = await sb.run({ command: `echo x > '${outside}'` })
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toMatch(/Operation not permitted|Read-only file system/)
      expect(existsSync(outside)).toBe(false)
    } finally {
      await rm(outside, { force: true })
    }
    expect(
      (await sb.run({ command: `ls / >/dev/null && cat /etc/hosts >/dev/null && ls ${root}` }))
        .exitCode,
    ).toBe(0)
    expect((await sb.run({ command: 'echo t > "$(mktemp)"' })).exitCode).toBe(0)
  })

  test('toggling off allows the outside write', async () => {
    const { sb } = await setup()
    sb.setOs({ enabled: false })
    const outside = join(tmpdir(), `eh-sandbox-off-${Date.now()}.txt`)
    try {
      expect((await sb.run({ command: `echo x > '${outside}'` })).exitCode).toBe(0)
    } finally {
      await rm(outside, { force: true })
    }
  })

  test('network is denied', async () => {
    if (!existsSync('/usr/bin/curl')) return
    const { sb } = await setup()
    const started = Date.now()
    const r = await sb.run({ command: 'curl -sS --max-time 5 https://example.com' })
    expect(r.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(6000)
  })
})
