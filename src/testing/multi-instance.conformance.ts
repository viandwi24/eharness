/**
 * `multiInstanceConformance`: runner-agnostic conformance cases for a whole storage backend used by
 * several agent instances ("processes") at once (spec 05 §8, §9, §12, §15; ADR-0056).
 *
 * The adapter suites (`messageAdapterConformance`, `stateAdapterConformance`,
 * `inboxAdapterConformance`) check each adapter alone. This suite runs real agents (a scripted
 * model, no network) on the same storage and checks the behaviour that only shows up with two
 * instances: answering approvals that another instance asked, steers and queued inputs enqueued
 * from another instance, held wake-ups, crash recovery by a second instance, and the session invariants after interleaved operations.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 */
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  defineHarnessAgent,
  type HarnessUIMessage,
  type HarnessWarning,
  type InboxAdapter,
  type MessageAdapter,
  type SessionLock,
  type StateAdapter,
} from '../index.ts'
import { assertTrue, uniqueSessionId } from './assert.ts'
import { scriptedModel } from './scripted-model.ts'
import { assertStoredSessionInvariants } from './session-invariants.ts'
import { sleep } from './sleep.ts'
import type { ConformanceCase } from './types.ts'

/** The storage one instance of the suite talks to. */
export interface MultiInstanceStorage {
  messages: MessageAdapter
  state: StateAdapter
  /** The durable inbox. Cases that need one are skipped when absent. */
  inbox?: InboxAdapter
  /**
   * Cross-instance mutual exclusion for turns. Optional: without it two instances race on the
   * compare-and-set commit of `state.core.activeTurn` (needs `StateAdapter.setIf`).
   */
  lock?: SessionLock
}

/** Options of {@link multiInstanceConformance}. */
export interface MultiInstanceConformanceOptions {
  /**
   * A fresh storage for one case. Called once per case; every instance of the case uses it (or the
   * view {@link MultiInstanceConformanceOptions.connect} derives from it).
   */
  makeStorage: () => MultiInstanceStorage | Promise<MultiInstanceStorage>
  /**
   * Optional: the storage as seen by instance `index` of a case (e.g. a new database connection
   * of the same database). Default: the object `makeStorage` returned, shared as is. Locks must
   * be shared by every instance (`lock.acquire` of two instances on one session must conflict).
   */
  connect?: (shared: MultiInstanceStorage, index: number) => MultiInstanceStorage
  /** Called after each case (close connections, drop the schema). */
  cleanup?: (shared: MultiInstanceStorage) => void | Promise<void>
  /** Latency of the backend in ms; raises the timeouts of the cases (default 0, i.e. in-process). */
  latencyMs?: number
}

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** Poll `condition` every few ms until it holds (rejects with `what` after `ms`). */
async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms: number,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(3)
  }
}

/** Make every call of an adapter hang once `gate.dead` is set (a process that crashed). */
function deadable<T extends object>(inner: T, gate: { dead: boolean }): T {
  return new Proxy(inner, {
    get(target, key) {
      const value = (target as Record<string | symbol, unknown>)[key]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (gate.dead) return key === 'subscribe' ? () => {} : new Promise(() => {})
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

type Instance = ReturnType<typeof instanceOf>

function instanceOf(
  shared: MultiInstanceStorage,
  index: number,
  options: MultiInstanceConformanceOptions,
  config: {
    model: ReturnType<typeof scriptedModel>
    tools: NonNullable<Parameters<typeof defineHarnessAgent>[0]['tools']>
    instanceId?: string
    lock?: boolean
    warnings: HarnessWarning[]
  },
) {
  const gate = { dead: false }
  const storage = options.connect?.(shared, index) ?? shared
  const latency = options.latencyMs ?? 0
  const agent = defineHarnessAgent({
    model: config.model,
    contextWindow: 100_000,
    tools: config.tools,
    approval: { policy: { pay: 'user-approval' } },
    storage: {
      messages: deadable(storage.messages, gate),
      state: deadable(storage.state, gate),
      ...(storage.inbox === undefined ? {} : { inbox: deadable(storage.inbox, gate) }),
    },
    inbox: { pollMs: 10 + latency },
    recovery: {
      staleMs: 150 + latency * 4,
      abortPollMs: 20 + latency,
      ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
    },
    debug: { invariants: true },
    logger: silent,
    onWarning: (w) => config.warnings.push(w),
  })
  const lock =
    storage.lock === undefined || config.lock === false
      ? undefined
      : (deadable(storage.lock, gate) as unknown as SessionLock)
  const session = (id: string) => agent.session(id, lock === undefined ? {} : { lock })
  return { agent, session, gate, index }
}

function tools(
  log: { paid: number; slow: number },
  hold?: { release: () => void; gate: Promise<void> },
) {
  return {
    pay: tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        log.paid++
        return 'paid'
      },
    }),
    slow: tool({
      inputSchema: z.object({}),
      execute: async () => {
        log.slow++
        await (hold?.gate ?? sleep(20))
        return 'slow ok'
      },
    }),
    ask: tool({ inputSchema: z.object({ q: z.string() }) }),
  }
}

function holdGate() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, gate }
}

const payCall = { toolCalls: [{ toolName: 'pay', input: { amount: 5 }, toolCallId: 'pay-1' }] }
const slowCall = { toolCalls: [{ toolName: 'slow', input: {}, toolCallId: 'slow-1' }] }

/**
 * Conformance cases for a storage backend shared by several agent instances. See the module
 * comment for what is covered; a case that needs a durable inbox (or a lock) is skipped, not
 * failed, when `makeStorage` returns none.
 *
 * @example
 * ```ts
 * for (const c of multiInstanceConformance({ makeStorage: () => postgresStorage(pool) })) {
 *   test(c.name, c.run)
 * }
 * ```
 * @see docs/engineering/testing.md#multi-instance-conformance
 */
export function multiInstanceConformance(
  options: MultiInstanceConformanceOptions,
): ConformanceCase[] {
  const timeout = 3_000 + (options.latencyMs ?? 0) * 40

  /** Run `body` on a fresh storage; always clean up. */
  const withStorage =
    (needs: { inbox?: boolean; lock?: boolean }, body: (ctx: Ctx) => Promise<void>) =>
    async (): Promise<void> => {
      const shared = await options.makeStorage()
      if (needs.inbox === true && shared.inbox === undefined) return
      if (needs.lock === true && shared.lock === undefined) return
      const sessionId = uniqueSessionId('mi')
      const instances: Instance[] = []
      const warnings: HarnessWarning[] = []
      const ctx: Ctx = {
        shared,
        sessionId,
        warnings,
        timeout,
        open(config) {
          const instance = instanceOf(shared, instances.length, options, {
            ...config,
            warnings,
          })
          instances.push(instance)
          return instance
        },
        async stored() {
          return (await shared.messages.load({ sessionId })) as HarnessUIMessage[]
        },
        async invariants(quiescent: boolean) {
          const state = await shared.state.get(sessionId)
          await assertStoredSessionInvariants(state, await ctx.stored(), { quiescent })
        },
      }
      try {
        await body(ctx)
        const hard = warnings.filter((w) => w.code === 'W_INVALID_MESSAGE')
        assertTrue(hard.length === 0, `invalid messages were saved: ${hard.map((w) => w.message)}`)
      } finally {
        for (const instance of instances) {
          if (instance.gate.dead) continue
          await instance.agent.close()
        }
        await options.cleanup?.(shared)
      }
    }

  interface Ctx {
    shared: MultiInstanceStorage
    sessionId: string
    warnings: HarnessWarning[]
    timeout: number
    open(config: {
      model: ReturnType<typeof scriptedModel>
      tools: NonNullable<Parameters<typeof defineHarnessAgent>[0]['tools']>
      instanceId?: string
      lock?: boolean
    }): Instance
    stored(): Promise<HarnessUIMessage[]>
    invariants(quiescent: boolean): Promise<void>
  }

  const texts = (messages: HarnessUIMessage[]): string[] =>
    messages
      .filter((m) => m.role === 'user' && m.metadata?.eharness?.kind === undefined)
      .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))

  return [
    {
      name: 'multi-instance: B reads the turn A ran (messages, stats, no stored active turn)',
      run: withStorage({}, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const model = scriptedModel([{ text: 'hello from A' }])
        const a = ctx.open({ model, tools: tools(log) })
        const b = ctx.open({ model: scriptedModel([]), tools: tools(log) })
        const result = await a.session(ctx.sessionId).send('hi').result
        assertTrue(result.stop === 'complete', `A stopped ${result.stop}`)
        const seen = await b.session(ctx.sessionId).messages()
        assertTrue(seen.length === 2, `B sees ${seen.length} messages, expected 2`)
        const stats = await b.session(ctx.sessionId).stats()
        assertTrue(stats.activeTurn === null && stats.pending === null, 'B sees leftovers of A')
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: an approval A asked is answered by B; the tool runs exactly once',
      run: withStorage({}, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const a = ctx.open({
          model: scriptedModel([payCall, { text: 'unused' }]),
          tools: tools(log),
        })
        const b = ctx.open({ model: scriptedModel([{ text: 'paid, done' }]), tools: tools(log) })
        const first = await a.session(ctx.sessionId).send('pay please').result
        assertTrue(first.stop === 'tool-pending', `A stopped ${first.stop}`)
        const approvalId = first.pending?.approvals[0]?.approvalId as string
        const answered = await b
          .session(ctx.sessionId)
          .respond({ approvals: [{ id: approvalId, approved: true }] }).result
        assertTrue(answered.stop === 'complete', `B stopped ${answered.stop}`)
        assertTrue(log.paid === 1, `the tool ran ${log.paid} times`)
        // the answer is consumed once: a second answer (from A) is stale, never executes again
        const again = await a
          .session(ctx.sessionId)
          .respond({ approvals: [{ id: approvalId, approved: true }] }).result
        assertTrue(again.stop === 'error', 'a second answer must be rejected')
        assertTrue(log.paid === 1, 'the tool ran again on a second answer')
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: two partial answers from two instances complete the pending state once',
      run: withStorage({}, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const both = {
          toolCalls: [
            { toolName: 'pay', input: { amount: 1 }, toolCallId: 'pay-a' },
            { toolName: 'ask', input: { q: 'x' }, toolCallId: 'ask-a' },
          ],
        }
        const a = ctx.open({
          model: scriptedModel([both, { text: 'finished' }]),
          tools: tools(log),
        })
        const b = ctx.open({ model: scriptedModel([{ text: 'finished' }]), tools: tools(log) })
        const first = await a.session(ctx.sessionId).send('go').result
        assertTrue(first.stop === 'tool-pending', `A stopped ${first.stop}`)
        const approvalId = first.pending?.approvals[0]?.approvalId as string
        const partial = await a
          .session(ctx.sessionId)
          .respond({ toolOutputs: [{ toolCallId: 'ask-a', output: 'answer' }] }).result
        assertTrue(partial.partial === true, 'the first answer must be recorded as partial')
        const done = await b
          .session(ctx.sessionId)
          .respond({ approvals: [{ id: approvalId, approved: true }] }).result
        assertTrue(done.stop === 'complete', `B stopped ${done.stop}`)
        assertTrue(log.paid === 1, `the tool ran ${log.paid} times`)
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: a steer enqueued by B is delivered into the running turn of A (inbox)',
      run: withStorage({ inbox: true }, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const hold = holdGate()
        const model = scriptedModel([slowCall, { text: 'done' }])
        const a = ctx.open({ model, tools: tools(log, hold) })
        const b = ctx.open({ model: scriptedModel([]), tools: tools(log) })
        const run = a.session(ctx.sessionId).send('go')
        await until('the tool runs', () => log.slow > 0, ctx.timeout)
        const enqueued = await b
          .session(ctx.sessionId)
          .enqueue('also check logs', { mode: 'steer' })
        assertTrue(enqueued.target === 'remote', `target ${enqueued.target}`)
        await sleep(30 + (options.latencyMs ?? 0) * 4)
        hold.release()
        const result = await run.result
        assertTrue(result.stop === 'complete', `A stopped ${result.stop}`)
        assertTrue(model.calls.length === 2, `the model was called ${model.calls.length} times`)
        const stored = await ctx.stored()
        const inputs = stored
          .flatMap((m) => m.parts)
          .filter((p) => p.type === 'data-eh.input').length
        assertTrue(inputs === 1, `the steer is stored ${inputs} times`)
        await until(
          'the inbox is empty',
          async () => {
            const s = await ctx.shared.inbox?.stats?.({ sessionId: ctx.sessionId })
            return s === undefined || s.ready + s.claimed + s.delayed === 0
          },
          ctx.timeout,
        )
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: an input queued by B runs exactly once, after the turn of A (inbox)',
      run: withStorage({ inbox: true }, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const hold = holdGate()
        const model = scriptedModel([slowCall, { text: 'first' }, { text: 'second' }])
        const a = ctx.open({ model, tools: tools(log, hold) })
        const b = ctx.open({ model: scriptedModel([]), tools: tools(log) })
        const run = a.session(ctx.sessionId).send('go')
        await until('the tool runs', () => log.slow > 0, ctx.timeout)
        await b.session(ctx.sessionId).enqueue('then this', { mode: 'queue' })
        hold.release()
        await run.result
        await until(
          'the queued input ran',
          async () => texts(await ctx.stored()).includes('then this'),
          ctx.timeout,
        )
        await sleep(40 + (options.latencyMs ?? 0) * 4)
        const count = texts(await ctx.stored()).filter((t) => t === 'then this').length
        assertTrue(count === 1, `the queued input is stored ${count} times`)
        assertTrue(model.calls.length === 3, `the model was called ${model.calls.length} times`)
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: a wake held behind pending approvals runs once after B answers (inbox)',
      run: withStorage({ inbox: true }, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const a = ctx.open({ model: scriptedModel([payCall]), tools: tools(log) })
        const model = scriptedModel([{ text: 'paid' }, { text: 'saw the event' }])
        const b = ctx.open({ model, tools: tools(log) })
        const first = await a.session(ctx.sessionId).send('pay').result
        assertTrue(first.stop === 'tool-pending', `A stopped ${first.stop}`)
        const injected = await a
          .session(ctx.sessionId)
          .inject('eh.event', { name: 'bg', text: 'a background job finished' }, { wake: true })
        assertTrue(injected.run === undefined, 'a wake must not start a turn while approvals wait')
        await sleep(40 + (options.latencyMs ?? 0) * 4)
        const stats = await b.session(ctx.sessionId).stats()
        assertTrue(stats.pending !== null, 'the pending state was consumed by the wake')
        const approvalId = first.pending?.approvals[0]?.approvalId as string
        const answered = await b
          .session(ctx.sessionId)
          .respond({ approvals: [{ id: approvalId, approved: true }] }).result
        assertTrue(answered.stop === 'complete', `B stopped ${answered.stop}`)
        await until('the wake ran', () => model.calls.length >= 2, ctx.timeout)
        await sleep(40 + (options.latencyMs ?? 0) * 4)
        assertTrue(model.calls.length === 2, `the model was called ${model.calls.length} times`)
        assertTrue(log.paid === 1, `the tool ran ${log.paid} times`)
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: a send that waits in B starts after A answers the approvals (inbox)',
      run: withStorage({ inbox: true }, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const hold = holdGate()
        const a = ctx.open({
          model: scriptedModel([{ text: 'paid' }]),
          tools: tools(log),
        })
        const model = scriptedModel([slowCall, payCall, { text: 'waited, then ran' }])
        const b = ctx.open({ model, tools: tools(log, hold) })
        const turn = b.session(ctx.sessionId).send('first')
        await until('the tool runs', () => log.slow > 0, ctx.timeout)
        const waiting = b.session(ctx.sessionId).send('second', { ifBusy: 'wait' })
        hold.release()
        const first = await turn.result
        assertTrue(first.stop === 'tool-pending', `B stopped ${first.stop}`)
        const approvalId = first.pending?.approvals[0]?.approvalId as string
        // A (another instance) answers; B's held send must notice and run
        const answered = await a
          .session(ctx.sessionId)
          .respond({ approvals: [{ id: approvalId, approved: true }] }).result
        assertTrue(answered.stop === 'complete', `A stopped ${answered.stop}`)
        const waited = await Promise.race([
          waiting.result,
          sleep(ctx.timeout).then(() => undefined),
        ])
        assertTrue(waited !== undefined, 'the waiting send never ran (held queue stuck)')
        await ctx.invariants(true)
      }),
    },
    {
      name: 'multi-instance: B recovers the turn of a crashed A; the tool is not re-executed (lock or stale heartbeat)',
      run: withStorage({}, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const hold = holdGate()
        const a = ctx.open({
          model: scriptedModel([slowCall, { text: 'never' }]),
          tools: tools(log, hold),
          lock: false,
        })
        const b = ctx.open({
          model: scriptedModel([{ text: 'after the crash' }]),
          tools: tools(log),
          lock: false,
        })
        const run = a.session(ctx.sessionId).send('go')
        void run.result.catch(() => {})
        await until('the tool runs', () => log.slow > 0, ctx.timeout)
        a.gate.dead = true // the process dies mid-turn: nothing of A reaches the storage any more
        // a crashed process releases its lock (lease expiry); the suite models that by letting a
        // lock-less backend rely on the stale heartbeat and a locking one on its own lease
        await sleep(200 + (options.latencyMs ?? 0) * 8)
        const slow = log.slow
        const recovered = await until(
          'B recovered the turn',
          async () => {
            const result = await b.session(ctx.sessionId).recover()
            return result.recovered
          },
          ctx.timeout + 2_000,
        ).then(
          () => true,
          () => false,
        )
        assertTrue(recovered, 'B could not recover the interrupted turn')
        assertTrue(log.slow === slow, 'the interrupted tool was executed again')
        const after = await b.session(ctx.sessionId).send('are you there?').result
        assertTrue(after.stop === 'complete', `B stopped ${after.stop}`)
        await ctx.invariants(true)
        hold.release()
      }),
    },
    {
      name: 'multi-instance: concurrent sends from two instances never overlap or duplicate; the invariants hold',
      run: withStorage({ lock: true }, async (ctx) => {
        const log = { paid: 0, slow: 0 }
        const model = scriptedModel([
          { text: 'r1', delayMs: 5 },
          { text: 'r2', delayMs: 5 },
          { text: 'r3', delayMs: 5 },
          { text: 'r4', delayMs: 5 },
        ])
        const a = ctx.open({ model, tools: tools(log) })
        const b = ctx.open({ model, tools: tools(log) })
        const runs = [
          a.session(ctx.sessionId).send('from A 1'),
          b.session(ctx.sessionId).send('from B 1'),
          a.session(ctx.sessionId).send('from A 2', { ifBusy: 'wait' }),
          b.session(ctx.sessionId).send('from B 2', { ifBusy: 'wait' }),
        ]
        const results = await Promise.all(runs.map((r) => r.result))
        const complete = results.filter((r) => r.stop === 'complete').length
        assertTrue(complete >= 1, 'no send completed')
        for (const r of results) {
          assertTrue(
            r.stop === 'complete' || r.error?.code === 'EH_SESSION_BUSY',
            `unexpected outcome ${r.stop} ${r.error?.code}`,
          )
        }
        const stored = await ctx.stored()
        const sent = texts(stored)
        assertTrue(new Set(sent).size === sent.length, `a user message is stored twice: ${sent}`)
        assertTrue(model.calls.length === complete, 'every completed turn made exactly one call')
        await ctx.invariants(true)
      }),
    },
  ]
}
