/** OS sandbox: profile/argv generation (all platforms) and real runs where the tool exists. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBashTool } from '../src/shell/bash-tool.ts'
import {
  detectOsSandbox,
  sbplString,
  seatbeltProfile,
  wrapCommand,
} from '../src/shell/os-sandbox.ts'
import { createLocalSandbox } from '../src/shell/sandbox-local.ts'

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
    const sb = createLocalSandbox('/tmp', {
      os: { enabled: false, network: false, allowWrite: [] },
    })
    expect(sb.sandboxState().enabled).toBe(false)
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
    const root = await realpath(await mkdtemp(join(tmpdir(), 'coder-os-')))
    dirs.push(root)
    const sb = createLocalSandbox(root, { os: { enabled: true, network, allowWrite: [] } })
    return { root, sb }
  }

  test('state and description', async () => {
    const { root, sb } = await setup()
    expect(sb.sandboxState()).toEqual({
      enabled: true,
      kind: detectOsSandbox().kind,
      network: false,
    })
    expect(sb.description).toContain('OS sandbox')
    expect(sb.description).toContain(root)
    sb.setOsSandbox({ enabled: false, network: false, allowWrite: [] })
    expect(sb.description).toContain('not sandboxed')
  })

  test('writes inside root succeed, outside root fail, reads work', async () => {
    const { root, sb } = await setup()
    const ok = await sb.run({ command: 'echo x > ok.txt && cat ok.txt' })
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'x\n' })
    const outside = join(homedir(), `coder-sandbox-test-${Math.random().toString(36).slice(2)}.txt`)
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
    sb.setOsSandbox({ enabled: false, network: false, allowWrite: [] })
    const outside = join(tmpdir(), `coder-sandbox-off-${Date.now()}.txt`)
    try {
      expect((await sb.run({ command: `echo x > '${outside}'` })).exitCode).toBe(0)
    } finally {
      await rm(outside, { force: true })
    }
  })

  test('network is denied', async () => {
    if (!Bun.which('curl')) return
    const { sb } = await setup()
    const started = Date.now()
    const r = await sb.run({ command: 'curl -sS --max-time 5 https://example.com' })
    expect(r.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(6000)
  })

  test('bash tool appends the sandbox hint on a denied write', async () => {
    const { sb } = await setup()
    const factory = createBashTool({ sandbox: sb }) as unknown as (ctx: unknown) => {
      execute(i: unknown, o: unknown): Promise<string>
    }
    const ctx = { stream: { active: false, data: () => {} } }
    const run = (command: string): Promise<string> =>
      factory(ctx).execute({ command }, { toolCallId: 'c', messages: [] })
    const denied = await run(`echo x > '${join(homedir(), 'coder-sandbox-hint.txt')}'`)
    expect(denied).toContain('writes outside the project and network access are blocked')
    expect(await run('echo fine')).not.toContain('OS sandbox')
  })
})
