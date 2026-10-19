/**
 * The storage-concurrency paths (inbox driver, commit point, abort, lock) under `chaosStorage`:
 * seeded rev conflicts, lock contention, lost claims, slow calls and lost leases, with several
 * agent instances on one shared storage.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { SessionLock } from '../agent/session-types.ts'
import type { HarnessWarning } from '../errors.ts'
import { HarnessError } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { type ChaosStorageOptions, chaosStorage } from '../testing/chaos-storage.ts'
import { inboxAdapterConformance } from '../testing/inbox-adapter.conformance.ts'
import { messageAdapterConformance } from '../testing/message-adapter.conformance.ts'
import { multiInstanceConformance } from '../testing/multi-instance.conformance.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { assertStoredSessionInvariants } from '../testing/session-invariants.ts'
import { stateAdapterConformance } from '../testing/state-adapter.conformance.ts'
import { sleep, until } from '../testing/test-utils.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function memoryLock(): SessionLock {
  const held = new Map<string, symbol>()
  return {
    async acquire(sessionId: string) {
      if (held.has(sessionId)) throw new HarnessError('EH_SESSION_BUSY', 'locked')
      const owner = Symbol(sessionId)
      held.set(sessionId, owner)
      return async () => {
        if (held.get(sessionId) === owner) held.delete(sessionId)
      }
    },
  }
}

function baseStorage() {
  return {
    messages: inMemoryMessages(),
    state: inMemoryState(),
    inbox: inMemoryInbox(),
    lock: memoryLock(),
  }
}

describe('chaosStorage', () => {
  test('is deterministic for a seed and injects each kind of fault', async () => {
    const run = async (seed: number) => {
      const s = chaosStorage(baseStorage(), { seed, conflictRate: 0.5 })
      const out: boolean[] = []
      for (let i = 0; i < 24; i++) {
        try {
          const release = await (s.lock as SessionLock).acquire('x', {
            signal: new AbortController().signal,
          })
          await release()
          out.push(true)
        } catch {
          out.push(false)
        }
      }
      return { out, conflicts: s.faults.conflicts }
    }
    const a = await run(3)
    expect(await run(3)).toEqual(a)
    expect((await run(4)).out).not.toEqual(a.out)
    expect(a.conflicts).toBeGreaterThan(0)
  })

  test('a lost lease frees the lock and the late release is a no-op', async () => {
    const s = chaosStorage(baseStorage())
    const signal = new AbortController().signal
    const releaseA = await (s.lock as SessionLock).acquire('s', { signal })
    expect(await s.expireLease('s')).toBe(true)
    const releaseB = await (s.lock as SessionLock).acquire('s', { signal })
    await releaseA() // late release of the dead holder
    await expect((s.lock as SessionLock).acquire('s', { signal })).rejects.toThrow()
    await releaseB()
    expect(s.faults.leasesExpired).toBe(1)
  })
})

describe('adapter conformance under chaos (slow calls)', () => {
  const slow = (): ChaosStorageOptions => ({ seed: 5, delayMs: 3 })
  for (const c of messageAdapterConformance(() => chaosStorage(baseStorage(), slow()).messages, {
    requireLastId: true,
  })) {
    test(`messages: ${c.name}`, c.run, 20_000)
  }
  for (const c of stateAdapterConformance(() => chaosStorage(baseStorage(), slow()).state, {
    requireSetIf: true,
  })) {
    test(`state: ${c.name}`, c.run, 20_000)
  }
  for (const c of inboxAdapterConformance(
    () => chaosStorage(baseStorage(), slow()).inbox as ReturnType<typeof inMemoryInbox>,
    {
      requireNotify: true,
      requirePending: true,
      requireRetry: true,
      requireDeadLetter: true,
      requireStats: true,
      requireDedupe: true,
    },
  )) {
    test(`inbox: ${c.name}`, c.run, 20_000)
  }
})

describe('multi-instance conformance under chaos (lost inbox claims and slow calls)', () => {
  for (const seed of [1, 2, 3]) {
    const makeStorage = () =>
      chaosStorage(baseStorage(), { seed, conflictRate: 0.3, conflictPorts: ['inbox'], delayMs: 3 })
    for (const c of multiInstanceConformance({ makeStorage, latencyMs: 12 })) {
      test(`seed ${seed}: ${c.name}`, c.run, 30_000)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// Multi-instance scenarios

const payCall = { toolCalls: [{ toolName: 'pay', input: { amount: 5 }, toolCallId: 'pay-1' }] }

function instance(
  storage: ReturnType<typeof chaosStorage>,
  model: ReturnType<typeof scriptedModel>,
  log: { runs: number },
  extra: {
    lock?: boolean
    hold?: Promise<void>
    onTool?: () => void
    warnings?: HarnessWarning[]
    id?: string
  } = {},
) {
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    tools: {
      slow: tool({
        inputSchema: z.object({}),
        execute: async () => {
          log.runs++
          extra.onTool?.()
          await (extra.hold ?? sleep(15))
          return 'slow ok'
        },
      }),
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async () => {
          log.runs++
          return 'paid'
        },
      }),
    },
    approval: { policy: { pay: 'user-approval' } },
    storage: { messages: storage.messages, state: storage.state, inbox: storage.inbox },
    inbox: { pollMs: 10, claimTtlMs: 300 },
    recovery: {
      staleMs: 150,
      abortPollMs: 15,
      ...(extra.id === undefined ? {} : { instanceId: extra.id }),
    },
    debug: { invariants: true },
    logger: silent,
    onWarning: (w) => extra.warnings?.push(w),
  })
  const open = (id: string) =>
    agent.session(
      id,
      extra.lock === false || storage.lock === undefined ? {} : { lock: storage.lock },
    )
  return { agent, open }
}

async function verify(storage: ReturnType<typeof chaosStorage>, sessionId: string) {
  const messages = (await storage.inner.messages.load({ sessionId })) as HarnessUIMessage[]
  const state = await storage.inner.state.get(sessionId)
  await assertStoredSessionInvariants(state, messages, { quiescent: true })
  return messages
}

const userTexts = (messages: HarnessUIMessage[]): string[] =>
  messages
    .filter((m) => m.role === 'user' && m.metadata?.eharness?.kind === undefined)
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))

const slowCall = (id: string) => ({
  toolCalls: [{ toolName: 'slow', input: {}, toolCallId: id }],
})

describe('multi-instance scenarios under chaos', () => {
  for (const seed of [11, 12, 13, 14]) {
    test(`seed ${seed}: concurrent sends from three instances; BUSY only as contention, nothing lost or doubled`, async () => {
      const storage = chaosStorage(baseStorage(), { seed, conflictRate: 0.25, delayMs: 5 })
      const log = { runs: 0 }
      const warnings: HarnessWarning[] = []
      const model = scriptedModel(
        Array.from({ length: 12 }, (_, i) => ({ text: `r${i}`, delayMs: 3 })),
      )
      const inst = [0, 1, 2].map((i) => instance(storage, model, log, { warnings, id: `i${i}` }))
      const sid = `chaos-send-${seed}`
      const runs = []
      for (let round = 0; round < 3; round++) {
        for (const [i, x] of inst.entries()) {
          runs.push(
            x.open(sid).send(`m-${round}-${i}`, { ifBusy: round === 0 ? 'reject' : 'wait' }),
          )
        }
      }
      const results = await Promise.all(runs.map((r) => r.result))
      let complete = 0
      for (const r of results) {
        if (r.stop === 'complete') complete++
        else expect(r.error?.code).toBe('EH_SESSION_BUSY')
      }
      // the storage is not wedged: once the chaos stops, a send completes
      storage.set({ conflictRate: 0 })
      const settled = await inst[0]?.open(sid).send('after the chaos').result
      expect(settled?.stop).toBe('complete')
      complete++
      const stored = await verify(storage, sid)
      const texts = userTexts(stored)
      expect(new Set(texts).size).toBe(texts.length)
      expect(model.calls.length).toBe(complete)
      expect(texts.length).toBe(complete)
      expect(warnings.filter((w) => w.code === 'W_INVARIANT_VIOLATION')).toEqual([])
      for (const x of inst) await x.agent.close()
    }, 30_000)
  }

  for (const seed of [21, 22, 23]) {
    test(`seed ${seed}: a steer and a queued input enqueued from other instances are applied exactly once under conflicts`, async () => {
      // calm until the turn runs (a commit-point conflict ends a send with EH_SESSION_BUSY)
      const storage = chaosStorage(baseStorage(), { seed, delayMs: 4 })
      const log = { runs: 0 }
      let release!: () => void
      const hold = new Promise<void>((r) => {
        release = r
      })
      const model = scriptedModel([slowCall('s-1'), { text: 'first' }, { text: 'second' }])
      const warnings: HarnessWarning[] = []
      const a = instance(storage, model, log, { hold, warnings, id: 'a' })
      // one script: whichever instance claims the queued input runs it
      const b = instance(storage, model, log, { warnings, id: 'b' })
      const c = instance(storage, model, log, { warnings, id: 'c' })
      const sid = `chaos-inbox-${seed}`
      const run = a.open(sid).send('go')
      await until('the tool runs', () => log.runs > 0)
      storage.set({ conflictRate: 0.3, failRate: 0.15 })
      await b.open(sid).enqueue('steer me', { mode: 'steer' })
      await c.open(sid).enqueue('then this', { mode: 'queue' })
      release()
      expect((await run.result).stop).toBe('complete')
      await until(
        'both inputs applied',
        async () => {
          const texts = userTexts(
            (await storage.inner.messages.load({ sessionId: sid })) as HarnessUIMessage[],
          )
          const steered = (await storage.inner.messages.load({ sessionId: sid }))
            .flatMap((m) => m.parts)
            .some((p) => p.type === 'data-eh.input')
          return texts.includes('then this') && steered
        },
        15_000,
      )
      // let redelivered (failed ack) items settle: they must not apply twice
      storage.set({ conflictRate: 0, failRate: 0 })
      await until(
        'the inbox drained',
        async () => {
          const s = await storage.inner.inbox?.stats?.({ sessionId: sid })
          return s === undefined || s.ready + s.claimed + s.delayed === 0
        },
        15_000,
      )
      await sleep(60)
      const stored = await verify(storage, sid)
      const texts = userTexts(stored)
      expect(texts.filter((t) => t === 'then this')).toHaveLength(1)
      const inputs = stored.flatMap((m) => m.parts).filter((p) => p.type === 'data-eh.input')
      expect(inputs).toHaveLength(1)
      expect(warnings.filter((w) => w.code === 'W_INVARIANT_VIOLATION')).toEqual([])
      for (const x of [a, b, c]) await x.agent.close()
    }, 40_000)
  }

  test('an abort requested from another instance stops the turn under conflicts; the tool call is answered', async () => {
    const storage = chaosStorage(baseStorage(), { seed: 31, delayMs: 3 })
    const log = { runs: 0 }
    const never = new Promise<void>(() => {})
    const a = instance(storage, scriptedModel([slowCall('s-9'), { text: 'never' }]), log, {
      hold: never,
      id: 'a',
    })
    const b = instance(storage, scriptedModel([]), log, { id: 'b' })
    const sid = 'chaos-abort'
    const run = a.open(sid).send('go')
    await until('the tool runs', () => log.runs > 0)
    storage.set({ conflictRate: 0.3 })
    let how = (await b.open(sid).abort()).target
    for (let i = 0; i < 20 && how !== 'remote'; i++) {
      await sleep(10)
      how = (await b.open(sid).abort()).target
    }
    expect(how).toBe('remote')
    const result = await run.result
    expect(['aborted', 'error']).toContain(result.stop)
    storage.set({ conflictRate: 0 })
    await until('no active turn stored', async () => {
      const state = await storage.inner.state.get(sid)
      return state?.core?.activeTurn === undefined || state.core.activeTurn === null
    })
    await verify(storage, sid)
    for (const x of [a, b]) await x.agent.close()
  }, 30_000)

  test('a lost lease mid-turn: a second instance takes over; the interrupted tool is not re-executed', async () => {
    const storage = chaosStorage(baseStorage(), { seed: 41, delayMs: 3 })
    const log = { runs: 0 }
    const never = new Promise<void>(() => {})
    const a = instance(storage, scriptedModel([slowCall('s-7'), { text: 'never' }]), log, {
      hold: never,
      id: 'a',
    })
    const b = instance(storage, scriptedModel([{ text: 'recovered' }, { text: 'again' }]), log, {
      id: 'b',
    })
    const sid = 'chaos-lease'
    const run = a.open(sid).send('go')
    void run.result.catch(() => {})
    await until('the tool runs', () => log.runs > 0)
    expect(await storage.expireLease(sid)).toBe(true)
    storage.set({ conflictRate: 0.2 })
    // A is stuck in its tool (a hung process); B must be able to take the session over
    let recovered = false
    await until(
      'B recovers',
      async () => {
        try {
          recovered = (await b.open(sid).recover()).recovered
        } catch {
          // contention or a conflict: try again
        }
        return recovered
      },
      15_000,
    )
    const runsAtRecovery = log.runs
    storage.set({ conflictRate: 0 })
    const next = await b.open(sid).send('are you there?').result
    expect(next.stop).toBe('complete')
    expect(log.runs).toBe(runsAtRecovery)
    await verify(storage, sid)
    await b.agent.close()
  }, 30_000)

  test('persistEachStep upserts survive conflicting state writes: one message per id, every call answered', async () => {
    const storage = chaosStorage(baseStorage(), { seed: 51, delayMs: 3 })
    const log = { runs: 0 }
    const model = scriptedModel([
      slowCall('p-1'),
      slowCall('p-2'),
      slowCall('p-3'),
      { text: 'done' },
    ])
    const a = instance(storage, model, log, {
      id: 'a',
      onTool: () => storage.set({ conflictRate: 0.4 }),
    })
    const sid = 'chaos-steps'
    const result = await a.open(sid).send('go').result
    expect(['complete', 'error']).toContain(result.stop)
    storage.set({ conflictRate: 0 })
    const stored = await verify(storage, sid)
    expect(storage.faults.conflicts).toBeGreaterThan(0)
    expect(new Set(stored.map((m) => m.id)).size).toBe(stored.length)
    await a.agent.close()
  }, 30_000)

  test('approvals answered from two instances while the state conflicts execute the tool once', async () => {
    const storage = chaosStorage(baseStorage(), { seed: 61, conflictRate: 0.3, delayMs: 3 })
    const log = { runs: 0 }
    const a = instance(storage, scriptedModel([payCall]), log, { id: 'a' })
    const b = instance(storage, scriptedModel([{ text: 'paid' }]), log, { id: 'b' })
    const c = instance(storage, scriptedModel([{ text: 'paid' }]), log, { id: 'c' })
    const sid = 'chaos-approve'
    let first = await a.open(sid).send('pay').result
    for (let i = 0; i < 10 && first.stop !== 'tool-pending'; i++) {
      first = await a.open(sid).send('pay again').result
    }
    expect(first.stop).toBe('tool-pending')
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const answers = await Promise.all(
      [b, c].map(
        (x) => x.open(sid).respond({ approvals: [{ id: approvalId, approved: true }] }).result,
      ),
    )
    expect(answers.filter((r) => r.stop === 'complete').length).toBeLessThanOrEqual(1)
    expect(log.runs).toBeLessThanOrEqual(1)
    storage.set({ conflictRate: 0 })
    await verify(storage, sid)
    for (const x of [a, b, c]) await x.agent.close()
  }, 30_000)
})

describe('a failed inbox ack or release is retried by the drain', () => {
  // Regression: the owner still held the claim, every claim of the same owner renewed it, so an
  // item whose ack/release failed stayed claimed for as long as the instance lived.
  for (const failing of ['ack'] as const) {
    test(`a failed ${failing} does not leave the item claimed`, async () => {
      const inbox = inMemoryInbox()
      let failures = 1
      const flaky = {
        ...inbox,
        async [failing](ids: string[], opts?: never) {
          if (failures-- > 0) throw new Error(`injected ${failing} failure`)
          return (inbox[failing] as (i: string[], o?: never) => Promise<void>)(ids, opts)
        },
      }
      const warnings: HarnessWarning[] = []
      const agent = defineHarnessAgent({
        model: scriptedModel([{ text: 'one' }, { text: 'two' }]),
        contextWindow: 100_000,
        storage: { messages: inMemoryMessages(), state: inMemoryState(), inbox: flaky },
        inbox: { pollMs: 10 }, // default claim TTL: a stuck claim would outlive the test
        logger: silent,
        onWarning: (w) => warnings.push(w),
      })
      const session = agent.session(`flaky-${failing}`)
      await session.enqueue('hello', { mode: 'queue' })
      await until('the inbox drained', async () => {
        const s = await inbox.stats?.({ sessionId: `flaky-${failing}` })
        return s !== undefined && s.ready + s.claimed + s.delayed === 0
      })
      expect(warnings.some((w) => w.code === 'W_INBOX_FAILED')).toBe(true)
      await agent.close()
    }, 10_000)
  }
})
