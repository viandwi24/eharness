/** The local sandbox: run, file access and process-group kill. */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalSandbox } from '../src/shell/sandbox-local.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coder-sandbox-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('local sandbox run', () => {
  test('exit codes, stdout and stderr, cwd = root', async () => {
    const root = await temp()
    const sb = createLocalSandbox(root)
    expect(await sb.run({ command: 'echo out; echo err 1>&2; exit 3' })).toEqual({
      exitCode: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    })
    expect((await sb.run({ command: 'pwd' })).stdout.trim()).toBe(root)
    expect((await sb.run({ command: 'true' })).exitCode).toBe(0)
  })

  test('killed by a signal reports 128 + signal', async () => {
    const sb = createLocalSandbox(await temp())
    expect((await sb.run({ command: 'kill -TERM $$' })).exitCode).toBe(143)
  })
})

describe('local sandbox files', () => {
  test('readTextFile: whole file, line ranges, missing -> null', async () => {
    const root = await temp()
    await writeFile(join(root, 'a.txt'), 'l1\nl2\nl3\nl4')
    const sb = createLocalSandbox(root)
    expect(await sb.readTextFile({ path: 'a.txt' })).toBe('l1\nl2\nl3\nl4')
    expect(await sb.readTextFile({ path: 'a.txt', startLine: 2, endLine: 3 })).toBe('l2\nl3')
    expect(await sb.readTextFile({ path: 'a.txt', startLine: 3 })).toBe('l3\nl4')
    expect(await sb.readTextFile({ path: 'a.txt', endLine: 1 })).toBe('l1')
    expect(await sb.readTextFile({ path: 'missing.txt' })).toBeNull()
    expect(await sb.readFile({ path: 'missing.txt' })).toBeNull()
    expect(await sb.readBinaryFile({ path: 'missing.txt' })).toBeNull()
    expect(await sb.readTextFile({ path: join(root, 'a.txt'), endLine: 2 })).toBe('l1\nl2')
  })

  test('writeTextFile and binary writes create parents', async () => {
    const root = await temp()
    const sb = createLocalSandbox(root)
    await sb.writeTextFile({ path: 'x/y/z.txt', content: 'héllo' })
    expect(await readFile(join(root, 'x/y/z.txt'), 'utf8')).toBe('héllo')
    await sb.writeBinaryFile({ path: 'b/c.bin', content: new Uint8Array([1, 2, 3]) })
    expect([...(await readFile(join(root, 'b/c.bin')))]).toEqual([1, 2, 3])
    expect([...((await sb.readBinaryFile({ path: 'b/c.bin' })) ?? [])]).toEqual([1, 2, 3])
  })

  test('an aborted signal rejects before touching files', async () => {
    const root = await temp()
    const sb = createLocalSandbox(root)
    const ac = new AbortController()
    ac.abort()
    await expect(
      sb.writeTextFile({ path: 'n.txt', content: 'x', abortSignal: ac.signal }),
    ).rejects.toBeDefined()
    expect(existsSync(join(root, 'n.txt'))).toBe(false)
  })
})

describe('local sandbox abort', () => {
  test('abort kills the whole process group', async () => {
    const root = await temp()
    const sb = createLocalSandbox(root)
    const ac = new AbortController()
    const pidFile = join(root, 'pids')
    const proc = await sb.spawn({
      command: `sleep 30 & echo $! >> ${pidFile}; sleep 30 & echo $! >> ${pidFile}; wait`,
      abortSignal: ac.signal,
    })
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(20)
    await Bun.sleep(150)
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)
    expect(pids.length).toBe(2)
    for (const pid of pids) expect(alive(pid)).toBe(true)
    const waited = proc.wait()
    ac.abort(new Error('stop'))
    await expect(waited).rejects.toThrow('stop')
    for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(20)
    for (const pid of pids) expect(alive(pid)).toBe(false)
  })

  test('kill() terminates the group and wait() resolves with a signal code', async () => {
    const sb = createLocalSandbox(await temp())
    const proc = await sb.spawn({ command: 'sleep 30 & sleep 30; wait' })
    await Bun.sleep(100)
    await proc.kill()
    const { exitCode } = await proc.wait()
    expect(exitCode).toBe(143)
  })
})
