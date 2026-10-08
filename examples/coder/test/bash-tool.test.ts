/** The `bash` tool: footer, exit codes, timeout, abort, output cap and spawn failures. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sandbox } from '../src/contracts.ts'
import { capOutput, createBashTool } from '../src/shell/bash-tool.ts'
import { createLocalSandbox } from '../src/shell/sandbox-local.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coder-bash-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Opts = Parameters<typeof createBashTool>[0]

async function exec(
  opts: Opts,
  input: { command: string; timeoutMs?: number },
  abortSignal?: AbortSignal,
  chunks: unknown[] = [],
): Promise<string> {
  const factory = createBashTool(opts) as unknown as (ctx: unknown) => {
    execute: (input: unknown, options: unknown) => Promise<string>
  }
  const ctx = { stream: { active: false, data: (...a: unknown[]) => chunks.push(a) } }
  return factory(ctx).execute(input, { toolCallId: 'call-1', messages: [], abortSignal })
}

describe('bash tool', () => {
  test('success footer and output', async () => {
    const sandbox = createLocalSandbox(await temp())
    const out = await exec({ sandbox }, { command: 'echo hi' })
    expect(out).toMatch(/^hi\nExit code 0 · \d+\.\ds$/)
  })

  test('only a footer when there is no output', async () => {
    const sandbox = createLocalSandbox(await temp())
    expect(await exec({ sandbox }, { command: 'true' })).toMatch(/^Exit code 0 · \d+\.\ds$/)
  })

  test('non-zero exit is a string, stderr is included', async () => {
    const sandbox = createLocalSandbox(await temp())
    const out = await exec({ sandbox }, { command: 'echo bad 1>&2; exit 7' })
    expect(out).toMatch(/^bad\nExit code 7 · /)
  })

  test('timeout kills the command and reports it', async () => {
    const sandbox = createLocalSandbox(await temp())
    const started = Date.now()
    const out = await exec({ sandbox }, { command: 'echo start; sleep 30', timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(out).toStartWith('start\n')
    expect(out).toMatch(/\(timed out after \d+s\)$/)
  })

  test('the model timeout is capped by maxTimeoutMs', async () => {
    const sandbox = createLocalSandbox(await temp())
    const out = await exec(
      { sandbox, maxTimeoutMs: 200 },
      { command: 'sleep 30', timeoutMs: 600_000 },
    )
    expect(out).toMatch(/\(timed out after 0s\)$/)
  })

  test('abort reports it', async () => {
    const sandbox = createLocalSandbox(await temp())
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const out = await exec({ sandbox }, { command: 'echo go; sleep 30' }, ac.signal)
    expect(out).toMatch(/^go\n\(aborted after \d+\.\ds\)$/)
    const already = new AbortController()
    already.abort()
    expect(await exec({ sandbox }, { command: 'sleep 30' }, already.signal)).toMatch(/aborted/)
  })

  test('long output is capped to head and tail with a marker', async () => {
    const sandbox = createLocalSandbox(await temp())
    const out = await exec(
      { sandbox, maxOutputChars: 3000 },
      { command: 'head -c 20000 /dev/zero | tr "\\0" "a"; printf END' },
    )
    expect(out).toContain('characters omitted')
    expect(out).toContain('END\nExit code 0')
    expect(out.length).toBeLessThan(3200)
    expect(out.startsWith('a'.repeat(1000))).toBe(true)
  })

  test('ERROR: when the command cannot be started', async () => {
    const sandbox = {
      spawn: async () => {
        throw new Error('no shell')
      },
    } as unknown as Sandbox
    expect(await exec({ sandbox }, { command: 'x' })).toBe(
      'ERROR: could not start the command: no shell',
    )
  })

  test('streams transient chunks when the stream is active', async () => {
    const sandbox = createLocalSandbox(await temp())
    const chunks: unknown[][] = []
    const factory = createBashTool({ sandbox }) as unknown as (ctx: unknown) => {
      execute: (input: unknown, options: unknown) => Promise<string>
    }
    const ctx = { stream: { active: true, data: (...a: unknown[]) => chunks.push(a) } }
    await factory(ctx).execute(
      { command: 'echo a; echo b 1>&2' },
      { toolCallId: 'c9', messages: [] },
    )
    expect(chunks).toContainEqual([
      'bashOutput',
      { toolCallId: 'c9', stream: 'stdout', chunk: 'a\n' },
    ])
    expect(chunks).toContainEqual([
      'bashOutput',
      { toolCallId: 'c9', stream: 'stderr', chunk: 'b\n' },
    ])
  })
})

describe('capOutput', () => {
  test('unchanged under the cap; head + marker + tail over it', () => {
    expect(capOutput('abc', 10)).toBe('abc')
    const capped = capOutput(`${'h'.repeat(50_000)}${'t'.repeat(50_000)}`, 30_000)
    expect(capped).toContain('[70000 characters omitted]')
    expect(capped.startsWith('h'.repeat(10_000))).toBe(true)
    expect(capped.endsWith('t'.repeat(20_000))).toBe(true)
  })
})
