/**
 * Agent messaging in `approvals: 'park'` mode (ADR-0041): the agent directory comes from storage,
 * delivery and resume go over the durable inbox, reports and `main` messages are enqueued through
 * storage. Two agent instances sharing storage stand for two processes.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, type HarnessAgent, type HarnessUIMessage } from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { type ScriptedModel, scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
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

const spawn = (name?: string, toolCallId?: string) => ({
  toolName: 'agent',
  input: {
    subagent_type: 'worker',
    description: 'review',
    prompt: 'review the change',
    ...(name === undefined ? {} : { name }),
  },
  ...(toolCallId === undefined ? {} : { toolCallId }),
})
const say = (to: string, message: string) => ({
  toolName: 'send_message',
  input: { to, message },
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

/** One "process": a main agent and its worker agent over shared storage. */
function process_(
  storage: Storage,
  opts: {
    main: Steps
    worker: Steps
    approve?: boolean
    tools?: Record<string, unknown>
    mainOptions?: Partial<SubagentOptions>
    workerOptions?: Partial<SubagentOptions>
    resumable?: boolean
  },
): { main: Agent; worker: Agent; mainModel: ScriptedModel; workerModel: ScriptedModel } {
  const holder: { main?: Agent; worker?: Agent } = {}
  const mainModel = scriptedModel(opts.main)
  const workerModel = scriptedModel(opts.worker)
  const worker = defineHarnessAgent({
    model: workerModel,
    contextWindow: 100_000,
    storage,
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
    plugins: [
      subagent({
        agents: {
          worker: {
            agent: worker,
            description: 'does work',
            ...(opts.resumable === false ? { resumable: false } : {}),
          },
        },
        approvals: 'park',
        selfAgent: () => holder.main as Agent,
        ...opts.mainOptions,
      }),
    ] as never,
  }) as Agent
  holder.main = main
  return { main, worker, mainModel, workerModel }
}

const text = (m: HarnessUIMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

function toolOutputs(messages: HarnessUIMessage[], toolName: string): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const p of m.parts as Array<{ type: string; output?: unknown }>) {
      if (p.type === `tool-${toolName}` && typeof p.output === 'string') out.push(p.output)
    }
  }
  return out
}

const promptText = (model: ScriptedModel, i: number): string => JSON.stringify(model.prompts[i])

describe("send_message with approvals: 'park' (ADR-0041)", () => {
  test('two instances: B answers the child, then messages the finished agent by name; the report reaches the parent', async () => {
    const storage = newStorage()
    const a = process_(storage, {
      main: [{ toolCalls: [spawn('reviewer', 'c1')] }],
      worker: [{ toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] }],
      approve: true,
    })
    const first = await a.main.session('p1').send('go').result
    expect(first.stop).toBe('tool-pending')

    // instance B ("another process"): answers the child, then follows up with it by name
    const b = process_(storage, {
      main: [
        { text: 'parent done' },
        { toolCalls: [say('reviewer', 'also check the tests')] },
        { text: 'asked' },
        { text: 'saw the second report' },
      ],
      worker: [{ text: 'first report' }, { text: 'second report' }],
      approve: true,
    })
    const childId = 'p1:agent:c1'
    const found = await pendingSubagentApprovals(b.main.session('p1'), b.worker)
    expect(found.map((f) => f.sessionId)).toEqual([childId])
    const approvalId = found[0]?.pending.approvals[0]?.approvalId as string
    const childRun = b.worker
      .session(childId)
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await childRun.result).stop).toBe('complete')
    await until('parent continued', async () =>
      JSON.stringify(await b.main.session('p1').messages()).includes('parent done'),
    )

    // the name was stored with the agent call: B knows "reviewer" without having started it
    const followUp = await b.main.session('p1').send('ask the reviewer for more').result
    expect(followUp.stop).toBe('complete')
    const parentMessages = (await b.main.session('p1').messages()) as HarnessUIMessage[]
    expect(toolOutputs(parentMessages, 'send_message').join('\n')).toContain(
      'reviewer had finished; it was resumed',
    )

    // the finished child got a new turn on the SAME session; its report came back as an event
    await until('parent saw the report', async () =>
      JSON.stringify(await b.main.session('p1').messages()).includes('second report'),
    )
    await until('wake turn ran', () => b.mainModel.prompts.length === 4)
    const child = (await b.worker.session(childId).messages()) as HarnessUIMessage[]
    const users = child.filter((m) => m.role === 'user').map(text)
    expect(users[1]).toContain(
      '<agent-message from="main" id="main" relation="launcher" to="reviewer">',
    )
    expect(users[1]).toContain('also check the tests')
    expect(child.filter((m) => m.role === 'assistant').length).toBe(2)
    expect(promptText(b.mainModel, 3)).toContain('Resumed subagent')
    expect(promptText(b.mainModel, 3)).toContain('second report')
    // the roster lists the agent by name (from storage)
    expect(promptText(b.mainModel, 1)).toContain('reviewer')
    for (const agent of [a.main, a.worker, b.main, b.worker]) await agent.close()
  })

  test('a running child gets the message at its next step (steer over the inbox)', async () => {
    const storage = newStorage()
    const g = gate()
    const p = process_(storage, {
      main: [
        { toolCalls: [spawn('w', 'c1')] },
        { text: 'parent done' },
        { toolCalls: [say('w', 'first extra')] },
        { text: 'sent first' },
        { toolCalls: [say('w', 'second extra')] },
        { text: 'sent second' },
        { text: 'got the report' },
      ],
      worker: [{ text: 'r1' }, { toolCalls: [{ toolName: 'gated', input: {} }] }, { text: 'r2' }],
      tools: { gated: g.gated },
    })
    const session = p.main.session('p1')
    await session.send('go').result
    await until('parent done', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    await session.send('resume it').result
    await g.hasStarted // the resumed child is inside its tool call: it is running
    const second = await session.send('and again').result
    expect(second.stop).toBe('complete')
    expect(
      toolOutputs((await session.messages()) as HarnessUIMessage[], 'send_message')[1],
    ).toMatch(/^Message delivered to w\./)
    g.release()
    await until('report', async () =>
      JSON.stringify(await session.messages()).includes('Resumed subagent'),
    )
    // the steer reached the child's second step of the resumed turn
    expect(promptText(p.workerModel, 2)).toContain('second extra')
    expect(promptText(p.workerModel, 2)).toContain('<agent-message from=')
    const child = (await p.worker.session('p1:agent:c1').messages()) as HarnessUIMessage[]
    const input = child.flatMap((m) => m.parts).find((part) => part.type === 'data-eh.input') as
      | { data: { text: string } }
      | undefined
    expect(input?.data.text).toContain('second extra')
    await p.main.close()
    await p.worker.close()
  })

  test('a child messages main: the root session gets a turn with the framed message', async () => {
    const storage = newStorage()
    const p = process_(storage, {
      main: [
        { toolCalls: [spawn('reviewer', 'c1')] },
        { text: 'parent done' },
        { text: 'main read the note' },
      ],
      worker: [
        { toolCalls: [say('main', 'heads up: the build is red')] },
        { text: 'child report' },
      ],
    })
    const session = p.main.session('p1')
    await session.send('go').result
    await until('main handled the message', () => p.mainModel.prompts.length === 3)
    expect(promptText(p.mainModel, 2)).toContain(
      '<agent-message from=\\"reviewer\\" id=\\"p1:agent:c1\\" relation=\\"child\\">',
    )
    expect(promptText(p.mainModel, 2)).toContain('heads up: the build is red')
    expect(promptText(p.mainModel, 2)).toContain('child report')
    await p.main.close()
    await p.worker.close()
  })

  test('throttling: an identical message and the rate limit', async () => {
    const storage = newStorage()
    const p = process_(storage, {
      main: [
        { toolCalls: [spawn('w', 'c1')] },
        { text: 'parent done' },
        {
          toolCalls: [
            say('w', 'same text'),
            say('w', 'same text'),
            say('w', 'another one'),
            say('w', 'a third one'),
          ],
        },
        { text: 'sent' },
      ],
      worker: [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }],
      mainOptions: { messageLimits: { perWindow: 2 } },
    })
    const session = p.main.session('p1')
    await session.send('go').result
    await until('parent done', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    await session.send('now').result
    const outputs = toolOutputs((await session.messages()) as HarnessUIMessage[], 'send_message')
    expect(outputs.filter((o) => o.startsWith('Not sent: an identical')).length).toBe(1)
    expect(outputs.filter((o) => o.includes('rate limit')).length).toBe(1)
    await p.main.close()
    await p.worker.close()
  })

  test('refusals: unknown target, one-shot agent, name collision', async () => {
    const storage = newStorage()
    const p = process_(storage, {
      main: [
        { toolCalls: [spawn('w', 'c1')] },
        { text: 'parent done' },
        { toolCalls: [say('nobody', 'hello'), say('w', 'more please')] },
        { text: 'tried' },
        { toolCalls: [spawn('w', 'c2')] },
        { text: 'collision seen' },
      ],
      worker: [{ text: 'r1' }],
      resumable: false,
    })
    const session = p.main.session('p1')
    await session.send('go').result
    await until('parent done', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    await session.send('now').result
    const outputs = toolOutputs((await session.messages()) as HarnessUIMessage[], 'send_message')
    expect(outputs[0]).toContain('no agent "nobody". You can message: w.')
    expect(outputs[1]).toContain('cannot be resumed (a one-shot agent)')
    const third = await session.send('again').result
    expect(third.stop).toBe('tool-pending')
    expect(JSON.stringify(await session.pendingWaits())).toContain('already used')
    await p.main.close()
    await p.worker.close()
  })

  test('agent_stop asks the child session to abort; the agent stays resumable', async () => {
    const storage = newStorage()
    const g = gate()
    const p = process_(storage, {
      main: [
        { toolCalls: [spawn('w', 'c1')] },
        { text: 'parent done' },
        { toolCalls: [say('w', 'start working')] },
        { text: 'sent' },
        { toolCalls: [{ toolName: 'agent_stop', input: { id: 'w' } }] },
        { text: 'stopped it' },
        { text: 'saw the report' },
      ],
      worker: [{ text: 'r1' }, { toolCalls: [{ toolName: 'gated', input: {} }] }, { text: 'r2' }],
      tools: { gated: g.gated },
    })
    const session = p.main.session('p1')
    await session.send('go').result
    await until('parent done', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    await session.send('resume it').result
    await g.hasStarted
    await session.send('stop it').result
    const stopOutputs = toolOutputs((await session.messages()) as HarnessUIMessage[], 'agent_stop')
    expect(stopOutputs[0]).toMatch(/^Stopped w\. It can be resumed/)
    g.release()
    await until('report of the stopped run', async () =>
      JSON.stringify(await session.messages()).includes('subagent stopped: aborted'),
    )
    await p.main.close()
    await p.worker.close()
  })
})
