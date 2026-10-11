/**
 * Durable background subagents in `approvals: 'park'` mode (ADR-0046): the child starts through
 * its durable inbox, the parent's call is answered at once, the report comes back through
 * storage from whichever instance finishes the child. Two agent instances over shared storage
 * stand for two processes.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, type HarnessAgent, type HarnessUIMessage } from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { type ScriptedModel, scriptedModel } from '../testing/scripted-model.ts'
import { sleep, until } from '../testing/test-utils.ts'
import { pendingSubagentApprovals, type SubagentOptions, subagent } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

type Steps = Parameters<typeof scriptedModel>[0]
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const newStorage = () => ({
  messages: inMemoryMessages(),
  state: inMemoryState(),
  inbox: inMemoryInbox(),
})
type Storage = ReturnType<typeof newStorage>

const spawn = (toolCallId: string, extra: Record<string, unknown> = {}) => ({
  toolName: 'agent',
  toolCallId,
  input: {
    subagent_type: 'worker',
    description: 'review',
    prompt: 'review the change',
    name: 'reviewer',
    run_in_background: true,
    ...extra,
  },
})

const danger = tool({
  description: 'dangerous',
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => `did ${what}`,
})

function gate() {
  let release!: () => void
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const hasStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const gated = tool({
    inputSchema: z.object({}),
    execute: async () => {
      started()
      await open
      return 'gate open'
    },
  })
  return { gated, release, hasStarted }
}

function process_(
  storage: Storage,
  opts: {
    main: Steps
    worker: Steps
    approve?: boolean
    tools?: Record<string, unknown>
    mainOptions?: Partial<SubagentOptions>
    /** Options of the worker's own (child side) plugin. */
    workerOptions?: Partial<SubagentOptions>
    mainTools?: Record<string, unknown>
    /** The worker agent of this process cannot claim inbox items (it "died" before running them). */
    deadWorker?: boolean
  },
): { main: Agent; worker: Agent; mainModel: ScriptedModel; workerModel: ScriptedModel } {
  const holder: { main?: Agent; worker?: Agent } = {}
  const mainModel = scriptedModel(opts.main)
  const workerModel = scriptedModel(opts.worker)
  const worker = defineHarnessAgent({
    model: workerModel,
    contextWindow: 100_000,
    storage:
      opts.deadWorker === true
        ? { ...storage, inbox: { ...storage.inbox, claim: async () => [] } }
        : storage,
    logger: silent,
    inbox: { pollMs: 20 },
    tools: { danger, ...opts.tools } as never,
    ...(opts.approve === true ? { approval: { policy: { danger: 'user-approval' } } } : {}),
    plugins: [
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.main as Agent,
        selfAgent: () => holder.worker as Agent,
        ...opts.workerOptions,
      }),
    ] as never,
  }) as Agent
  holder.worker = worker
  const main = defineHarnessAgent({
    model: mainModel,
    contextWindow: 100_000,
    storage,
    logger: silent,
    inbox: { pollMs: 20 },
    ...(opts.mainTools === undefined ? {} : { tools: opts.mainTools as never }),
    plugins: [
      subagent({
        agents: { worker: { agent: worker, description: 'does work' } },
        approvals: 'park',
        background: true,
        selfAgent: () => holder.main as Agent,
        ...opts.mainOptions,
      }),
    ] as never,
  }) as Agent
  holder.main = main
  return { main, worker, mainModel, workerModel }
}

const dump = async (agent: Agent, id: string): Promise<string> =>
  JSON.stringify(await agent.session(id).messages())

type Part = { type: string; output?: unknown; data?: unknown }
const partsOf = (messages: HarnessUIMessage[], type: string): Part[] =>
  messages.flatMap((m) => (m.parts as Part[]).filter((p) => p.type === type))

describe("background subagents with approvals: 'park' (ADR-0046)", () => {
  test('the call is answered at once, a user message is not cancelled, B answers the child, the report wakes the parent', async () => {
    const storage = newStorage()
    const trailing = [{ text: 'chat answer' }, { text: 'I saw the report' }]
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1')] }, { text: 'delegated' }, ...trailing],
      worker: [{ toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] }],
      approve: true,
    })
    const first = await a.main.session('p1').send('go').result
    expect(first.stop).toBe('tool-pending')
    await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))

    const messages = (await a.main.session('p1').messages()) as HarnessUIMessage[]
    const outputs = partsOf(messages, 'tool-agent').map((p) => String(p.output))
    expect(outputs[0]).toContain('Started background subagent p1:agent:c1 "reviewer" (worker)')
    // the marker carries the child session id
    const markers = partsOf(messages, 'data-subagent.run').map((p) => p.data)
    expect(markers).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        sessionId: 'p1:agent:c1',
        agent: 'worker',
        name: 'reviewer',
        background: true,
      }),
    ])
    // the child is linked and holds its own approval
    expect((await a.main.session('p1').children()).map((c) => c.sessionId)).toEqual(['p1:agent:c1'])
    await until('child pending', async () => {
      const found = await pendingSubagentApprovals(a.main.session('p1'), a.worker)
      return found.length === 1
    })

    // a user message while the child waits: answered normally, nothing is cancelled
    const chat = await a.main.session('p1').send('how is it going?').result
    expect(chat.stop).toBe('complete')
    expect(await dump(a.main, 'p1')).not.toContain('Cancelled')

    // instance B answers the child's approval; its report wakes the parent
    const b = process_(storage, {
      main: [{ text: 'I saw the report' }],
      worker: [{ text: 'first report' }],
      approve: true,
    })
    const found = await pendingSubagentApprovals(b.main.session('p1'), b.worker)
    const approvalId = found[0]?.pending.approvals[0]?.approvalId as string
    const childRun = b.worker
      .session('p1:agent:c1')
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await childRun.result).stop).toBe('complete')

    await until('report event', async () =>
      (await dump(b.main, 'p1')).includes('Background subagent p1:agent:c1 \\"reviewer\\"'),
    )
    await until('parent woke', async () => (await dump(b.main, 'p1')).includes('I saw the report'))
    const all = (await b.main.session('p1').messages()) as HarnessUIMessage[]
    const events = partsOf(all, 'data-eh.event').map(
      (p) => p.data as { name: string; text: string; data: unknown },
    )
    const report = events.find((e) => e.text.includes('finished'))
    expect(report?.name).toBe('subagent')
    expect(report?.text).toContain('first report')
    expect(report?.data).toMatchObject({
      sessionId: 'p1:agent:c1',
      agent: 'worker',
      status: 'completed',
      name: 'reviewer',
    })
    await Promise.all([a.main.close(), a.worker.close(), b.main.close(), b.worker.close()])
  })

  test('an instance that cannot run the child hands it over: B drains the inbox, runs it and the report arrives', async () => {
    const storage = newStorage()
    // instance A cannot run the child (its worker never claims the inbox item)
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1')] }, { text: 'delegated' }],
      worker: [{ text: 'never used' }],
      deadWorker: true,
    })
    await a.main.session('p1').send('go').result
    await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))
    await sleep(100)
    expect(await dump(a.worker, 'p1:agent:c1')).not.toContain('never used')
    await Promise.all([a.main.close(), a.worker.close()])

    const b = process_(storage, {
      main: [{ text: 'I saw the report' }],
      worker: [{ text: 'recovered report' }],
    })
    // a sweeper opens the child, which drains what is left in its inbox
    b.worker.session('p1:agent:c1')
    await until('report delivered', async () =>
      (await dump(b.main, 'p1')).includes('recovered report'),
    )
    await until('parent woke', async () => (await dump(b.main, 'p1')).includes('I saw the report'))
    await Promise.all([b.main.close(), b.worker.close()])
  })

  test('an instance closed mid-turn: the parent is told the child was stopped', async () => {
    const storage = newStorage()
    const g = gate()
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1')] }, { text: 'delegated' }],
      worker: [{ toolCalls: [{ toolName: 'gated', input: {} }] }],
      tools: { gated: g.gated },
    })
    await a.main.session('p1').send('go').result
    await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))
    await g.hasStarted
    const b = process_(storage, { main: [{ text: 'I saw the report' }], worker: [] })
    await a.worker.close()
    g.release()
    await until('stopped report', async () => (await dump(b.main, 'p1')).includes('was stopped'))
    await Promise.all([a.main.close(), b.main.close(), b.worker.close()])
  })

  test('agent_output and agent_stop work on a durable background child', async () => {
    const storage = newStorage()
    const g = gate()
    const a = process_(storage, {
      main: [
        { toolCalls: [spawn('c1')] },
        { text: 'delegated' },
        {
          toolCalls: [
            { toolName: 'agent_output', input: { id: 'reviewer' } },
            { toolName: 'agent_stop', input: { id: 'reviewer' } },
          ],
        },
        { text: 'stopped it' },
        { text: 'saw the stop report' },
      ],
      worker: [{ toolCalls: [{ toolName: 'gated', input: {} }] }],
      tools: { gated: g.gated },
    })
    await a.main.session('p1').send('go').result
    await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))
    await g.hasStarted
    const run = await a.main.session('p1').send('stop the reviewer').result
    expect(run.stop).toBe('complete')
    const messages = (await a.main.session('p1').messages()) as HarnessUIMessage[]
    expect(partsOf(messages, 'tool-agent_output').map((p) => String(p.output))[0]).toContain(
      'is still running',
    )
    expect(partsOf(messages, 'tool-agent_stop').map((p) => String(p.output))[0]).toContain(
      'Stopped reviewer',
    )
    g.release()
    await until('stop report', async () => (await dump(a.main, 'p1')).includes('was stopped'))
    await Promise.all([a.main.close(), a.worker.close()])
  })

  test('a background child is bounded by default: a timer reports the timeout and stops it', async () => {
    const storage = newStorage()
    const g = gate()
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1')] }, { text: 'delegated' }, { text: 'saw the timeout' }],
      worker: [{ toolCalls: [{ toolName: 'gated', input: {} }] }],
      tools: { gated: g.gated },
      // no stopOnTimeout / reconcileEveryMs: both come from the defaults
      mainOptions: { background: { timeoutMs: 1000 } },
    })
    await a.main.session('p1').send('go').result
    await g.hasStarted
    await until('timed out report', async () => /timed out/i.test(await dump(a.main, 'p1')), 10_000)
    g.release()
    await Promise.all([a.main.close(), a.worker.close()])
  }, 20_000)

  test('without run_in_background the call still parks (foreground)', async () => {
    const storage = newStorage()
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1', { run_in_background: false })] }, { text: 'done' }],
      worker: [{ text: 'the report' }],
    })
    const run = await a.main.session('p1').send('go').result
    expect(['tool-pending', 'complete']).toContain(run.stop)
    await until('foreground result', async () => (await dump(a.main, 'p1')).includes('the report'))
    expect(await dump(a.main, 'p1')).not.toContain('Started background')
    await Promise.all([a.main.close(), a.worker.close()])
  })

  test('background.default makes an omitted run_in_background a background start', async () => {
    const storage = newStorage()
    const a = process_(storage, {
      main: [
        {
          toolCalls: [
            { ...spawn('c1'), input: { ...spawn('c1').input, run_in_background: undefined } },
          ],
        },
        { text: 'delegated' },
        { text: 'saw it' },
      ],
      worker: [{ text: 'quick report' }],
      mainOptions: { background: { default: true } },
    })
    await a.main.session('p1').send('go').result
    await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))
    expect(await dump(a.main, 'p1')).toContain('Started background subagent')
    await until('report', async () => (await dump(a.main, 'p1')).includes('quick report'))
    await Promise.all([a.main.close(), a.worker.close()])
  })
})

describe('orphaned foreground parks (ADR-0046 amendment)', () => {
  test('a user message cancels the parent wait, the child finishes later: the lead is told and woken', async () => {
    const storage = newStorage()
    const a = process_(storage, {
      main: [
        { toolCalls: [spawn('c1', { run_in_background: false })] },
        { text: 'chat answer' },
        { text: 'I saw the late report' },
      ],
      worker: [{ toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] }],
      approve: true,
    })
    const first = await a.main.session('p1').send('go').result
    expect(first.stop).toBe('tool-pending')
    const chat = await a.main.session('p1').send('never mind, chat').result
    expect(chat.stop).toBe('complete')
    expect(await dump(a.main, 'p1')).toContain('Cancelled: the user sent a new message')
    const b = process_(storage, {
      main: [{ text: 'I saw the late report' }],
      worker: [{ text: 'late report' }],
      approve: true,
    })
    const found = await pendingSubagentApprovals(b.main.session('p1'), b.worker)
    const approvalId = found[0]?.pending.approvals[0]?.approvalId as string
    const childRun = b.worker
      .session('p1:agent:c1')
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await childRun.result).stop).toBe('complete')
    await until('late report', async () =>
      (await dump(b.main, 'p1')).includes('after its call was cancelled'),
    )
    await until('parent woke', async () =>
      (await dump(b.main, 'p1')).includes('I saw the late report'),
    )
    const all = (await b.main.session('p1').messages()) as HarnessUIMessage[]
    const events = partsOf(all, 'data-eh.event').map(
      (p) => p.data as { name: string; text: string; data: unknown },
    )
    const reports = events.filter((e) => e.text.includes('late report'))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.data).toMatchObject({
      sessionId: 'p1:agent:c1',
      status: 'completed',
      taskId: 'p1:agent:c1',
    })
    await Promise.all([a.main.close(), a.worker.close(), b.main.close(), b.worker.close()])
  })

  test('a normally resolved foreground park sends no extra event', async () => {
    const storage = newStorage()
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('c1', { run_in_background: false })] }, { text: 'done' }],
      worker: [{ text: 'the report' }],
    })
    await a.main.session('p1').send('go').result
    await until('result', async () => (await dump(a.main, 'p1')).includes('done'))
    await sleep(100)
    const all = (await a.main.session('p1').messages()) as HarnessUIMessage[]
    expect(partsOf(all, 'data-eh.event')).toHaveLength(0)
    await Promise.all([a.main.close(), a.worker.close()])
  })

  describe('onPark: the notice that a child waits for the user', () => {
    /**
     * The lead is still answering ("delegated", a slow model call) when its child parks on an
     * approval. The parked notice is stored in both modes; only the default hands it to the
     * running turn at its next step, which costs one more model call.
     */
    async function run(onPark: 'step' | 'notice' | undefined) {
      const storage = newStorage()
      const a = process_(storage, {
        main: [
          { toolCalls: [spawn('c1')] },
          { text: 'delegated', delayMs: 400 },
          // the default delivers the notice to the running turn: one more step before it ends
          ...(onPark === 'notice' ? [] : [{ text: 'saw the notice' }]),
          { text: 'I saw the report' },
        ],
        worker: [
          { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
          { text: 'report' },
        ],
        approve: true,
        ...(onPark === undefined ? {} : { workerOptions: { onPark } }),
      })
      const first = a.main.session('p1').send('go')
      await until('notice stored', async () =>
        (await dump(a.main, 'p1')).includes('is waiting for the user'),
      )
      await first.result
      await until('turns settled', async () => !a.main.session('p1').running)
      const found = await pendingSubagentApprovals(a.main.session('p1'), a.worker)
      const approvalId = found[0]?.pending.approvals[0]?.approvalId as string
      await a.worker
        .session('p1:agent:c1')
        .respond({ approvals: [{ id: approvalId, approved: true }] }).result
      await until('parent woke on the report', async () =>
        (await dump(a.main, 'p1')).includes('I saw the report'),
      )
      const all = (await a.main.session('p1').messages()) as HarnessUIMessage[]
      const events = partsOf(all, 'data-eh.event').map((p) => (p.data as { text: string }).text)
      const calls = a.mainModel.prompts.length
      await Promise.all([a.main.close(), a.worker.close()])
      return { calls, events }
    }

    test("'notice' stores the notice without an extra model call; the report still wakes the parent", async () => {
      const out = await run('notice')
      expect(out.events.some((t) => t.includes('is waiting for the user'))).toBe(true)
      expect(out.events.some((t) => t.includes('finished'))).toBe(true)
      // delegate, "delegated", then the wake of the report
      expect(out.calls).toBe(3)
    })

    test("the default ('step') hands the notice to the running turn: one more model call", async () => {
      const out = await run(undefined)
      expect(out.events.some((t) => t.includes('is waiting for the user'))).toBe(true)
      expect(out.calls).toBe(4)
    })
  })
})
