import { describe, expect, test } from 'bun:test'
import {
  BASH_OUTPUT_TOOL,
  createBackgroundBashTools,
  KILL_SHELL_TOOL,
  withBackgroundOption,
} from '../src/app/background-bash.ts'
import { createTaskManager, MAX_TASK_OUTPUT, type TaskInject } from '../src/app/tasks.ts'
import { createBashTool, createLocalSandbox } from '../src/shell/index.ts'
import { tempDir } from './helpers.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await sleep(10)
  }
}

describe('task manager', () => {
  test('ids, status, listeners, stop', async () => {
    const tasks = createTaskManager()
    const seen: string[][] = []
    const off = tasks.onTasks((list) => seen.push(list.map((t) => `${t.id}:${t.status}`)))
    let stopped = 0
    const a = tasks.add({ kind: 'shell', label: 'a', stop: () => void stopped++ })
    const b = tasks.add({ kind: 'agent', label: 'b', stop: () => {} })
    const c = tasks.add({ kind: 'shell', label: 'c', stop: () => {} })
    expect([a, b, c]).toEqual(['bash-1', 'agent-1', 'bash-2'])
    await tasks.stopTask(a)
    expect(stopped).toBe(1)
    expect(tasks.get(a)?.status).toBe('stopped')
    // the producer's own completion does not overwrite `stopped`
    tasks.complete(a, { status: 'failed', exitCode: 143 })
    expect(tasks.get(a)?.status).toBe('stopped')
    tasks.complete(b, { status: 'completed', exitCode: 0 })
    expect(tasks.get(b)).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(tasks.get(b)?.endedAt).toBeGreaterThan(0)
    expect(seen.at(-1)).toEqual(['bash-1:stopped', 'agent-1:completed', 'bash-2:running'])
    off()
    const before = seen.length
    tasks.complete(c, { status: 'completed' })
    expect(seen.length).toBe(before)
    await tasks.stopTask('nope')
  })

  test('output: tail, readNew cursor, 1 MB cap', async () => {
    const tasks = createTaskManager()
    const id = tasks.add({ kind: 'shell', label: 'x', stop: () => {} })
    tasks.append(id, 'one\ntwo\n')
    expect(tasks.readNew(id)).toBe('one\ntwo\n')
    expect(tasks.readNew(id)).toBe('')
    tasks.append(id, 'three\n')
    expect(tasks.readNew(id)).toBe('three\n')
    expect(tasks.taskOutput(id)).toBe('one\ntwo\nthree\n')
    expect(tasks.get(id)?.tail).toContain('three')
    const big = 'x'.repeat(MAX_TASK_OUTPUT)
    tasks.append(id, big)
    tasks.append(id, 'END')
    expect(tasks.taskOutput(id).length).toBe(MAX_TASK_OUTPUT)
    expect(tasks.taskOutput(id).endsWith('END')).toBe(true)
    expect(tasks.readNew(id)).toContain('dropped')
    expect(tasks.readNew('missing')).toBeUndefined()
  })

  test('agent tail via update', () => {
    const tasks = createTaskManager()
    const id = tasks.add({ kind: 'agent', label: 'x', stop: () => {} })
    tasks.update(id, { tail: 'thinking…' })
    expect(tasks.get(id)?.tail).toBe('thinking…')
    expect(tasks.taskOutput(id)).toBe('thinking…')
  })
})

interface Event {
  sessionId: string
  text: string
  options: { deliver?: string; wake?: boolean }
}

async function harness(monitorIntervalMs = 5000) {
  const root = await tempDir()
  const sandbox = createLocalSandbox(root)
  const tasks = createTaskManager()
  const events: Event[] = []
  const inject: TaskInject = async (sessionId, event, options) => {
    events.push({ sessionId, text: event.text, options })
    return undefined
  }
  const deps = { sandbox, tasks, inject, monitorIntervalMs }
  const bash = withBackgroundOption(createBashTool({ sandbox }) as never, deps)
  const tool = (
    bash as unknown as (ctx: unknown) => {
      description: string
      inputSchema: { safeParse(v: unknown): { success: boolean } }
      execute: (i: unknown, o: unknown) => Promise<string>
    }
  )({ session: { id: 'sess-1' }, stream: { active: false } })
  const run = (input: Record<string, unknown>): Promise<string> =>
    tool.execute(input, { toolCallId: 'c1', abortSignal: undefined, messages: [] })
  const { tools } = createBackgroundBashTools(deps)
  const side = (name: string) =>
    (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute
  const output = (input: Record<string, unknown>): Promise<string> =>
    side(BASH_OUTPUT_TOOL)(input, { toolCallId: 'c2', messages: [] })
  const kill = (input: Record<string, unknown>): Promise<string> =>
    side(KILL_SHELL_TOOL)(input, { toolCallId: 'c3', messages: [] })
  return { tool, run, output, kill, tasks, events }
}

describe('background bash', () => {
  test('foreground behaviour is unchanged; the schema gains the new fields', async () => {
    const h = await harness()
    expect(await h.run({ command: 'echo hi' })).toContain('Exit code 0')
    expect(h.tool.description).toContain('run_in_background')
    expect(
      h.tool.inputSchema.safeParse({ command: 'x', run_in_background: true, notify_on: 'a' })
        .success,
    ).toBe(true)
    expect(h.tasks.tasks()).toEqual([])
  })

  test('run_in_background returns at once, output is readable, exit is injected', async () => {
    const h = await harness()
    const started = Date.now()
    const text = await h.run({
      command: 'echo first; sleep 0.3; echo second; exit 3',
      description: 'demo',
      run_in_background: true,
    })
    expect(Date.now() - started).toBeLessThan(250)
    expect(text).toBe('Started background task bash-1. Use bash_output to read its output.')
    expect(h.tasks.get('bash-1')?.label).toBe('demo')
    await until(() => h.tasks.get('bash-1')?.status !== 'running')
    expect(h.tasks.get('bash-1')).toMatchObject({ status: 'failed', exitCode: 3 })
    const out = await h.output({ id: 'bash-1' })
    expect(out).toContain('[bash-1: failed, exit code 3]')
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(await h.output({ id: 'bash-1' })).toContain('(no new output)')
    await until(() => h.events.length > 0)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]?.sessionId).toBe('sess-1')
    expect(h.events[0]?.text).toBe(
      'Background task bash-1 (echo first; sleep 0.3; echo second; exit 3) exited with code 3.',
    )
    expect(h.events[0]?.options).toEqual({ deliver: 'next-step', wake: true })
  })

  test('bash_output filter and unknown ids', async () => {
    const h = await harness()
    await h.run({ command: 'printf "a1\\nb2\\na3\\n"', run_in_background: true })
    await until(() => h.tasks.get('bash-1')?.status === 'completed')
    const out = await h.output({ id: 'bash-1', filter: '^a' })
    expect(out).toContain('a1\na3')
    expect(out).not.toContain('b2')
    expect(await h.output({ id: 'bash-9' })).toContain('ERROR: no background task "bash-9"')
    expect(await h.output({ id: 'bash-1', filter: '(' })).toContain(
      'not a valid regular expression',
    )
  })

  test('kill_shell stops the process and sends no exit event', async () => {
    const h = await harness()
    await h.run({ command: 'sleep 30', run_in_background: true })
    expect(h.tasks.get('bash-1')?.status).toBe('running')
    expect(await h.kill({ id: 'bash-1' })).toBe('Stopped bash-1.')
    expect(h.tasks.get('bash-1')?.status).toBe('stopped')
    await sleep(300)
    expect(h.events).toEqual([])
    expect(await h.kill({ id: 'bash-1' })).toContain('not running')
    expect(await h.kill({ id: 'nope' })).toContain('ERROR')
  })

  test('notify_on: matching lines are batched and rate-limited', async () => {
    const h = await harness(400)
    await h.run({
      command: 'for i in 1 2 3 4 5; do echo "hit $i"; echo "noise $i"; sleep 0.02; done; sleep 0.1',
      run_in_background: true,
      notify_on: '^hit',
    })
    await until(() => h.events.some((e) => e.text.includes('exited')))
    const matches = h.events.filter((e) => e.text.includes('matching'))
    // first match goes out at once, the rest is batched (and flushed at exit): never one per line
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(matches.length).toBeLessThanOrEqual(2)
    const all = matches.map((e) => e.text).join('\n')
    for (const n of [1, 2, 3, 4, 5]) expect(all).toContain(`hit ${n}`)
    expect(all).not.toContain('noise 1')
    expect(h.events.at(-1)?.text).toContain('exited with code 0')
    for (const e of h.events) expect(e.options).toEqual({ deliver: 'next-step', wake: true })
  })

  test('an invalid notify_on is an error string, nothing starts', async () => {
    const h = await harness()
    const text = await h.run({ command: 'echo x', run_in_background: true, notify_on: '(' })
    expect(text).toContain('ERROR: notify_on')
    expect(h.tasks.tasks()).toEqual([])
  })

  test('onWake receives the run of a woken idle session', async () => {
    const root = await tempDir()
    const tasks = createTaskManager()
    const fakeRun = { turnId: 'w' } as never
    const woken: unknown[] = []
    const deps = {
      sandbox: createLocalSandbox(root),
      tasks,
      inject: (async () => ({ run: fakeRun })) as TaskInject,
      onWake: (run: unknown) => woken.push(run),
    }
    const bash = withBackgroundOption(createBashTool({ sandbox: deps.sandbox }) as never, deps)
    const tool = (
      bash as unknown as (c: unknown) => { execute: (i: unknown, o: unknown) => Promise<string> }
    )({
      session: { id: 's' },
      stream: { active: false },
    })
    await tool.execute(
      { command: 'true', run_in_background: true },
      { toolCallId: 'c', messages: [] },
    )
    await until(() => woken.length > 0)
    expect(woken).toEqual([fakeRun])
  })
})
