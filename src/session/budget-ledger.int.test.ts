/**
 * `budget.ledger` (spec 12 §4.1): reservations before every model call, commits after steps,
 * nested usage records, error policy, sharing one ledger across agent instances.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { BudgetLedger, HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { memoryBudgetLedger } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { collect, normalizeVolatile, spyMessages, spyState } from './int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

// 10 input + 5 output tokens per scripted step; $1 per 1k output tokens → $0.005 per step
const models = () => ({ pricing: { input: 0, output: 1_000 } })
const STEP = 0.005
const work = tool({ inputSchema: z.object({ n: z.number() }), execute: async ({ n }) => `r${n}` })
const looping = (n: number, delayMs?: number) =>
  scriptedModel(
    Array.from({ length: n }, (_, i) => ({
      toolCalls: [{ toolName: 'work', input: { n: i } }],
      ...(delayMs === undefined ? {} : { delayMs }),
    })),
  )

type Call = { op: string; args: unknown[] }

/** A ledger that records every call and can be told to fail. */
function spyLedger(inner: BudgetLedger = memoryBudgetLedger()) {
  const calls: Call[] = []
  const fail: Partial<Record<keyof BudgetLedger, (args: unknown[]) => 'before' | 'after' | false>> =
    {}
  const wrap =
    <K extends keyof BudgetLedger>(op: K) =>
    async (...args: Parameters<BudgetLedger[K]>): Promise<Awaited<ReturnType<BudgetLedger[K]>>> => {
      calls.push({ op, args: structuredClone(args) })
      const mode = fail[op]?.(args) ?? false
      if (mode === 'before') throw new Error(`${op} down`)
      const out = await (inner[op] as (...a: unknown[]) => Promise<unknown>)(...args)
      if (mode === 'after') throw new Error(`${op} lost its answer`)
      return out as Awaited<ReturnType<BudgetLedger[K]>>
    }
  const ledger: BudgetLedger = {
    reserve: wrap('reserve'),
    commit: wrap('commit'),
    release: wrap('release'),
    record: wrap('record'),
    check: wrap('check'),
  }
  return { ledger, calls, fail, inner }
}

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  ledger: BudgetLedger,
  ledgerConfig: Partial<NonNullable<NonNullable<HarnessAgentConfig['budget']>['ledger']>> = {},
) {
  const messages = spyMessages()
  const state = spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    models,
    tools: { work },
    ...config,
    budget: {
      ...config.budget,
      ledger: {
        adapter: ledger,
        scopes: () => ['user:ada'],
        estimate: () => STEP,
        ...ledgerConfig,
      },
    },
  })
  return { agent, messages, state, warnings }
}

const spentOn = async (ledger: BudgetLedger, scope = 'user:ada') =>
  (await ledger.check([scope])).scopes[0]

describe('budget ledger (spec 12 §4.1)', () => {
  test('reserves before every call, commits the actual cost, keys per step', async () => {
    const spy = spyLedger()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
      { text: 'done', usage: { inputTokens: 10, outputTokens: 20 } },
    ])
    const { agent } = setup({ model }, spy.ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(spy.calls.map((c) => c.op)).toEqual(['reserve', 'commit', 'reserve', 'commit'])
    const reserves = spy.calls.filter((c) => c.op === 'reserve').map((c) => c.args[0])
    expect(reserves).toEqual([
      { scopes: ['user:ada'], amountUsd: STEP, ttlMs: 600_000, key: expect.any(String) },
      { scopes: ['user:ada'], amountUsd: STEP, ttlMs: 600_000, key: expect.any(String) },
    ])
    const keys = reserves.map((r) => (r as { key: string }).key)
    expect(keys[0]).toMatch(/^s1:.+:0$/)
    expect(keys[1]).toMatch(/^s1:.+:1$/)
    const commits = spy.calls.filter((c) => c.op === 'commit').map((c) => c.args[1])
    expect(commits[0]).toBeCloseTo(0.005, 10)
    expect(commits[1]).toBeCloseTo(0.02, 10)
    const s = await spentOn(spy.inner)
    expect(s?.spentUsd).toBeCloseTo(0.025, 10)
    expect(s?.reservedUsd).toBe(0)
  })

  test('the default estimate prices context tokens and maxOutputTokens (4 096 when unset)', async () => {
    const spy = spyLedger()
    const pricing = () => ({ pricing: { input: 1_000, output: 1_000 } })
    const { agent } = setup(
      { model: scriptedModel([{ text: 'a' }]), models: pricing },
      spy.ledger,
      {
        estimate: undefined,
      },
    )
    await agent.session('s1').send('hello').result
    const amount = (spy.calls[0]?.args[0] as { amountUsd: number } | undefined)?.amountUsd
    // input tokens of the prompt (> 0) plus 4 096 output tokens at $1 per 1k
    expect(amount).toBeGreaterThan(4.096)
    expect(amount).toBeLessThan(4.2)

    const tight = spyLedger()
    const second = setup(
      {
        model: scriptedModel([{ text: 'a' }]),
        models: pricing,
        settings: { maxOutputTokens: 100 },
      },
      tight.ledger,
      { estimate: undefined },
    )
    await second.agent.session('s1').send('hello').result
    const small = (tight.calls[0]?.args[0] as { amountUsd: number } | undefined)?.amountUsd
    expect(small).toBeGreaterThan(0.1)
    expect(small).toBeLessThan(0.2)
  })

  test('a refused first reservation stops with cost-cap before any model call (W_BUDGET ledger)', async () => {
    const ledger = memoryBudgetLedger({ limits: { 'user:ada': 0.001 } })
    const model = looping(3)
    const { agent, warnings, messages } = setup({ model }, ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(0)
    expect(model.calls).toHaveLength(0)
    expect(warnings.filter((w) => w.code === 'W_BUDGET').map((w) => w.details)).toEqual([
      {
        scope: 'ledger',
        ledgerScope: 'user:ada',
        limitUsd: 0.001,
        spentUsd: 0,
        exceeded: true,
      },
    ])
    expect((await spentOn(ledger))?.reservedUsd).toBe(0)

    // stored like a 0.4 cost-cap before the first call (used-up session budget)
    const old = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const oldMessages = spyMessages()
    const before = defineHarnessAgent({
      model: old,
      models,
      contextWindow: 100_000,
      logger: silent,
      onWarning: () => {},
      storage: { messages: oldMessages, state: spyState() },
      budget: { maxSessionUsd: 0.004 },
    })
    const session = before.session('s1')
    await session.send('one').result
    oldMessages.saves.length = 0
    await session.send('go').result
    const shape = (saves: typeof messages.saves) =>
      saves.map((batch) =>
        batch.map((m) => ({
          role: m.role,
          parts: m.parts.map((p) => p.type),
          stop: m.metadata?.eharness?.stop,
          steps: m.metadata?.eharness?.steps,
        })),
      )
    expect(shape(messages.saves)).toEqual(shape(oldMessages.saves))
  })

  test('a refusal after some steps stops with cost-cap before the next call', async () => {
    const ledger = memoryBudgetLedger({ limits: { 'user:ada': 0.012 } })
    const model = looping(10)
    const { agent } = setup({ model }, ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(2)
    expect(model.calls).toHaveLength(2)
    const s = await spentOn(ledger)
    expect(s?.spentUsd).toBeCloseTo(0.01, 10)
    expect(s?.reservedUsd).toBe(0)
  })

  test('two agent instances sharing one ledger scope stop at the limit', async () => {
    const ledger = memoryBudgetLedger({ limits: { 'tenant:t1': 0.02 } })
    const scopes = () => ['tenant:t1']
    const a = setup({ model: looping(10, 1) }, ledger, { scopes })
    const b = setup({ model: looping(10, 1) }, ledger, { scopes })
    const [ra, rb] = await Promise.all([
      a.agent.session('a').send('go').result,
      b.agent.session('b').send('go').result,
    ])
    expect(ra.stop).toBe('cost-cap')
    expect(rb.stop).toBe('cost-cap')
    // exact estimates: no overshoot at all, 4 steps of $0.005 in total
    expect(ra.steps + rb.steps).toBe(4)
    const s = await spentOn(ledger, 'tenant:t1')
    expect(s?.spentUsd).toBeLessThanOrEqual(0.02 + 1e-12)
    expect(s?.reservedUsd).toBe(0)

    // estimates below the actual cost: overshoot of at most one estimate error per session
    const low = memoryBudgetLedger({ limits: { 'tenant:t2': 0.02 } })
    const scopes2 = () => ['tenant:t2']
    const c = setup({ model: looping(10, 1) }, low, { scopes: scopes2, estimate: () => 0.001 })
    const d = setup({ model: looping(10, 1) }, low, { scopes: scopes2, estimate: () => 0.001 })
    await Promise.all([
      c.agent.session('c').send('go').result,
      d.agent.session('d').send('go').result,
    ])
    const spent = (await spentOn(low, 'tenant:t2'))?.spentUsd ?? 0
    expect(spent).toBeLessThanOrEqual(0.02 + 2 * (STEP - 0.001) + 1e-12)
  })

  test('the wrap-up step reserves too', async () => {
    const spy = spyLedger()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
      { toolCalls: [{ toolName: 'work', input: { n: 2 } }] },
      { text: 'summary' },
    ])
    const { agent } = setup({ model, loop: { maxSteps: 2 } }, spy.ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('max-steps')
    expect(result.steps).toBe(3)
    const keys = spy.calls
      .filter((c) => c.op === 'reserve')
      .map((c) => (c.args[0] as { key: string }).key.split(':').at(-1))
    expect(keys).toEqual(['0', '1', '2'])
    expect(spy.calls.filter((c) => c.op === 'commit')).toHaveLength(3)
  })

  test('an aborted step closes its reservation (known usage or 0)', async () => {
    const spy = spyLedger()
    const model = scriptedModel([{ text: 'a long answer that is streamed slowly', delayMs: 20 }])
    const { agent } = setup({ model }, spy.ledger)
    const session = agent.session('s1')
    const run = session.send('go')
    setTimeout(() => session.abort(), 30)
    const result = await run.result
    expect(result.stop).toBe('aborted')
    const closing = spy.calls.filter((c) => c.op === 'commit' || c.op === 'release')
    expect(closing).toHaveLength(1)
    expect((await spentOn(spy.inner))?.reservedUsd).toBe(0)
  })

  test('a provider error before streaming commits 0; a turn timeout closes the reservation', async () => {
    const spy = spyLedger()
    const failing = scriptedModel([{ throws: new Error('provider down') }])
    const { agent } = setup({ model: failing }, spy.ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('error')
    expect((await spentOn(spy.inner))?.reservedUsd).toBe(0)
    expect((await spentOn(spy.inner))?.spentUsd).toBe(0)

    const slow = spyLedger()
    const t = setup(
      {
        model: scriptedModel([{ text: 'slow slow slow slow', delayMs: 30 }]),
        loop: { turnTimeoutMs: 40 },
      },
      slow.ledger,
    )
    const timed = await t.agent.session('s1').send('go').result
    expect(timed.stop).toBe('timeout')
    const reserve = slow.calls.find((c) => c.op === 'reserve')?.args[0] as { ttlMs: number }
    expect(reserve.ttlMs).toBe(40)
    expect((await spentOn(slow.inner))?.reservedUsd).toBe(0)
  })

  test("a failing ledger with onError 'stop' (default) ends the turn with EH_STORAGE", async () => {
    const spy = spyLedger()
    spy.fail.reserve = () => 'before'
    const model = looping(2)
    const { agent, messages } = setup({ model }, spy.ledger)
    const run = agent.session('s1').send('go')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.steps).toBe(0)
    expect(result.error).toMatchObject({
      code: 'EH_STORAGE',
      details: { operation: 'budget-ledger', call: 'reserve' },
    })
    expect(model.calls).toHaveLength(0)
    expect(chunks.some((c) => c.type === 'error')).toBe(true)
    const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const final = stored.find((m) => m.id === result.messageId)
    expect(final?.metadata?.eharness?.error?.code).toBe('EH_STORAGE')

    // scopes throwing is a ledger failure too
    const scopesSpy = spyLedger()
    const s = setup({ model: looping(1) }, scopesSpy.ledger, {
      scopes: () => {
        throw new Error('no user')
      },
    })
    const r = await s.agent.session('s1').send('go').result
    expect(r.error).toMatchObject({ code: 'EH_STORAGE', details: { call: 'scopes' } })
  })

  test("onError 'continue' warns W_BUDGET_LEDGER_FAILED and runs the step unreserved", async () => {
    const spy = spyLedger()
    spy.fail.reserve = () => 'before'
    spy.fail.commit = () => 'before'
    const model = scriptedModel([{ text: 'ok' }])
    const { agent, warnings } = setup({ model }, spy.ledger, { onError: 'continue' })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(model.calls).toHaveLength(1)
    expect(
      warnings.filter((w) => w.code === 'W_BUDGET_LEDGER_FAILED').map((w) => w.details),
    ).toEqual([{ operation: 'reserve' }])
    expect(spy.calls.some((c) => c.op === 'commit')).toBe(false)
  })

  test('commit failures after a step are warnings; the turn goes on', async () => {
    const spy = spyLedger()
    spy.fail.commit = () => 'before'
    const { agent, warnings } = setup(
      {
        model: scriptedModel([
          { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
          { text: 'ok' },
        ]),
      },
      spy.ledger,
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    // failed commits stay queued: retried at the next call and at the end, then charged as records
    expect(warnings.filter((w) => w.code === 'W_BUDGET_LEDGER_FAILED')).toHaveLength(4)
    const keys = spy.calls
      .filter((c) => c.op === 'record')
      .map((c) => (c.args[0] as { key: string }).key)
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => k.includes(':commit:'))).toBe(true)
  })

  test('a failed commit is retried at the next call; nothing stays reserved', async () => {
    const spy = spyLedger()
    let n = 0
    spy.fail.commit = () => (n++ === 0 ? 'before' : false) // only the first commit fails
    const { agent } = setup(
      {
        model: scriptedModel([
          { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
          { text: 'ok' },
        ]),
      },
      spy.ledger,
    )
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const committed = spy.calls.filter((c) => c.op === 'commit').map((c) => c.args[0])
    expect(committed).toHaveLength(3) // step 0 (failed), its retry, step 1
    expect(new Set(committed).size).toBe(2)
    const scope = await spentOn(spy.inner)
    expect(scope?.reservedUsd).toBe(0)
    expect(scope?.spentUsd).toBeCloseTo(2 * STEP, 6)
    expect(spy.calls.some((c) => c.op === 'release')).toBe(false)
  })

  test('addUsage (subagent, gateway cost) is recorded once at the next step boundary', async () => {
    const spy = spyLedger()
    // the first record applies but loses its answer: the retry uses the same key
    let failed = false
    spy.fail.record = () => {
      if (failed) return false
      failed = true
      return 'after'
    }
    const sub = scriptedModel([
      { text: 'sub answer', usage: { inputTokens: 0, outputTokens: 100 } },
    ])
    const subagent = tool({
      inputSchema: z.object({}),
      execute: async () => 'sub done',
    })
    const plugin = definePlugin({
      name: 'sub',
      setup: () => ({
        hooks: {
          'step.end': (ctx, e) => {
            if (e.stepIndex === 0) {
              const u = { inputTokens: 0, outputTokens: 100, totalTokens: 100 } as never
              ctx.turn?.addUsage(u, { model: sub, source: 'subagent' }) // priced: $0.1
              ctx.turn?.addUsage(u, { costUsd: 0.5, source: 'gateway' })
            }
          },
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'subagent', input: {} }] },
      { toolCalls: [{ toolName: 'subagent', input: {} }] },
      { text: 'done' },
    ])
    const { agent, warnings } = setup({ model, tools: { subagent }, plugins: [plugin] }, spy.ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const records = spy.calls.filter((c) => c.op === 'record').map((c) => c.args[0])
    const keys = records.map((r) => (r as { key: string }).key)
    // record 1 (lost answer), retried with the same key at the next boundary, then record 2
    expect(keys).toHaveLength(3)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    // the records come before the reservation of step 1
    const ops = spy.calls.map((c) => c.op)
    expect(ops.indexOf('record')).toBeLessThan(ops.lastIndexOf('reserve'))
    expect(warnings.filter((w) => w.code === 'W_BUDGET_LEDGER_FAILED')).toHaveLength(1)
    const s = await spentOn(spy.inner)
    expect(s?.spentUsd).toBeCloseTo(3 * STEP + 0.1 + 0.5, 10)
  })

  test('nested usage of the last step is recorded at the end of the turn', async () => {
    const spy = spyLedger()
    const plugin = definePlugin({
      name: 'late',
      setup: () => ({
        hooks: {
          'step.end': (ctx) => {
            const u = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never
            ctx.turn?.addUsage(u, { costUsd: 0.25, source: 'judge' })
          },
        },
      }),
    })
    const { agent } = setup(
      { model: scriptedModel([{ text: 'ok' }]), plugins: [plugin] },
      spy.ledger,
    )
    await agent.session('s1').send('go').result
    expect(spy.calls.map((c) => c.op)).toEqual(['reserve', 'commit', 'record'])
    expect((await spentOn(spy.inner))?.spentUsd).toBeCloseTo(STEP + 0.25, 10)
  })

  test('the 0.4 budgets still apply next to the ledger (first cap wins)', async () => {
    const ledger = memoryBudgetLedger()
    const { agent } = setup({ model: looping(10), budget: { maxTurnUsd: 0.012 } }, ledger)
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(3)
    expect((await spentOn(ledger))?.spentUsd).toBeCloseTo(0.015, 10)
  })

  test('an unpriced model reserves and commits 0; empty scopes skip the ledger', async () => {
    const spy = spyLedger()
    const { agent, warnings } = setup(
      { model: scriptedModel([{ text: 'ok' }]), models: undefined },
      spy.ledger,
      { estimate: undefined },
    )
    await agent.session('s1').send('go').result
    expect(
      spy.calls.map((c) => [
        c.op,
        c.op === 'reserve' ? (c.args[0] as { amountUsd: number }).amountUsd : c.args[1],
      ]),
    ).toEqual([
      ['reserve', 0],
      ['commit', 0],
    ])
    expect(warnings.map((w) => w.code)).toContain('W_MODEL_UNPRICED')

    const none = spyLedger()
    const e = setup({ model: scriptedModel([{ text: 'ok' }]) }, none.ledger, { scopes: () => [] })
    expect((await e.agent.session('s1').send('go').result).stop).toBe('complete')
    expect(none.calls).toHaveLength(0)
  })

  test('a ledger with an unlimited scope leaves the chunk stream unchanged', async () => {
    const run = async (withLedger: boolean) => {
      const model = scriptedModel([
        { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
        { text: 'done' },
      ])
      const config = { model, contextWindow: 100_000, logger: silent, models, tools: { work } }
      const agent = defineHarnessAgent(
        withLedger
          ? {
              ...config,
              budget: { ledger: { adapter: memoryBudgetLedger(), scopes: () => ['u'] } },
            }
          : config,
      )
      const r = agent.session('s1').send('go')
      return normalizeVolatile(await collect(r.stream))
    }
    expect(await run(true)).toEqual(await run(false))
  })

  test('invalid ledger config is a boot error', () => {
    expect(() =>
      defineHarnessAgent({
        model: scriptedModel([]),
        budget: { ledger: { adapter: {} as never, scopes: () => [] } },
      }),
    ).toThrow(/budget.ledger.adapter/)
    expect(() =>
      defineHarnessAgent({
        model: scriptedModel([]),
        budget: {
          ledger: { adapter: memoryBudgetLedger(), scopes: () => [], reservationTtlMs: 0 },
        },
      }),
    ).toThrow(/reservationTtlMs/)
    expect(() =>
      defineHarnessAgent({
        model: scriptedModel([]),
        budget: {
          ledger: { adapter: memoryBudgetLedger(), scopes: () => [], onError: 'open' as never },
        },
      }),
    ).toThrow(/onError/)
  })
})
