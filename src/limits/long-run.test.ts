import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import { defineHarnessAgent, definePlugin, type HarnessAgentConfig } from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  type LongRunEvent,
  type LongRunOptions,
  type LongRunPlugin,
  longRun,
  longRunState,
  stepBudget,
} from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

let counter = 0
const nope = tool({
  description: 'noop',
  inputSchema: z.object({ n: z.number() }),
  execute: async () => `result ${counter++}`,
})
const same = tool({
  description: 'same',
  inputSchema: z.object({}),
  execute: async () => 'same result',
})
const cp = (note: string, done = false) => ({
  toolCalls: [{ toolName: 'long_run_checkpoint', input: { note, done } }],
})
const call = (n: number) => ({ toolCalls: [{ toolName: 'nope', input: { n } }] })

function storageOf() {
  return { messages: inMemoryMessages(), state: inMemoryState(), inbox: inMemoryInbox() }
}

async function until(fn: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out waiting')
}

function setup(
  model: ReturnType<typeof scriptedModel>,
  storage: ReturnType<typeof storageOf>,
  options: Partial<LongRunOptions> = {},
  extra: Partial<HarnessAgentConfig> = {},
) {
  let agent: ReturnType<typeof defineHarnessAgent>
  const lr: LongRunPlugin = longRun({
    sessions: () => agent,
    state: storage.state,
    chunkSteps: 3,
    ...options,
  })
  agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage,
    logger: silent,
    tools: { nope, same },
    loop: { wrapUp: false, progress: { repeats: 3, nudges: 0 } },
    inbox: { pollMs: 20 },
    ...extra,
    plugins: [lr, ...(extra.plugins ?? [])],
  })
  return { agent, lr }
}

const stateOf = (storage: ReturnType<typeof storageOf>, id = 's') => longRunState(storage.state, id)
const text = (model: ReturnType<typeof scriptedModel>, i: number): string =>
  JSON.stringify(model.calls[i]?.prompt)

describe('longRun', () => {
  test('a job of three chunks completes across turns and the model gets its checkpoint', async () => {
    const storage = storageOf()
    const events: LongRunEvent[] = []
    const model = scriptedModel([
      call(1),
      call(2),
      cp('NOTE-ALPHA'),
      call(3),
      call(4),
      cp('NOTE-BETA'),
      call(5),
      { text: 'all done' },
    ])
    const { agent } = setup(model, storage, { onEvent: (e) => void events.push(e) })
    const run = agent.session('s').send('audit everything')
    expect((await run.result).stop).toBe('plugin:long-run:checkpoint')
    await until(async () => (await stateOf(storage))?.status === 'finished')
    const job = await stateOf(storage)
    expect(job).toMatchObject({ status: 'finished', chunk: 2, steps: 8, checkpoint: 'NOTE-BETA' })
    // the checkpoint step had no tools and a reminder
    expect(text(model, 2)).toContain('checkpoint note')
    // the continuation carries the note
    expect(text(model, 3)).toContain('Continue the long job (chunk 1)')
    expect(text(model, 3)).toContain('NOTE-ALPHA')
    expect(text(model, 6)).toContain('NOTE-BETA')
    expect(events.map((e) => e.type)).toEqual(['started', 'checkpoint', 'checkpoint', 'finished'])
    expect(model.calls.length).toBe(8)
  })

  test('DONE at the checkpoint step completes the turn', async () => {
    const storage = storageOf()
    const model = scriptedModel([call(1), call(2), cp('x', true), { text: 'final report' }])
    const { agent } = setup(model, storage)
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect((await stateOf(storage))?.status).toBe('finished')
  })

  test('the cost cap stops the job', async () => {
    const storage = storageOf()
    const spender = definePlugin({
      name: 'spender',
      setup: () => ({
        tools: {
          spend: (ctx: { turn?: { addUsage(u: unknown): void } }) =>
            tool({
              description: 'spend',
              inputSchema: z.object({}),
              execute: async () => {
                ctx.turn?.addUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.6 })
                return `spent ${counter++}`
              },
            }),
        },
      }),
    })
    const spend = { toolCalls: [{ toolName: 'spend', input: {} }] }
    const model = scriptedModel([spend, spend, spend, spend, { text: 'never' }])
    const events: LongRunEvent[] = []
    const { agent } = setup(
      model,
      storage,
      { maxCostUsd: 1, onEvent: (e) => void events.push(e) },
      { plugins: [spender as never] },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('plugin:long-run:cost')
    const job = await stateOf(storage)
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'cost' })
    expect(job?.costUsd).toBeGreaterThanOrEqual(1)
    expect(events.at(-1)).toMatchObject({ type: 'stopped', reason: 'cost' })
  })

  test('the duration cap stops the job', async () => {
    const storage = storageOf()
    let clock = 1_000
    const slow = tool({
      description: 'slow',
      inputSchema: z.object({ n: z.number() }),
      execute: async () => {
        clock += 600
        return `slow ${counter++}`
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'slow', input: { n: 1 } }] },
      { toolCalls: [{ toolName: 'slow', input: { n: 2 } }] },
      { text: 'never' },
    ])
    const { agent } = setup(
      model,
      storage,
      { maxDurationMs: 1000, now: () => clock },
      { tools: { slow } },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('plugin:long-run:duration')
    expect(await stateOf(storage)).toMatchObject({ status: 'stopped', stopReason: 'duration' })
  })

  test('a stuck turn stops the job', async () => {
    const storage = storageOf()
    const loopCall = { toolCalls: [{ toolName: 'same', input: {} }] }
    const model = scriptedModel(Array.from({ length: 12 }, () => loopCall))
    const { agent } = setup(model, storage, { chunkSteps: 80 })
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('stuck')
    expect(await stateOf(storage)).toMatchObject({ status: 'stopped', stopReason: 'stuck' })
  })

  test('stop() ends a running job and nothing more is enqueued', async () => {
    const storage = storageOf()
    let lr: LongRunPlugin | undefined
    const stopper = tool({
      description: 'stop me',
      inputSchema: z.object({}),
      execute: async () => {
        await lr?.stop('s', 'by a person')
        return 'stopping'
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'stopper', input: {} }] },
      { text: 'never' },
    ])
    const made = setup(model, storage, {}, { tools: { stopper } })
    lr = made.lr
    const result = await made.agent.session('s').send('go').result
    expect(result.stop).toBe('aborted')
    expect(await stateOf(storage)).toMatchObject({ status: 'stopped', stopReason: 'by a person' })
    await new Promise((r) => setTimeout(r, 100))
    expect(model.calls.length).toBe(1)
    expect(await made.lr.stop('s')).toBe(false)
  })

  test('stop() between chunks blocks the queued continuation', async () => {
    const storage = storageOf()
    const model = scriptedModel([call(1), call(2), cp('NOTE'), { text: 'never' }])
    // this instance never claims inbox items: the continuation waits in the inbox
    const frozen = {
      ...storage,
      inbox: { ...storage.inbox, claim: async () => [] },
    }
    const a = setup(model, frozen, {}, {})
    await a.agent.session('s').send('go').result
    expect((await stateOf(storage))?.chunk).toBe(1)
    expect(await a.lr.stop('s', 'enough')).toBe(true)
    expect(await stateOf(storage)).toMatchObject({ status: 'stopped', stopReason: 'enough' })
    // a healthy instance picks the item up, but the job is stopped
    const b = setup(model, storage, {}, {})
    await b.agent.session('s').ready()
    await new Promise((r) => setTimeout(r, 200))
    expect(model.calls.length).toBe(3)
  })

  test('a restart resumes a lost continuation exactly once', async () => {
    const storage = storageOf()
    const model = scriptedModel([call(1), call(2), cp('NOTE-A'), call(3), { text: 'finished' }])
    // instance A ends chunk 0 but "dies" before its continuation runs: it never claims the inbox
    const frozen = { ...storage, inbox: { ...storage.inbox, claim: async () => [] } }
    const a = setup(model, frozen)
    await a.agent.session('s').send('go').result
    expect(model.calls.length).toBe(3)
    // instance B boots over the same storage and reconciles; a second call is a no-op
    const b = setup(model, storage)
    const first = await b.lr.resume('s')
    expect(first).toMatchObject({ resumed: true, chunk: 1, duplicate: true })
    const second = await b.lr.resume('s')
    expect(second).toMatchObject({ resumed: true, duplicate: true })
    await until(async () => (await stateOf(storage))?.status === 'finished')
    expect(model.calls.length).toBe(5)
    expect(text(model, 3)).toContain('NOTE-A')
  })

  test('a turn that died mid-chunk is resumed with a restart notice', async () => {
    const storage = storageOf()
    const model = scriptedModel([
      call(1),
      { ...call(2), delayMs: 60_000 },
      { text: 'DONE: finished after restart' },
    ])
    const a = setup(model, storage, {}, { recovery: { instanceId: 'worker-1', staleMs: 60_000 } })
    const run = a.agent.session('s').send('go')
    run.result.catch(() => {})
    await until(async () => model.calls.length >= 2)
    // the process dies here: a new process sees the stored state (turn still marked active) and
    // messages, but none of the in-memory state of A
    const crashed = { ...storageOf(), messages: storage.messages }
    const snapshot = await storage.state.get('s')
    if (snapshot === null) throw new Error('no state')
    // the dead owner's heartbeat is long past (the stale rule of spec 05 §9)
    if (snapshot.core.activeTurn === undefined) throw new Error('no active turn')
    snapshot.core.activeTurn.heartbeatAt = 0
    await crashed.state.set('s', snapshot)
    const model2 = scriptedModel([{ text: 'DONE: finished after restart' }])
    const b = setup(model2, crashed, {}, { recovery: { instanceId: 'worker-2', staleMs: 1000 } })
    const first = await b.lr.resume('s')
    expect(first).toMatchObject({ resumed: true, duplicate: false })
    expect(await b.lr.resume('s')).toMatchObject({ resumed: true, duplicate: true })
    await until(async () => (await stateOf(crashed))?.status === 'finished')
    expect(model2.calls.length).toBe(1)
    expect(JSON.stringify(model2.calls[0]?.prompt)).toContain('server restarted')
  })
})

describe('stepBudget onCap', () => {
  test('extends once with the reminder, then wraps up', async () => {
    const model = scriptedModel(Array.from({ length: 14 }, (_, i) => call(i)))
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
      tools: { nope },
      loop: { maxSteps: 2, wrapUp: false, progress: false },
      plugins: [
        stepBudget({
          chunk: 3,
          cap: 5,
          onCap: { reminder: 'HAND OVER NOW', extraSteps: 2 },
        }),
      ],
    })
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('max-steps')
    // 5 steps to the cap, 2 extra steps once
    expect(model.calls.length).toBe(7)
    expect(text(model, 4)).not.toContain('HAND OVER NOW')
    expect(text(model, 5)).toContain('HAND OVER NOW')
    expect(text(model, 6)).toContain('HAND OVER NOW')
  })
})
