/**
 * Background events (`inject(…, { wake: true })`) that arrive while the session waits for a client
 * tool answer or an approval (spec 11 §6.3, ADR-0054): they never start a turn that fails, they are
 * held, and the wake runs once after the pending items are answered — also when the event came in
 * from another instance.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { SessionEvent } from '../../agent/session-types.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { memoryInbox } from '../../storage/memory.ts'
import { scriptedModel } from '../../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from '../memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

const client = tool({ description: 'asks the user', inputSchema: z.object({}) })
const askCall = { toolCalls: [{ toolName: 'client', input: {} }] }

function shared() {
  return { messages: defaultMemoryMessages(), state: defaultMemoryState(), inbox: memoryInbox() }
}
function instance(
  storage: ReturnType<typeof shared>,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  return defineHarnessAgent({
    contextWindow: 100_000,
    storage,
    logger: silent,
    tools: { client },
    ...config,
    inbox: { pollMs: 10 },
  })
}
function record(stream: ReadableStream<SessionEvent>): SessionEvent[] {
  const events: SessionEvent[] = []
  const reader = stream.getReader()
  void (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      events.push(next.value)
    }
  })()
  return events
}
const wakes = (events: SessionEvent[]) =>
  events.filter((e) => e.type === 'turn-start' && e.kind === 'wake')
const eventText = (name: string, text: string) => ({ name, text })

describe('events while a client tool call waits', () => {
  test('one instance: two reports are held, respond() continues, one wake turn sees both', async () => {
    const storage = shared()
    const model = scriptedModel([askCall, { text: 'answered' }, { text: 'saw the reports' }])
    const agent = instance(storage, { model })
    const session = agent.session('s1')
    const events = record(session.events())
    const first = await session.send('go').result
    expect(first.stop).toBe('tool-pending')
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    await session.inject('eh.event', eventText('subagent', 'REPORT-1'), {
      deliver: 'next-step',
      wake: true,
    })
    await session.inject('eh.event', eventText('subagent', 'REPORT-2'), {
      deliver: 'next-step',
      wake: true,
    })
    await sleep(30)
    expect(model.prompts).toHaveLength(1)
    expect(wakes(events)).toHaveLength(0)
    expect((await session.stats()).pending?.clientTools).toHaveLength(1)

    const answered = await session.respond({ toolOutputs: [{ toolCallId, output: 'yes' }] }).result
    expect(answered.stop).toBe('complete')
    await until('the wake turn ran', () => model.prompts.length === 3)
    expect(wakes(events)).toHaveLength(1)
    // the continuation never sees the held reports in the middle of the tool exchange
    expect(JSON.stringify(model.prompts[1])).not.toContain('REPORT-')
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-1')
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-2')
    await agent.close()
  })

  test('without an inbox the wake is held in memory and runs after respond()', async () => {
    const storage = { messages: defaultMemoryMessages(), state: defaultMemoryState() }
    const model = scriptedModel([askCall, { text: 'answered' }, { text: 'saw the reports' }])
    const agent = defineHarnessAgent({
      contextWindow: 100_000,
      storage,
      logger: silent,
      tools: { client },
      model,
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    const events = record(session.events())
    await session.inject('eh.event', eventText('subagent', 'REPORT-M'), { wake: true })
    await session.inject('eh.event', eventText('subagent', 'REPORT-N'), { wake: true })
    await sleep(20)
    expect(model.prompts).toHaveLength(1)
    await session.respond({ toolOutputs: [{ toolCallId, output: 'yes' }] }).result
    await until('the wake turn ran', () => model.prompts.length === 3)
    await sleep(40)
    expect(model.prompts).toHaveLength(3) // two reports, one wake turn
    expect(wakes(events)).toHaveLength(1)
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-M')
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-N')
    await agent.close()
  })

  test('two instances: B injects while A waits; A answers; one wake turn runs (no lost wake)', async () => {
    const storage = shared()
    const model = scriptedModel([askCall, { text: 'answered' }, { text: 'saw the report' }])
    const a = instance(storage, { model })
    const b = instance(storage, { model })
    const sessionA = a.session('s1')
    const eventsA = record(sessionA.events())
    const first = await sessionA.send('go').result
    expect(first.stop).toBe('tool-pending')
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string

    const sessionB = b.session('s1')
    const eventsB = record(sessionB.events())
    const injected = await sessionB.inject('eh.event', eventText('subagent', 'REPORT-B'), {
      deliver: 'next-step',
      wake: true,
    })
    await sleep(30)
    expect(model.prompts).toHaveLength(1)
    expect(injected.message).toBeDefined()

    const answered = await sessionA.respond({ toolOutputs: [{ toolCallId, output: 'yes' }] }).result
    expect(answered.stop).toBe('complete')
    await until('exactly one wake turn ran somewhere', () => model.prompts.length === 3)
    await sleep(60)
    expect(wakes(eventsA).length + wakes(eventsB).length).toBe(1)
    expect(model.prompts).toHaveLength(3)
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-B')
    const stored = (await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(stored.filter((m) => m.role === 'assistant')).toHaveLength(2)
    await a.close()
    await b.close()
  })

  test('two instances: B answers what A parked, an event of A that was held reaches the model once', async () => {
    const storage = shared()
    const model = scriptedModel([askCall, { text: 'answered' }, { text: 'saw the report' }])
    const a = instance(storage, { model })
    const b = instance(storage, { model })
    const sessionA = a.session('s1')
    const first = await sessionA.send('go').result
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    await sessionA.inject('eh.event', eventText('subagent', 'REPORT-A'), { wake: true })
    const sessionB = b.session('s1')
    const answered = await sessionB.respond({ toolOutputs: [{ toolCallId, output: 'yes' }] }).result
    expect(answered.stop).toBe('complete')
    await until('the wake turn ran', () => model.prompts.length === 3)
    await sleep(60)
    expect(model.prompts).toHaveLength(3)
    expect(JSON.stringify(model.prompts).split('REPORT-A').length - 1).toBe(1)
    await a.close()
    await b.close()
  })
})

describe('events while a tool approval waits', () => {
  test('two instances: the event of B is held; the approval answered in B runs one wake turn there', async () => {
    const storage = shared()
    const pay = tool({
      description: 'Pay',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => `paid ${amount}`,
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'paid' },
      { text: 'saw the report' },
    ])
    const config = {
      model,
      tools: { pay },
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const a = instance(storage, config)
    const b = instance(storage, config)
    const first = await a.session('s1').send('pay').result
    expect(first.stop).toBe('tool-pending')
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const sessionB = b.session('s1')
    await sessionB.inject('eh.event', eventText('subagent', 'REPORT-C'), {
      deliver: 'next-step',
      wake: true,
    })
    await sleep(30)
    expect(model.prompts).toHaveLength(1)
    const answered = await sessionB.respond({ approvals: [{ id: approvalId, approved: true }] })
      .result
    expect(answered.stop).toBe('complete')
    await until('the wake turn ran', () => model.prompts.length === 3)
    expect(JSON.stringify(model.prompts[1])).not.toContain('REPORT-C')
    expect(JSON.stringify(model.prompts[2])).toContain('REPORT-C')
    await a.close()
    await b.close()
  })
})

describe('events that arrive while the turn that parks is still running', () => {
  for (const withInbox of [true, false]) {
    test(`${withInbox ? 'durable inbox' : 'in-memory'}: the event is undelivered at the end of the parking turn and wakes once after respond()`, async () => {
      const storage = withInbox
        ? shared()
        : { messages: defaultMemoryMessages(), state: defaultMemoryState() }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const slow = tool({
        description: 'Slow',
        inputSchema: z.object({}),
        execute: async () => {
          await gate
          return 'slow done'
        },
      })
      const model = scriptedModel([
        {
          toolCalls: [
            { toolName: 'slow', input: {} },
            { toolName: 'client', input: {} },
          ],
        },
        { text: 'answered' },
        { text: 'saw the report' },
      ])
      const agent = defineHarnessAgent({
        contextWindow: 100_000,
        storage,
        logger: silent,
        tools: { client, slow },
        model,
        ...(withInbox ? { inbox: { pollMs: 10 } } : {}),
      })
      const session = agent.session('s1')
      const events = record(session.events())
      const run = session.send('go')
      await until('the slow tool started', () => model.prompts.length === 1)
      await sleep(10)
      await session.inject('eh.event', eventText('subagent', 'REPORT-R'), {
        deliver: 'next-step',
        wake: true,
      })
      release()
      const first = await run.result
      expect(first.stop).toBe('tool-pending')
      await sleep(30)
      expect(model.prompts).toHaveLength(1)
      expect(wakes(events)).toHaveLength(0)
      const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
      const answered = await session.respond({ toolOutputs: [{ toolCallId, output: 'yes' }] })
        .result
      expect(answered.stop).toBe('complete')
      await until('the wake turn ran', () => model.prompts.length === 3)
      await sleep(30)
      expect(model.prompts).toHaveLength(3)
      expect(wakes(events)).toHaveLength(1)
      expect(JSON.stringify(model.prompts[2])).toContain('REPORT-R')
      await agent.close()
    })
  }
})
