/**
 * The durable turn principal (ADR-0069, spec 05 §2.1): validation, resolution order (turn, session
 * default, none), the stored session default, `ctx.principal` in hooks and tools, `activeTurn`,
 * the inbox item and the `respond()` continuation, which keeps the principal of the turn that asked.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { InboxAdapter, Principal } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { externalTool } from '../registry/external.ts'
import { inMemoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { sleep, until } from '../testing/test-utils.ts'
import { spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const ana: Principal = { id: 'ana', name: 'Ana' }
const bo: Principal = { id: 'bo' }

type Shared = {
  messages: ReturnType<typeof spyMessages>
  state: ReturnType<typeof spyState>
  inbox?: InboxAdapter
}

function shared(inbox?: InboxAdapter): Shared {
  return { messages: spyMessages(), state: spyState(), ...(inbox === undefined ? {} : { inbox }) }
}

/** A plugin that records `ctx.principal?.id` in every hook of a turn. */
function recorder(seen: string[]) {
  const id = (ctx: { principal: Principal | undefined }) => ctx.principal?.id ?? '-'
  return definePlugin({
    name: 'rec',
    setup: () => ({
      hooks: {
        'turn.start': (ctx) => void seen.push(`start:${id(ctx)}`),
        'step.prepare': (ctx) => void seen.push(`step:${id(ctx)}`),
        'turn.end': (ctx) => void seen.push(`end:${id(ctx)}`),
      },
    }),
  })
}

function instance(
  store: Shared,
  config: Omit<Partial<HarnessAgentConfig>, 'model'> & Pick<HarnessAgentConfig, 'model'>,
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: store.inbox === undefined ? store : { ...store, inbox: store.inbox },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
    ...(store.inbox === undefined ? {} : { inbox: { pollMs: 10, ...config.inbox } }),
  })
  return { agent, warnings }
}

describe('validation', () => {
  test('agent.session() throws EH_INVALID_INPUT for an invalid principal', () => {
    const { agent } = instance(shared(), { model: scriptedModel([{ text: 'x' }]) })
    const bad: unknown[] = [
      {},
      { id: '' },
      { id: 7 },
      { id: 'a', name: 3 },
      { id: 'a', fn: () => 1 },
      { id: 'a', nan: Number.NaN },
      { id: 'a', big: 'x'.repeat(3000) },
      new (class Who {
        id = 'a'
      })(),
      'ana',
      [],
    ]
    for (const principal of bad) {
      try {
        agent.session('s1', { principal: principal as never })
        throw new Error('expected a throw')
      } catch (error) {
        expect(isHarnessError(error, 'EH_INVALID_INPUT')).toBe(true)
      }
    }
  })

  test('send() with an invalid principal is a failed run, nothing is stored', async () => {
    const store = shared()
    const model = scriptedModel([{ text: 'x' }])
    const { agent } = instance(store, { model })
    const result = await agent.session('s1').send('hi', { principal: { id: '' } as never }).result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(model.calls).toHaveLength(0)
  })

  test('enqueue() rejects an invalid principal', async () => {
    const { agent } = instance(shared(), { model: scriptedModel([{ text: 'x' }]) })
    await expect(
      agent.session('s1').enqueue('hi', { principal: { id: 3 } as never }),
    ).rejects.toMatchObject({ code: 'EH_INVALID_INPUT' })
  })

  test('a valid principal is copied: later changes of the caller object change nothing', async () => {
    const seen: string[] = []
    const mine: Principal = { id: 'ana' }
    const { agent } = instance(shared(), {
      model: scriptedModel([{ text: 'x' }]),
      plugins: [recorder(seen)],
    })
    const run = agent.session('s1').send('hi', { principal: mine })
    mine.id = 'changed'
    await run.result
    expect(seen).toEqual(['start:ana', 'step:ana', 'end:ana'])
  })
})

describe('resolution order and the stored session default', () => {
  test('turn principal, else session default, else undefined', async () => {
    const seen: string[] = []
    const model = scriptedModel([{ text: '1' }, { text: '2' }, { text: '3' }])
    const store = shared()
    const withDefault = instance(store, { model, plugins: [recorder(seen)] }).agent.session('s1', {
      principal: ana,
    })
    await withDefault.send('a').result
    await withDefault.send('b', { principal: bo }).result
    await withDefault.send('c').result
    expect(seen.filter((s) => s.startsWith('start:'))).toEqual([
      'start:ana',
      'start:bo',
      'start:ana',
    ])

    const none: string[] = []
    const bare = instance(shared(), {
      model: scriptedModel([{ text: 'x' }]),
      plugins: [recorder(none)],
    })
    await bare.agent.session('s9').send('x').result
    expect(none).toEqual(['start:-', 'step:-', 'end:-'])
  })

  test('the session default is stored in state.core.principal when first opened', async () => {
    const store = shared()
    const { agent } = instance(store, { model: scriptedModel([{ text: 'x' }]) })
    await agent.session('s1', { principal: ana }).ready()
    expect((await store.state.get('s1'))?.core.principal).toEqual(ana)
  })

  test('a later open with another principal keeps the stored one and warns', async () => {
    const store = shared()
    const first = instance(store, { model: scriptedModel([{ text: 'x' }]) })
    await first.agent.session('s1', { principal: ana }).ready()
    await first.agent.close()

    const seen: string[] = []
    const second = instance(store, {
      model: scriptedModel([{ text: 'y' }]),
      plugins: [recorder(seen)],
    })
    const session = second.agent.session('s1', { principal: bo })
    await session.send('hi').result
    expect(seen[0]).toBe('start:ana')
    expect(second.warnings.some((w) => w.code === 'W_SESSION_OPTIONS_IGNORED')).toBe(true)
    expect((await store.state.get('s1'))?.core.principal).toEqual(ana)
  })

  test('a live session handle warns when asked for another principal, and not for the same one', async () => {
    const { agent, warnings } = instance(shared(), { model: scriptedModel([{ text: 'x' }]) })
    agent.session('s1', { principal: ana })
    agent.session('s1', { principal: { id: 'ana', name: 'Ana' } })
    expect(warnings).toHaveLength(0)
    agent.session('s1', { principal: bo })
    expect(warnings.map((w) => w.code)).toEqual(['W_SESSION_OPTIONS_IGNORED'])
  })

  test('data stored before the principal existed reads as undefined', async () => {
    const store = shared()
    const first = instance(store, { model: scriptedModel([{ text: 'x' }]) })
    await first.agent.session('s1').send('hi').result
    await first.agent.close()
    const seen: string[] = []
    const second = instance(store, {
      model: scriptedModel([{ text: 'y' }]),
      plugins: [recorder(seen)],
    })
    await second.agent.session('s1').send('again').result
    expect(seen).toEqual(['start:-', 'step:-', 'end:-'])
  })
})

describe('ctx.principal in tools and activeTurn', () => {
  test('a tool factory and its execute see the turn principal', async () => {
    const seen: string[] = []
    const probe = (ctx: { principal: Principal | undefined }) =>
      tool({
        inputSchema: z.object({}),
        execute: async () => {
          seen.push(`tool:${ctx.principal?.id ?? '-'}`)
          return 'ok'
        },
      })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'probe', input: {} }] },
      { text: 'done' },
    ])
    const { agent } = instance(shared(), { model, tools: { probe } })
    await agent.session('s1', { principal: ana }).send('go', { principal: bo }).result
    expect(seen).toEqual(['tool:bo'])
  })

  test('activeTurn stores the principal while the turn runs', async () => {
    const store = shared()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await gate
        return 'ok'
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'slow', input: {} }] },
      { text: 'done' },
    ])
    const { agent } = instance(store, { model, tools: { slow } })
    const run = agent.session('s1', { principal: ana }).send('go', { principal: bo })
    await until(
      'activeTurn stored',
      async () => (await store.state.get('s1'))?.core.activeTurn !== undefined,
    )
    expect((await store.state.get('s1'))?.core.activeTurn?.principal).toEqual(bo)
    expect((await agent.peek('s1').stats()).activeTurn?.principal).toEqual(bo)
    release()
    await run.result
    expect((await store.state.get('s1'))?.core.activeTurn).toBeUndefined()
  })
})

describe('durable paths', () => {
  const ask = () =>
    externalTool({
      description: 'wait for a result',
      inputSchema: z.object({ q: z.string() }),
      start: () => ({ correlationId: 'c1' }),
    })

  test('a parked turn stores its principal; the continuation on another instance runs for the asker', async () => {
    const store = shared()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'ready?' } }] },
      { text: 'done' },
    ])
    const a = instance(store, { model, tools: { ask: ask() } })
    const parked = await a.agent.session('s1').send('go', { principal: ana }).result
    expect(parked.stop).toBe('tool-pending')
    expect(parked.pending?.principal).toEqual(ana)
    expect((await store.state.get('s1'))?.core.pending?.principal).toEqual(ana)

    const seen: string[] = []
    const probe = instance(store, {
      model,
      tools: { ask: ask() },
      plugins: [recorder(seen)],
    })
    // the answering instance has another default principal: the asker still wins
    const session = probe.agent.session('s1', { principal: bo })
    const resolved = await session.resolveWait('w_call-0-0', { output: 'yes' })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    expect((await resolved.run.result).stop).toBe('complete')
    expect(seen).toEqual(['start:ana', 'step:ana', 'end:ana'])
  })

  test('respond() keeps the asker as principal and records the answerer as actor', async () => {
    const store = shared()
    const seen: string[] = []
    const decided: Array<string | undefined> = []
    const plugin = definePlugin({
      name: 'who',
      setup: () => ({
        hooks: {
          'approval.decided': (_ctx, e) =>
            void decided.push((e as { actor?: Principal }).actor?.id),
        },
      }),
    })
    const probe = tool({
      inputSchema: z.object({}),
      execute: async () => 'ran',
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'probe', input: {} }] },
      { text: 'done' },
    ])
    const config = {
      model,
      tools: { probe },
      approval: { policy: () => ({ type: 'user-approval', reason: 'confirm' }) as never },
      plugins: [recorder(seen), plugin],
    }
    const a = instance(store, config)
    const first = await a.agent.session('s1').send('go', { principal: ana }).result
    expect(first.stop).toBe('tool-pending')
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    seen.length = 0
    const b = instance(store, config)
    const run = b.agent
      .session('s1')
      .respond(
        { approvals: [{ id: approvalId, approved: true, actor: { id: 'boss' } }] },
        { principal: bo },
      )
    expect((await run.result).stop).toBe('complete')
    expect(seen.every((s) => s.endsWith(':ana'))).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(decided).toEqual(['boss'])
  })

  test('respond() with a principal applies when the pending turn had none', async () => {
    const store = shared()
    const seen: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'x' } }] },
      { text: 'done' },
    ])
    const config = { model, tools: { ask: ask() }, plugins: [recorder(seen)] }
    await instance(store, config).agent.session('s1').send('go').result
    seen.length = 0
    const session = instance(store, config).agent.session('s1')
    const run = session.respond(
      { externals: [{ waitId: 'w_call-0-0', output: 'yes' }] },
      { principal: bo },
    )
    expect((await run.result).stop).toBe('complete')
    expect(seen).toEqual(['start:bo', 'step:bo', 'end:bo'])
  })

  test('an enqueued principal is stored in the inbox item and run by the instance that drains it', async () => {
    const inner = inMemoryInbox()
    const items: Array<{ principal?: Principal }> = []
    const inbox: InboxAdapter = {
      ...inner,
      enqueue: async (sessionId, item) => {
        if (item.kind === 'send') items.push({ principal: item.input.principal as Principal })
        return inner.enqueue(sessionId, item)
      },
      // instance A never claims: instance B has to drain
      claim: (sessionId, owner, opts) =>
        owner.startsWith('inst-a') ? Promise.resolve([]) : inner.claim(sessionId, owner, opts),
    }
    const store = shared(inbox)
    const seenB: string[] = []
    const a = instance(store, {
      model: scriptedModel([{ text: 'a' }]),
      recovery: { instanceId: 'inst-a' },
    })
    const b = instance(store, {
      model: scriptedModel([{ text: 'b' }]),
      recovery: { instanceId: 'inst-b' },
      plugins: [recorder(seenB)],
    })
    await b.agent.session('s1').ready()
    await a.agent.session('s1').enqueue('hello', { principal: ana })
    await until('instance B ran the turn', () => seenB.includes('end:ana'))
    expect(items).toEqual([{ principal: ana }])
    expect(seenB).toEqual(['start:ana', 'step:ana', 'end:ana'])
    await a.agent.close()
    await b.agent.close()
  })

  test('collect merges only inputs of one principal', async () => {
    const seen: string[] = []
    const model = scriptedModel([{ text: '1' }, { text: '2' }])
    const { agent } = instance(shared(), { model, plugins: [recorder(seen)] })
    const session = agent.session('s1')
    const options = { mode: 'collect' as const, collect: { quietMs: 20, maxWaitMs: 200 } }
    await session.enqueue('one', { ...options, principal: ana })
    await session.enqueue('two', { ...options, principal: ana })
    await session.enqueue('three', { ...options, principal: bo })
    await until('two turns', () => seen.filter((s) => s.startsWith('end:')).length === 2)
    await sleep(50)
    expect(seen.filter((s) => s.startsWith('start:'))).toEqual(['start:ana', 'start:bo'])
    expect(model.calls).toHaveLength(2)
  })
})
