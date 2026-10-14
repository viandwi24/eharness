import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkExtraArgs, chromePlatform, chromeRuntime, detectContainer } from './chrome.ts'
import { withInstallLock } from './download.ts'
import { lightpandaAsset, lightpandaRuntime } from './lightpanda.ts'
import type { LaunchedProcess, ProcessLauncher } from './process.ts'
import { parsePs, processUsage, sumTree, systemMemory } from './resources.ts'

const dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'eh-browser-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

function fakeProc(pid = 4242): LaunchedProcess & { killed: string[] } {
  let resolve!: (n: number | null) => void
  const exited = new Promise<number | null>((r) => {
    resolve = r
  })
  const killed: string[] = []
  return {
    pid,
    exited,
    killed,
    kill(signal = 'SIGTERM') {
      killed.push(signal)
      resolve(null)
    },
    output: () => '',
  }
}

describe('platform picks', () => {
  test('chrome', () => {
    expect(chromePlatform('linux', 'x64')).toBe('linux64')
    expect(chromePlatform('linux', 'arm64')).toBe('linux-arm64')
    expect(chromePlatform('darwin', 'arm64')).toBe('mac-arm64')
    expect(chromePlatform('darwin', 'x64')).toBe('mac-x64')
    expect(chromePlatform('win32', 'x64')).toBe('win64')
    expect(chromePlatform('win32', 'ia32')).toBe('win32')
    expect(chromePlatform('freebsd', 'x64')).toBeUndefined()
  })
  test('lightpanda', () => {
    expect(lightpandaAsset('linux', 'x64')).toBe('lightpanda-x86_64-linux')
    expect(lightpandaAsset('darwin', 'arm64')).toBe('lightpanda-aarch64-macos')
    expect(lightpandaAsset('win32', 'x64')).toBeUndefined()
  })
  test('lightpanda status on Windows says so', async () => {
    const rt = lightpandaRuntime({ root: await tmp(), platform: 'win32' })
    const s = await rt.status()
    expect(s.state).toBe('error')
    expect(s.error).toContain('Windows')
  })
})

describe('extraArgs and container', () => {
  test('allowlist', () => {
    expect(checkExtraArgs(['--lang=en'])).toEqual(['--lang=en'])
    expect(() => checkExtraArgs(['--remote-debugging-address=0.0.0.0'])).toThrow()
    expect(() => checkExtraArgs(['--user-data-dir=/x'])).toThrow()
    expect(() => checkExtraArgs(['nope'])).toThrow()
  })
  test('detectContainer', () => {
    expect(detectContainer((p) => p === '/.dockerenv')).toBe(true)
    expect(
      detectContainer(
        () => false,
        () => '0::/kubepods/x',
      ),
    ).toBe(true)
    expect(
      detectContainer(
        () => false,
        () => '0::/user.slice',
      ),
    ).toBe(false)
  })
})

describe('install lock', () => {
  test('second caller shares the first run', async () => {
    let runs = 0
    const job = async (): Promise<void> => {
      runs++
      await new Promise((r) => setTimeout(r, 20))
    }
    await Promise.all([withInstallLock('k', job), withInstallLock('k', job)])
    expect(runs).toBe(1)
    await withInstallLock('k', job)
    expect(runs).toBe(2)
  })
})

describe('lightpanda runtime', () => {
  test('installs with progress, starts on loopback with telemetry off, stops', async () => {
    const root = await tmp()
    const body = new Uint8Array(1000).fill(7)
    const urls: string[] = []
    const fetchFake = async (url: string): Promise<Response> => {
      urls.push(url)
      return new Response(body, { headers: { 'content-length': '1000' } })
    }
    let launched:
      | { cmd: string; args: string[]; env: Record<string, string | undefined> }
      | undefined
    const proc = fakeProc()
    const launcher: ProcessLauncher = (cmd, args, o) => {
      launched = { cmd, args, env: o.env }
      return proc
    }
    const rt = lightpandaRuntime({
      root,
      platform: 'linux',
      arch: 'x64',
      fetch: fetchFake,
      launcher,
      probe: async () => true,
    })
    expect((await rt.status()).state).toBe('missing')
    const seen: number[] = []
    await rt.install({ onProgress: (p) => seen.push(p.received) })
    expect(urls[0]).toContain('/nightly/lightpanda-x86_64-linux')
    expect(seen.at(-1)).toBe(1000)
    const ready = await rt.status()
    expect(ready.state).toBe('ready')
    expect(ready.diskBytes).toBeGreaterThanOrEqual(1000)
    expect(await readdir(join(root, 'lightpanda', 'nightly'))).not.toContain('lightpanda.download')

    const ep = await rt.start({ id: 'p1' })
    expect(ep.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(launched?.args.slice(0, 3)).toEqual(['serve', '--host', '127.0.0.1'])
    expect(launched?.env.LIGHTPANDA_DISABLE_TELEMETRY).toBe('true')
    expect(await rt.start({ id: 'p1' })).toBe(ep)
    expect((await rt.status()).running).toEqual(['p1'])
    await rt.stop('p1')
    expect(proc.killed).toContain('SIGTERM')
    expect((await rt.status()).state).toBe('ready')
    await rt.uninstall?.()
    expect((await rt.status()).state).toBe('missing')
  })

  test('failed download leaves no partial file', async () => {
    const root = await tmp()
    const rt = lightpandaRuntime({
      root,
      platform: 'linux',
      arch: 'x64',
      fetch: async () => new Response('x', { status: 404 }),
    })
    await expect(rt.install()).rejects.toThrow('404')
    const files = await readdir(join(root, 'lightpanda', 'nightly'))
    expect(files).toEqual([])
    expect((await rt.status()).state).toBe('error')
  })
})

describe('chrome runtime', () => {
  async function fakeChrome(root: string): Promise<string> {
    const exe = join(root, 'chrome-bin')
    await writeFile(exe, '#!/bin/sh\n')
    await chmod(exe, 0o755)
    return exe
  }

  test('start writes args, reads DevToolsActivePort, no sandbox flag outside containers', async () => {
    const root = await tmp()
    const exe = await fakeChrome(root)
    let args: string[] = []
    const proc = fakeProc()
    const launcher: ProcessLauncher = (_cmd, a) => {
      args = a
      const dir = a.find((x) => x.startsWith('--user-data-dir='))?.slice(16) as string
      void writeFile(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n')
      return proc
    }
    const rt = chromeRuntime({
      root,
      executablePath: exe,
      launcher,
      inContainer: false,
      verify: false,
      stopGraceMs: 20,
    })
    const ep = await rt.start({ id: 'prof_1' }, { extraArgs: ['--lang=en'] })
    expect(ep.cdpUrl).toBe('ws://127.0.0.1:9333/devtools/browser/abc')
    expect(args).toContain(`--user-data-dir=${join(root, 'profiles', 'prof_1')}`)
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain('--headless=new')
    expect(args).toContain('--lang=en')
    expect(args).not.toContain('--no-sandbox')
    expect((await rt.status()).state).toBe('running')
    await rt.removeProfileData?.('prof_1')
    expect(existsSync(join(root, 'profiles', 'prof_1'))).toBe(false)
    expect(proc.killed.length).toBeGreaterThan(0)
  })

  test('container adds --no-sandbox; bad extraArgs and ids are refused', async () => {
    const root = await tmp()
    const exe = await fakeChrome(root)
    let args: string[] = []
    const launcher: ProcessLauncher = (_c, a) => {
      args = a
      const dir = a.find((x) => x.startsWith('--user-data-dir='))?.slice(16) as string
      void writeFile(join(dir, 'DevToolsActivePort'), '1\n/p\n')
      return fakeProc()
    }
    const rt = chromeRuntime({
      root,
      executablePath: exe,
      launcher,
      inContainer: true,
      stopGraceMs: 20,
    })
    await rt.start({ id: 'a' })
    expect(args).toContain('--no-sandbox')
    await expect(rt.start({ id: 'b' }, { extraArgs: ['--user-data-dir=/tmp/x'] })).rejects.toThrow()
    await expect(rt.start({ id: '../x' })).rejects.toThrow()
    await rt.stop('a')
  })

  test('install picks the platform from the JSON, extracts, and marks the version', async () => {
    const root = await tmp()
    // Build a real zip with the system zip tool.
    const src = await tmp()
    await mkdir(join(src, 'chrome-linux64'), { recursive: true })
    await writeFile(join(src, 'chrome-linux64', 'chrome'), '#!/bin/sh\necho Chrome\n')
    const zip = join(await tmp(), 'chrome.zip')
    const z = Bun.spawnSync(['zip', '-qr', zip, 'chrome-linux64'], { cwd: src })
    if (z.exitCode !== 0) return // zip tool missing: skip
    const bytes = await Bun.file(zip).bytes()
    const fetchFake = async (url: string): Promise<Response> => {
      if (url.endsWith('.json')) {
        return Response.json({
          channels: {
            Stable: {
              version: '150.0.1.2',
              downloads: {
                chrome: [
                  { platform: 'linux64', url: 'https://x/linux64.zip' },
                  { platform: 'mac-arm64', url: 'https://x/mac.zip' },
                ],
              },
            },
          },
        })
      }
      expect(url).toBe('https://x/linux64.zip')
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    }
    const rt = chromeRuntime({
      root,
      platform: 'linux',
      arch: 'x64',
      fetch: fetchFake,
      verify: false,
    })
    expect((await rt.status()).state).toBe('missing')
    await Promise.all([rt.install(), rt.install()])
    const s = await rt.status()
    expect(s.state).toBe('ready')
    expect(s.version).toBe('150.0.1.2')
    expect(existsSync(join(root, 'chrome', '150.0.1.2', 'chrome-linux64', 'chrome'))).toBe(true)
    expect(await readdir(join(root, 'chrome'))).not.toContain('150.0.1.2.zip')
  })
})

describe('resources', () => {
  const ps = `  1     0  1000  0.5
 10     1  2048  1.5
 11    10  1024  2.0
 12    10   512  0.0
 99     1  9999 50.0
`
  test('parse and sum tree', () => {
    const rows = parsePs(ps)
    expect(rows).toHaveLength(5)
    expect(sumTree(rows, 10)).toEqual({ rssBytes: (2048 + 1024 + 512) * 1024, cpuPercent: 3.5 })
    expect(sumTree(rows, 777)).toBeNull()
  })
  test('darwin uses ps; windows is unknown', async () => {
    const u = await processUsage(10, { platform: 'darwin', exec: async () => ps })
    expect(u?.rssBytes).toBe((2048 + 1024 + 512) * 1024)
    expect(await processUsage(10, { platform: 'win32' })).toBeNull()
  })
  test('linux reads /proc', async () => {
    const files: Record<string, string> = {
      '/proc/uptime': '1000.00 0.0',
      '/proc/10/stat': `10 (chrome) S 1 0 0 0 0 0 0 0 0 0 500 100 0 0 20 0 1 0 90000 0 0`,
      '/proc/10/statm': '100 25 0 0 0 0 0',
      '/proc/11/stat': `11 (chr ome) S 10 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 90000 0 0`,
      '/proc/11/statm': '100 10 0 0 0 0 0',
    }
    const u = await processUsage(10, {
      platform: 'linux',
      listProc: async () => ['10', '11', 'self'],
      readText: async (p) => {
        const v = files[p]
        if (v === undefined) throw new Error('ENOENT')
        return v
      },
    })
    expect(u?.rssBytes).toBe(35 * 4096)
    expect(u?.cpuPercent).toBeGreaterThan(0)
  })
  test('systemMemory', () => {
    const m = systemMemory()
    expect(m.totalBytes).toBeGreaterThan(0)
  })
})

const e2e = process.env.EH_BROWSER_E2E === '1'
describe.skipIf(!e2e)('real Chrome (EH_BROWSER_E2E=1)', () => {
  test('installs, starts, reports usage, stops', async () => {
    const root = process.env.EH_BROWSER_E2E_ROOT ?? (await tmp())
    const rt = chromeRuntime({ root })
    await rt.install()
    const ep = await rt.start({ id: 'e2e' })
    const res = await fetch(
      ep.cdpUrl.replace('ws:', 'http:').replace(/\/devtools.*/, '/json/version'),
    )
    expect(res.ok).toBe(true)
    expect((await rt.usage('e2e'))?.rssBytes).toBeGreaterThan(0)
    await rt.stop('e2e')
  }, 600_000)
})
