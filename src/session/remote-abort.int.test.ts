/**
 * Cross-process abort (spec 05 §9.1): two agent instances ("processes") share one message store
 * and one state store; instance B stops the turn that runs in instance A.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { SessionStateSnapshot, StateAdapter } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { collect } from './int-kit.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'
import { requestRemoteAbort } from './remote-abort.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Shared storage with call counting, optional random delays and an optional missing `setIf`. */
function sharedStorage(options: { setIf?: boolean; jitterMs?: number } = {}) {
  const inner = defaultMemoryState()
  const messages = defaultMemoryMessages()
  const writes: SessionStateSnapshot[] = []
  const counts = { gets: 0 }
  const jitter = async () => {
    if (options.jitterMs !== undefined) await sleep(Math.random() * options.jitterMs)
  }
  const state: StateAdapter = {
    async get(id) {
      counts.gets++
      await jitter()
      return inner.get(id)
    },
    async set(id, snapshot) {
      await jitter()
      writes.push(structuredClone(snapshot))
      return inner.set(id, snapshot)
    },
  }
  if (options.setIf !== false) {
    state.setIf = async (id, snapshot, rev) => {
      await jitter()
      const ok = (await inner.setIf?.(id, snapshot, rev)) ?? false
      if (ok) writes.push(structuredClone(snapshot))
      return ok
    }
  }
  return { messages, state, inner, writes, counts }
}

type Storage = ReturnType<typeof sharedStorage>

function instance(
  storage: Storage,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: storage.messages, state: storage.state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, warnings }
}

/** A tool that resolves only when the turn's abort signal fires. */
function waitTool() {
  const seen = { started: false, aborted: false }
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const wait = tool({
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }) =>
      new Promise<string>((resolve) => {
        seen.started = true
        markStarted()
        abortSignal?.addEventListener('abort', () => {
          seen.aborted = true
          resolve('cancelled')
        })
      }),
  })
  return { wait, started, seen }
}

const waitCall = { toolCalls: [{ toolName: 'wait', input: {} }] }

async function stored(storage: Storage): Promise<SessionStateSnapshot | null> {
  return storage.inner.get('s1')
}

describe('cross-process abort (spec 05 §9.1)', () => {
  test("B's requestAbort stops A's turn at the next step boundary", async () => {
    const storage = sharedStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const step = tool({
      inputSchema: z.object({}),
      execute: async () => {
        markStarted()
        await gate // ignores the abort signal: the turn stops at the boundary after it
        return 'ok'
      },
    })
    const stepCall = { toolCalls: [{ toolName: 'step', input: {} }] }
    const model = scriptedModel([stepCall, stepCall, stepCall, { text: 'done' }])
    const a = instance(storage, { model, tools: { step }, recovery: { abortPollMs: 1 } })
    const b = instance(storage, { model: scriptedModel([]) })

    const run = a.agent.session('s1').send('go')
    const chunks = collect(run.stream)
    await started
    const requested = await b.agent.session('s1').requestAbort('user stop')
    expect(requested).toEqual({ target: 'remote' })
    expect((await stored(storage))?.core.abortRequest).toMatchObject({
      turnId: run.turnId,
      reason: 'user stop',
    })
    await sleep(2)
    release()

    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(model.prompts.length).toBe(1) // stopped before the second model call
    expect((await chunks).at(-1)).toEqual({ type: 'abort', reason: 'user stop' })
    const saved = (await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const assistant = saved.find((m) => m.id === result.messageId)
    expect(assistant?.metadata?.eharness?.stop).toBe('aborted')
    expect(assistant?.parts.some((p) => p.type === 'tool-step')).toBe(true) // partial saved
    const state = await stored(storage)
    expect(state?.core.activeTurn).toBeUndefined()
    expect(state?.core.abortRequest).toBeUndefined()
  })

  test('a long tool call is aborted by the heartbeat poll (its abortSignal fires)', async () => {
    const storage = sharedStorage()
    const { wait, started, seen } = waitTool()
    const model = scriptedModel([waitCall, { text: 'never' }])
    const a = instance(storage, { model, tools: { wait }, recovery: { abortPollMs: 5 } })
    const b = instance(storage, { model: scriptedModel([]) })

    const session = a.agent.session('s1')
    const run = session.send('go')
    await started
    expect(await b.agent.session('s1').requestAbort()).toEqual({ target: 'remote' })
    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(seen.aborted).toBe(true)
    expect(model.prompts.length).toBe(1)

    // the poll / heartbeat timer is gone with the turn: no reads after it ended
    const gets = storage.counts.gets
    await sleep(25)
    expect(storage.counts.gets).toBe(gets)
    await session.close()
  })

  test('abort() of an instance without the turn requests the remote abort', async () => {
    const storage = sharedStorage()
    const { wait, started } = waitTool()
    const a = instance(storage, {
      model: scriptedModel([waitCall]),
      tools: { wait },
      recovery: { abortPollMs: 5 },
    })
    const b = instance(storage, { model: scriptedModel([]) })
    const run = a.agent.session('s1').send('go')
    await started
    b.agent.session('s1').abort('from b')
    expect((await run.result).stop).toBe('aborted')
    expect((await collect(run.stream)).at(-1)).toEqual({ type: 'abort', reason: 'from b' })
  })

  test("a remote abort drops the owner's queue and reports waiting steers", async () => {
    const storage = sharedStorage()
    const { wait, started } = waitTool()
    const a = instance(storage, {
      model: scriptedModel([waitCall, { text: 'never' }]),
      tools: { wait },
      recovery: { abortPollMs: 5 },
    })
    const b = instance(storage, { model: scriptedModel([]) })
    const session = a.agent.session('s1')
    const events: Array<{ type: string; reason?: string }> = []
    const reader = session.events().getReader()
    void (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value as { type: string; reason?: string })
      }
    })()
    const run = session.send('go')
    await started
    const queued = session.send('later', { ifBusy: 'queue' })
    session.send('steer me', { ifBusy: 'steer' })
    expect(await b.agent.session('s1').requestAbort()).toEqual({ target: 'remote' })
    expect((await run.result).stop).toBe('aborted')
    expect((await queued.result).stop).toBe('aborted')
    await session.idle()
    expect(events.some((e) => e.type === 'input-dropped' && e.reason === 'aborted')).toBe(true)
    await session.close()
  })

  test('a request for another turn id never aborts the running turn and is cleared', async () => {
    const storage = sharedStorage()
    // a stale request left behind (e.g. by a crashed owner) before the session is opened
    await storage.inner.set('s1', {
      v: 1,
      rev: 1,
      core: { abortRequest: { turnId: 'old-turn', at: 1 } },
      plugins: {},
    })
    let foreign = false
    const step = tool({
      inputSchema: z.object({}),
      execute: async () => {
        if (!foreign) {
          foreign = true
          // another instance writes a request for an older turn while this one runs
          const current = (await storage.inner.get('s1')) as SessionStateSnapshot
          await storage.inner.setIf?.(
            's1',
            {
              ...current,
              rev: current.rev + 1,
              core: { ...current.core, abortRequest: { turnId: 'older-turn', at: 2 } },
            },
            current.rev,
          )
        }
        await sleep(5)
        return 'ok'
      },
    })
    const stepCall = { toolCalls: [{ toolName: 'step', input: {} }] }
    const model = scriptedModel([stepCall, stepCall, { text: 'done' }])
    const a = instance(storage, {
      model,
      tools: { step },
      recovery: { staleMs: 8, abortPollMs: 1 },
    })
    const result = await a.agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(model.prompts.length).toBe(3)
    // the commit-point write cleared the first stale request
    expect(storage.writes[0]?.core.abortRequest).toBeUndefined()
    const state = await stored(storage)
    expect(state?.core.abortRequest).toBeUndefined()
    expect(state?.core.activeTurn).toBeUndefined()
  })

  test("A's heartbeat write racing B's request keeps the request (CAS merge) and aborts", async () => {
    const storage = sharedStorage()
    const { wait, started, seen } = waitTool()
    // heartbeats every ~5 ms; the poll never runs: only the merge of a conflicting write aborts
    const a = instance(storage, {
      model: scriptedModel([waitCall]),
      tools: { wait },
      recovery: { staleMs: 20, abortPollMs: 60_000 },
    })
    const b = instance(storage, { model: scriptedModel([]) })
    const run = a.agent.session('s1').send('go')
    await started
    await sleep(8) // let a heartbeat write happen first
    expect(await b.agent.session('s1').requestAbort('race')).toEqual({ target: 'remote' })
    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(seen.aborted).toBe(true)

    const requestAt = storage.writes.findIndex((w) => w.core.abortRequest?.by !== undefined)
    expect(requestAt).toBeGreaterThan(0)
    const afterRequest = storage.writes.slice(requestAt + 1)
    // A's next write (a heartbeat while the turn still runs) kept B's request
    const heartbeat = afterRequest.find((w) => w.core.activeTurn !== undefined)
    if (heartbeat !== undefined) expect(heartbeat.core.abortRequest?.reason).toBe('race')
    // the end-of-turn write cleared it
    const last = storage.writes.at(-1)
    expect(last?.core.activeTurn).toBeUndefined()
    expect(last?.core.abortRequest).toBeUndefined()
  })

  test("an adapter without setIf → 'unsupported' + W_ABORT_UNSUPPORTED, nothing written", async () => {
    const storage = sharedStorage({ setIf: false })
    const { wait, started } = waitTool()
    const a = instance(storage, {
      model: scriptedModel([waitCall]),
      tools: { wait },
      recovery: { abortPollMs: 1 },
    })
    const b = instance(storage, { model: scriptedModel([]) })
    const session = a.agent.session('s1')
    const run = session.send('go')
    await started
    const gets = storage.counts.gets
    const writes = storage.writes.length
    expect(await b.agent.session('s1').requestAbort()).toEqual({ target: 'unsupported' })
    expect(b.warnings.map((w) => w.code)).toContain('W_ABORT_UNSUPPORTED')
    expect(storage.writes.length).toBe(writes)
    await sleep(10)
    // the owner does not poll: nobody can write a request
    expect(storage.counts.gets).toBe(gets + 1)
    session.abort()
    expect((await run.result).stop).toBe('aborted')
  })

  test("idle session → 'idle'; local turn → 'local'; recovery: false → 'unsupported'", async () => {
    const storage = sharedStorage()
    const { wait, started } = waitTool()
    const a = instance(storage, { model: scriptedModel([waitCall]), tools: { wait } })
    const session = a.agent.session('s1')
    expect(await session.requestAbort()).toEqual({ target: 'idle' })
    expect(storage.writes.length).toBe(0)

    const run = session.send('go')
    await started
    expect(await session.requestAbort('mine')).toEqual({ target: 'local' })
    expect((await run.result).stop).toBe('aborted')
    // finished turn: nothing to abort anywhere
    const writes = storage.writes.length
    expect(await a.agent.session('s1').requestAbort()).toEqual({ target: 'idle' })
    expect(storage.writes.length).toBe(writes)

    const off = instance(storage, { model: scriptedModel([]), recovery: false })
    expect(await off.agent.session('s1').requestAbort()).toEqual({ target: 'unsupported' })
    expect(off.warnings.map((w) => w.code)).toContain('W_ABORT_UNSUPPORTED')
  })

  test("a stale active turn (dead owner) → 'idle', nothing written", async () => {
    const storage = sharedStorage()
    await storage.inner.set('s1', {
      v: 1,
      rev: 3,
      core: {
        activeTurn: {
          turnId: 't-dead',
          kind: 'send',
          messageId: 'm',
          owner: 'dead',
          startedAt: 1,
          heartbeatAt: Date.now() - 10_000,
        },
      },
      plugins: {},
    })
    const b = instance(storage, { model: scriptedModel([]), recovery: { staleMs: 1_000 } })
    expect(await b.agent.session('s1').requestAbort()).toEqual({ target: 'idle' })
    expect((await stored(storage))?.rev).toBe(3)
  })

  test('abortPollMs: 0 → no state reads during the turn', async () => {
    const storage = sharedStorage()
    const step = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(4)
        return 'ok'
      },
    })
    const stepCall = { toolCalls: [{ toolName: 'step', input: {} }] }
    const a = instance(storage, {
      model: scriptedModel([stepCall, stepCall, stepCall, { text: 'done' }]),
      tools: { step },
      recovery: { abortPollMs: 0 },
    })
    const session = a.agent.session('s1')
    await session.ready()
    const gets = storage.counts.gets
    expect((await session.send('go').result).stop).toBe('complete')
    expect(storage.counts.gets).toBe(gets)
  })

  test('hot turn I/O budget: at most one state read per abortPollMs', async () => {
    const storage = sharedStorage()
    const step = tool({
      inputSchema: z.object({}),
      execute: async () => {
        await sleep(6)
        return 'ok'
      },
    })
    const stepCall = { toolCalls: [{ toolName: 'step', input: {} }] }
    const a = instance(storage, {
      model: scriptedModel([stepCall, stepCall, stepCall, stepCall, stepCall, { text: 'done' }]),
      tools: { step },
      recovery: { abortPollMs: 10 },
    })
    const session = a.agent.session('s1')
    await session.ready()
    const gets = storage.counts.gets
    const startedAt = Date.now()
    expect((await session.send('go').result).stop).toBe('complete')
    const elapsed = Date.now() - startedAt
    const reads = storage.counts.gets - gets
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(Math.floor(elapsed / 10) + 1)
  })

  test('no lost update of abortRequest, pending or grants under randomized delays', async () => {
    for (let round = 0; round < 5; round++) {
      const storage = sharedStorage({ jitterMs: 3 })
      await storage.inner.set('s1', {
        v: 1,
        rev: 1,
        core: { grants: { deploy: 'always' } },
        plugins: { app: { note: 'kept' } },
      })
      const { wait, started, seen } = waitTool()
      const a = instance(storage, {
        model: scriptedModel([waitCall]),
        tools: { wait },
        recovery: { staleMs: 12, abortPollMs: 3 },
      })
      const b = instance(storage, { model: scriptedModel([]) })
      const run = a.agent.session('s1').send('go')
      await started
      await sleep(Math.random() * 6)
      const results = await Promise.all([
        b.agent.session('s1').requestAbort('r1'),
        b.agent.session('s1').requestAbort('r2'),
      ])
      for (const r of results) expect(r.target).toBe('remote')
      expect((await run.result).stop).toBe('aborted')
      expect(seen.aborted).toBe(true)
      const state = await stored(storage)
      expect(state?.core.grants).toEqual({ deploy: 'always' })
      expect(state?.plugins.app).toEqual({ note: 'kept' })
      expect(state?.core.activeTurn).toBeUndefined()
      expect(state?.core.abortRequest).toBeUndefined()
      expect(state?.core.pending).toBeUndefined()
    }
  })
})

describe('requestRemoteAbort', () => {
  const live = (turnId: string) => ({
    turnId,
    kind: 'send' as const,
    messageId: 'm',
    owner: 'a',
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  })

  test('a retry that finds another turn active returns idle (a late Stop never kills it)', async () => {
    const reads: SessionStateSnapshot[] = [
      { v: 1, rev: 1, core: { activeTurn: live('t1') }, plugins: {} },
      { v: 1, rev: 3, core: { activeTurn: live('t2') }, plugins: {} },
    ]
    let writes = 0
    const adapter: StateAdapter = {
      get: async () => structuredClone(reads.shift() ?? null),
      set: async () => {},
      setIf: async () => {
        writes++
        return false // t1 ended and t2 committed meanwhile
      },
    }
    const result = await requestRemoteAbort(
      { sessionId: 's1', adapter, owner: 'b', staleMs: 60_000, warn: () => {} },
      undefined,
    )
    expect(result).toEqual({ target: 'idle' })
    expect(writes).toBe(1)
  })

  test('gives up with EH_SESSION_BUSY after 3 conflicting retries', async () => {
    let writes = 0
    const adapter: StateAdapter = {
      get: async () => ({ v: 1, rev: writes, core: { activeTurn: live('t1') }, plugins: {} }),
      set: async () => {},
      setIf: async () => {
        writes++
        return false
      },
    }
    await expect(
      requestRemoteAbort(
        { sessionId: 's1', adapter, owner: 'b', staleMs: 60_000, warn: () => {} },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'EH_SESSION_BUSY' })
    expect(writes).toBe(4)
  })
})
