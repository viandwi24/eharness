import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeRemoteSandbox, remoteSandbox } from '../src/client.ts'
import { type RunningServer, startServer } from '../src/server.ts'

const TOKEN = 'test-token-123456'
let dir: string
let server: RunningServer
const hasPython = Bun.spawnSync(['python3', '--version']).exitCode === 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eh-sbx-test-'))
  server = await startServer({
    token: TOKEN,
    dataDir: dir,
    osSandbox: false,
    log: () => {},
    // `ulimit -u` counts the whole user on a dev machine: keep it out of the way
    limits: { maxSessions: 3, maxFileMb: 1, processes: 1_000_000 },
    sweepMs: 50,
  })
})
afterAll(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

const opts = (): { url: string; token: string } => ({ url: server.url, token: TOKEN })

describe('sandbox server', () => {
  test('healthz needs no auth; info needs it', async () => {
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200)
    expect((await fetch(`${server.url}/v1/info`)).status).toBe(401)
    const info = await probeRemoteSandbox(opts())
    expect(info.version).toBe(1)
    expect(info.isolation.isolated).toBe(true)
  })

  test('auth failure is readable', async () => {
    await expect(probeRemoteSandbox({ ...opts(), token: 'wrong-token-xx' })).rejects.toThrow(/401/)
    await expect(remoteSandbox({ ...opts(), token: 'wrong-token-xx' })).rejects.toThrow(/401/)
    await expect(probeRemoteSandbox({ url: 'http://127.0.0.1:1', token: TOKEN })).rejects.toThrow(
      /cannot reach/,
    )
  })

  test.skipIf(!hasPython)('files and run round trip', async () => {
    const sb = await remoteSandbox(opts())
    await sb.writeTextFile({ path: 'work/in.txt', content: 'hello\nworld\nthree\n' })
    expect(await sb.readTextFile({ path: 'work/in.txt', startLine: 2, endLine: 3 })).toBe(
      'world\nthree',
    )
    expect(await sb.readTextFile({ path: 'missing.txt' })).toBeNull()
    const r = await sb.run({
      command: `python3 -c "d=open('work/in.txt').read().upper(); open('work/out.txt','w').write(d); print('ok')"`,
    })
    expect(r).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
    expect(await sb.readTextFile({ path: 'work/out.txt' })).toBe('HELLO\nWORLD\nTHREE\n')
    const bytes = await sb.readBinaryFile({ path: 'work/out.txt' })
    expect(bytes?.byteLength).toBe(18)
    const failed = await sb.run({ command: 'echo e >&2; exit 3' })
    expect(failed.exitCode).toBe(3)
    expect(failed.stderr).toBe('e\n')
    await sb.dispose?.()
  })

  test('spawn kill and abort', async () => {
    const sb = await remoteSandbox(opts())
    const p = await sb.spawn({ command: 'sleep 30' })
    await p.kill()
    expect((await p.wait()).exitCode).toBe(137)
    const ac = new AbortController()
    const q = await sb.spawn({ command: 'sleep 30', abortSignal: ac.signal })
    ac.abort(new Error('stop'))
    await expect(q.wait()).rejects.toThrow('stop')
    await sb.dispose?.()
  })

  test('path validation', async () => {
    const sb = await remoteSandbox(opts())
    for (const path of ['/etc/passwd', '../x', 'a/../../x', 'a\0b']) {
      await expect(sb.readBinaryFile({ path })).rejects.toThrow(/path/)
    }
    await expect(sb.writeTextFile({ path: '../x', content: 'x' })).rejects.toThrow(/\.\./)
    // a symlink planted by a script is refused, not followed
    await sb.run({ command: 'ln -s /etc/hostname link' })
    await expect(sb.readBinaryFile({ path: 'link' })).rejects.toThrow(/symbolic link/)
    await sb.dispose?.()
  })

  test('file size limit', async () => {
    const sb = await remoteSandbox(opts())
    await expect(
      sb.writeBinaryFile({ path: 'big.bin', content: new Uint8Array(2 * 1024 * 1024) }),
    ).rejects.toThrow(/larger/)
    await sb.dispose?.()
  })

  test('delete, unknown sessions and max sessions', async () => {
    const a = await remoteSandbox(opts())
    const b = await remoteSandbox(opts())
    const c = await remoteSandbox(opts())
    expect(server.sessions()).toBe(3)
    await expect(remoteSandbox(opts())).rejects.toThrow(/too many sessions/)
    await a.dispose?.()
    expect(server.sessions()).toBe(2)
    await expect(a.readTextFile({ path: 'x' })).rejects.toThrow(/unknown session/)
    await b.dispose?.()
    await c.dispose?.()
    expect(server.sessions()).toBe(0)
  })

  test('idle sessions are disposed', async () => {
    const short = await startServer({
      token: TOKEN,
      dataDir: dir,
      osSandbox: false,
      log: () => {},
      limits: { idleMinutes: 0.0005, processes: 1_000_000 },
      sweepMs: 20,
    })
    const sb = await remoteSandbox({ url: short.url, token: TOKEN })
    expect(short.sessions()).toBe(1)
    await Bun.sleep(300)
    expect(short.sessions()).toBe(0)
    await expect(sb.readTextFile({ path: 'x' })).rejects.toThrow(/unknown session/)
    await short.stop()
  })
})
