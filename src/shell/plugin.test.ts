/** The shell plugin through real sessions with a scripted model. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { type ScriptedStep, scriptedModel } from '../testing/index.ts'
import { detectOsSandbox } from './os-sandbox.ts'
import { capOutput, type ShellOptions, type ShellTaskEvent, shell } from './plugin.ts'
import { type LocalSandbox, localSandbox, type Sandbox } from './sandbox-local.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await sleep(10)
  }
}

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'eh-shell-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A tool the test uses to wait between steps. */
const waiter = definePlugin({
  name: 'waiter',
  setup: () => ({
    tools: {
      wait: tool({
        description: 'wait',
        inputSchema: z.object({ ms: z.number() }),
        execute: async ({ ms }) => {
          await sleep(ms)
          return 'waited'
        },
      }),
    },
  }),
})

type Call = { toolName: string; input: unknown }
const call = (toolName: string, input: unknown): { toolCalls: Call[] } => ({
  toolCalls: [{ toolName, input }],
})

/** Tool outputs by tool name, in order. */
async function outputs(
  session: { messages(): Promise<unknown[]> },
  name: string,
): Promise<string[]> {
  const out: string[] = []
  for (const m of (await session.messages()) as Array<{ parts: Array<Record<string, unknown>> }>) {
    for (const p of m.parts) {
      if (p.type === `tool-${name}` && p.state === 'output-available') out.push(p.output as string)
    }
  }
  return out
}

function agentWith(steps: ScriptedStep[], opts: ShellOptions) {
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    logger: silent,
    plugins: [shell(opts), waiter],
  })
  return { agent, model }
}

/** Run `input` through the bash tool and return its result text. */
async function exec(opts: ShellOptions, input: Record<string, unknown>): Promise<string> {
  const { agent } = agentWith([call('bash', input), { text: 'done' }], opts)
  const session = agent.session('s')
  const run = session.send('go')
  await run.result
  const [out] = await outputs(session, 'bash')
  await session.close()
  return out ?? 'NO OUTPUT'
}

describe('bash tool', () => {
  test('success footer and output; only a footer without output', async () => {
    const sandbox = localSandbox(await temp())
    expect(await exec({ sandbox }, { command: 'echo hi' })).toMatch(/^hi\nExit code 0 · \d+\.\ds$/)
    expect(await exec({ sandbox }, { command: 'true' })).toMatch(/^Exit code 0 · \d+\.\ds$/)
  })

  test('non-zero exit is a string, stderr is included', async () => {
    const sandbox = localSandbox(await temp())
    expect(await exec({ sandbox }, { command: 'echo bad 1>&2; exit 7' })).toMatch(
      /^bad\nExit code 7 · /,
    )
  })

  test('timeout kills the command and reports it', async () => {
    const sandbox = localSandbox(await temp())
    const started = Date.now()
    const out = await exec({ sandbox }, { command: 'echo start; sleep 30', timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(out).toStartWith('start\n')
    expect(out).toMatch(/\(timed out after \d+s\)$/)
  })

  test('the model timeout is capped by maxTimeoutMs', async () => {
    const sandbox = localSandbox(await temp())
    const out = await exec(
      { sandbox, maxTimeoutMs: 200, timeoutMs: 100 },
      { command: 'sleep 30', timeoutMs: 600_000 },
    )
    expect(out).toMatch(/\(timed out after 0s\)$/)
  })

  test('long output is capped to head and tail with a marker', async () => {
    const sandbox = localSandbox(await temp())
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

  test('the sandbox can be built per session from ctx', async () => {
    const root = await temp()
    const seen: string[] = []
    const out = await exec(
      {
        sandbox: (ctx) => {
          seen.push(ctx.session.id)
          return localSandbox(root)
        },
      },
      { command: 'pwd' },
    )
    expect(seen).toEqual(['s'])
    expect(out).toStartWith(`${root}\n`)
  })

  test('toolName and risk are configurable; the default risk is external', async () => {
    const sandbox = localSandbox(await temp())
    const external = agentWith([{ text: 'x' }], { sandbox })
    const tools = await external.agent.session('a').tools()
    expect(tools.map((t) => t.name)).toEqual(['bash', 'wait'])
    const renamed = agentWith([{ text: 'x' }], { sandbox, toolName: 'sh', background: true })
    expect((await renamed.agent.session('a').tools()).map((t) => t.name)).toEqual([
      'sh',
      'bash_output',
      'kill_shell',
      'wait',
    ])
  })

  test('risk: external by default, overridable; bash_output is read, kill_shell write', async () => {
    const seen: Array<[string, unknown]> = []
    const spy = definePlugin({
      name: 'spy',
      setup: () => ({
        hooks: {
          'tool.approve': (_c, e) => {
            seen.push([e.toolName, e.risk])
            return 'approved'
          },
        },
      }),
    })
    for (const risk of [undefined, 'write' as const]) {
      seen.length = 0
      const model = scriptedModel([
        { toolCalls: [{ toolName: 'bash', input: { command: 'true', run_in_background: true } }] },
        call('bash_output', { id: 'bash-1' }),
        call('kill_shell', { id: 'bash-1' }),
        { text: 'x' },
      ])
      const agent = defineHarnessAgent({
        model,
        logger: silent,
        plugins: [shell({ sandbox: localSandbox(await temp()), background: true, risk }), spy],
      })
      const session = agent.session('s')
      await session.send('go').result
      expect(seen).toEqual([
        ['bash', risk ?? 'external'],
        ['bash_output', 'read'],
        ['kill_shell', 'write'],
      ])
      await session.close()
    }
  })

  test('foreground-only: the schema has no background fields', async () => {
    const sandbox = localSandbox(await temp())
    const { agent } = agentWith([{ text: 'x' }], { sandbox })
    const info = (await agent.session('a').tools()).find((t) => t.name === 'bash')
    expect(JSON.stringify(info?.inputSchema)).not.toContain('run_in_background')
    expect(info?.description).not.toContain('Background mode')
  })

  test('streams transient data-shell.output chunks', async () => {
    const sandbox = localSandbox(await temp())
    const { agent } = agentWith(
      [
        {
          toolCalls: [
            { toolName: 'bash', toolCallId: 'c9', input: { command: 'echo a; echo b 1>&2' } },
          ],
        },
        { text: 'ok' },
      ],
      { sandbox },
    )
    const session = agent.session('s')
    const run = session.send('go')
    const chunks: UIMessageChunk[] = []
    const reader = run.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const parts = chunks.filter((c) => c.type === 'data-shell.output') as Array<{
      data: unknown
      transient?: boolean
    }>
    expect(parts.map((p) => p.data)).toContainEqual({
      toolCallId: 'c9',
      stream: 'stdout',
      chunk: 'a\n',
    })
    expect(parts.map((p) => p.data)).toContainEqual({
      toolCallId: 'c9',
      stream: 'stderr',
      chunk: 'b\n',
    })
    expect(parts.every((p) => p.transient === true)).toBe(true)
    // never persisted
    const stored = JSON.stringify(await session.messages())
    expect(stored).not.toContain('data-shell.output')
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

describe.skipIf(detectOsSandbox().kind === 'none')('OS sandbox through the tool', () => {
  test('a denied write gets the sandbox hint, a fine command does not', async () => {
    const sandbox: LocalSandbox = localSandbox(await temp(), { os: { enabled: true } })
    const denied = await exec(
      { sandbox },
      { command: `echo x > '${join(homedir(), 'eh-sandbox-hint.txt')}'` },
    )
    expect(denied).toContain('writes outside the project and network access are blocked')
    expect(await exec({ sandbox }, { command: 'echo fine' })).not.toContain('OS sandbox')
  })
})

describe('background tasks', () => {
  const bgOpts = async (extra: Partial<ShellOptions> = {}): Promise<ShellOptions> => ({
    sandbox: localSandbox(await temp()),
    background: { monitorIntervalMs: 300 },
    ...extra,
  })

  test('run_in_background returns at once; bash_output reads it; the exit reaches the model through the default ctx.session.inject', async () => {
    const opts = await bgOpts()
    const { agent, model } = agentWith(
      [
        call('bash', {
          command: 'echo first; sleep 0.3; echo second; exit 3',
          description: 'demo',
          run_in_background: true,
        }),
        call('wait', { ms: 800 }),
        call('bash_output', { id: 'bash-1' }),
        call('bash_output', { id: 'bash-1' }),
        { text: 'done' },
      ],
      opts,
    )
    const session = agent.session('s')
    const run = session.send('go')
    await run.result
    expect((await outputs(session, 'bash'))[0]).toBe(
      'Started background task bash-1. Use bash_output to read its output.',
    )
    const reads = await outputs(session, 'bash_output')
    expect(reads[0]).toContain('[bash-1: failed, exit code 3]')
    expect(reads[0]).toContain('first\nsecond')
    expect(reads[1]).toContain('(no new output)')
    // the exit notice reached the model as a step reminder
    expect(JSON.stringify(model.prompts[2])).toContain(
      'Background task bash-1 (echo first; sleep 0.3; echo second; exit 3) exited with code 3.',
    )
    await session.close()
  })

  test('the shellTasks service lists, outputs and subscribes', async () => {
    const opts = await bgOpts()
    let tasks: import('./tasks.ts').ShellTasks | undefined
    const probe = definePlugin({
      name: 'probe',
      requires: ['shellTasks'],
      setup: () => ({
        hooks: {
          'step.prepare': (ctx) => {
            tasks = ctx.services.shellTasks
          },
        },
      }),
    })
    const model = scriptedModel([
      call('bash', { command: 'echo svc; sleep 30', description: 'svc', run_in_background: true }),
      call('wait', { ms: 300 }),
      { text: 'done' },
    ])
    const agent = defineHarnessAgent({
      model,
      logger: silent,
      plugins: [shell(opts), probe, waiter],
    })
    const session = agent.session('s')
    await session.send('go').result
    const seen: string[] = []
    const off = tasks?.subscribe((l) => seen.push(l.map((t) => t.status).join()))
    expect(tasks?.list()).toMatchObject([{ id: 'bash-1', label: 'svc', status: 'running' }])
    expect(tasks?.output('bash-1')).toBe('svc\n')
    await tasks?.stop('bash-1')
    expect(tasks?.get('bash-1')?.status).toBe('stopped')
    expect(seen.at(-1)).toBe('stopped')
    off?.()
    await session.close()
  })

  test('bash_output filter and unknown ids; invalid regexes are errors', async () => {
    const opts = await bgOpts()
    const { agent } = agentWith(
      [
        call('bash', { command: 'printf "a1\\nb2\\na3\\n"', run_in_background: true }),
        call('wait', { ms: 300 }),
        call('bash_output', { id: 'bash-1', filter: '^a' }),
        call('bash_output', { id: 'bash-9' }),
        call('bash_output', { id: 'bash-1', filter: '(' }),
        call('bash', { command: 'echo x', run_in_background: true, notify_on: '(' }),
        { text: 'done' },
      ],
      opts,
    )
    const session = agent.session('s')
    await session.send('go').result
    const reads = await outputs(session, 'bash_output')
    expect(reads[0]).toContain('a1\na3')
    expect(reads[0]).not.toContain('b2')
    expect(reads[1]).toContain('ERROR: no background task "bash-9". Known: bash-1')
    expect(reads[2]).toContain('not a valid regular expression')
    expect((await outputs(session, 'bash'))[1]).toContain('ERROR: notify_on')
    await session.close()
  })

  test('kill_shell stops the process and sends no exit event', async () => {
    const events: ShellTaskEvent[] = []
    const opts = await bgOpts({ onTaskEvent: (e) => void events.push(e) })
    const { agent } = agentWith(
      [
        call('bash', { command: 'sleep 30', run_in_background: true }),
        call('kill_shell', { id: 'bash-1' }),
        call('kill_shell', { id: 'bash-1' }),
        call('kill_shell', { id: 'nope' }),
        { text: 'done' },
      ],
      opts,
    )
    const session = agent.session('s')
    await session.send('go').result
    const kills = await outputs(session, 'kill_shell')
    expect(kills[0]).toBe('Stopped bash-1.')
    expect(kills[1]).toContain('not running (stopped)')
    expect(kills[2]).toContain('ERROR')
    await sleep(300)
    expect(events).toEqual([])
    await session.close()
  })

  test('maxTasks limits concurrent background tasks', async () => {
    const opts = await bgOpts({ background: { maxTasks: 1 } })
    const { agent } = agentWith(
      [
        call('bash', { command: 'sleep 30', run_in_background: true }),
        call('bash', { command: 'sleep 30', run_in_background: true }),
        { text: 'done' },
      ],
      opts,
    )
    const session = agent.session('s')
    await session.send('go').result
    expect((await outputs(session, 'bash'))[1]).toContain(
      'ERROR: 1 background tasks are already running',
    )
    await session.close() // dispose stops the running task
  })

  test('notify_on: matching lines are batched and rate-limited', async () => {
    const events: ShellTaskEvent[] = []
    const opts = await bgOpts({ onTaskEvent: (e) => void events.push(e) })
    const { agent } = agentWith(
      [
        call('bash', {
          command:
            'for i in 1 2 3 4 5; do echo "hit $i"; echo "noise $i"; sleep 0.02; done; sleep 0.1',
          run_in_background: true,
          notify_on: '^hit',
        }),
        { text: 'started' },
      ],
      opts,
    )
    const session = agent.session('s')
    await session.send('go').result
    await until(() => events.some((e) => e.type === 'exit'))
    const matches = events.filter((e) => e.type === 'match')
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches.length).toBeLessThanOrEqual(2)
    const all = matches.map((e) => e.payload.text).join('\n')
    for (const n of [1, 2, 3, 4, 5]) expect(all).toContain(`hit ${n}`)
    expect(all).not.toContain('noise 1')
    expect(events.at(-1)?.payload.text).toContain('exited with code 0')
    for (const e of events) {
      expect(e.sessionId).toBe('s')
      expect(e.options).toEqual({ deliver: 'next-step', wake: true })
    }
    await session.close()
  })

  test("notify: 'next-step' does not wake; notify: false sends nothing", async () => {
    const quiet: ShellTaskEvent[] = []
    for (const [notify, expected] of [
      ['next-step', false],
      [false, undefined],
    ] as const) {
      quiet.length = 0
      const opts = await bgOpts({ background: { notify }, onTaskEvent: (e) => void quiet.push(e) })
      const { agent } = agentWith(
        [call('bash', { command: 'true', run_in_background: true }), { text: 'x' }],
        opts,
      )
      const session = agent.session('s')
      await session.send('go').result
      await sleep(400)
      if (expected === undefined) expect(quiet).toEqual([])
      else expect(quiet.map((e) => e.options)).toEqual([{ deliver: 'next-step' }])
      await session.close()
    }
  })

  test('wake: the exit reaches an idle session through session.inject and starts a turn', async () => {
    const root = await temp()
    const model = scriptedModel([
      call('bash', {
        command: 'sleep 0.2; echo built',
        description: 'build',
        run_in_background: true,
      }),
      { text: 'Started the build.' },
      { text: 'The build finished.' },
    ])
    let session: unknown
    const woken: Array<Promise<unknown>> = []
    const agent = defineHarnessAgent({
      model,
      logger: silent,
      plugins: [
        shell({
          sandbox: localSandbox(root),
          background: true,
          onTaskEvent: async (e) => {
            const out = await (
              session as never as {
                inject(...a: unknown[]): Promise<{ run?: { result: Promise<unknown> } }>
              }
            ).inject('eh.event', e.payload, e.options)
            if (out.run) woken.push(out.run.result)
          },
        }),
      ],
    })
    session = agent.session('s') as never
    await (session as never as { send(i: string): { result: Promise<unknown> } }).send('build it')
      .result
    await until(() => woken.length > 0)
    const result = (await woken[0]) as { stop: string }
    expect(result.stop).toBe('complete')
    expect(model.prompts).toHaveLength(3)
    expect(JSON.stringify(model.prompts[2])).toContain('event name')
    expect(JSON.stringify(model.prompts[2])).toContain('exited with code 0')
    await (session as never as { close(): Promise<void> }).close()
  })
})
