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
import { memoryInbox, memoryMessages, memoryState } from '../storage/memory.ts'
import { type ScriptedModel, scriptedModel } from '../testing/scripted-model.ts'
import { pendingSubagentApprovals, type SubagentsOptions, subagents } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

type Steps = Parameters<typeof scriptedModel>[0]
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const newStorage = () => ({
  messages: memoryMessages(),
  state: memoryState(),
  inbox: memoryInbox(),
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
    mainOptions?: Partial<SubagentsOptions>
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
      subagents({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.main as Agent,
        selfAgent: () => holder.worker as Agent,
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
    plugins: [
      subagents({
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
