/**
 * `reconcileBackgroundChildren` (spec 20 §3.6, ADR-0056): a hard crash leaves a child turn
 * active with a dead owner; a restarted instance (stable `recovery.instanceId`) repairs it and
 * the parent gets exactly one report. Two agent instances over shared storage stand for two
 * processes.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, type HarnessAgent } from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { reconcileBackgroundChildren, subagent } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} } // biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
type Steps = Parameters<typeof scriptedModel>[0]

const newStorage = () => ({
  messages: inMemoryMessages(),
  state: inMemoryState(),
  inbox: inMemoryInbox(),
})
type Storage = ReturnType<typeof newStorage>

const spawn = {
  toolName: 'agent',
  toolCallId: 'call-1',
  input: {
    subagent_type: 'worker',
    description: 'review',
    prompt: 'review the change',
    name: 'reviewer',
    run_in_background: true,
  },
}

function processOf(
  storage: Storage,
  o: {
    main: Steps
    worker: Steps
    instanceId?: string
    deadWorker?: boolean
    gate?: Promise<void>
  },
) {
  const holder: { main?: Agent; worker?: Agent } = {}
  const gated = tool({
    inputSchema: z.object({}),
    execute: async () => {
      await (o.gate ?? new Promise(() => {}))
      return 'gate open'
    },
  })
  const recovery = o.instanceId === undefined ? {} : { recovery: { instanceId: o.instanceId } }
  const worker = defineHarnessAgent({
    model: scriptedModel(o.worker),
    contextWindow: 100_000,
    storage:
      o.deadWorker === true
        ? { ...storage, inbox: { ...storage.inbox, claim: async () => [] } }
        : storage,
    logger: silent,
    inbox: { pollMs: 20 },
    tools: { gated } as never,
    ...recovery,
    plugins: [
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.main as Agent,
        selfAgent: () => holder.worker as Agent,
      }),
    ] as never,
  }) as Agent
  holder.worker = worker
  const mainModel = scriptedModel(o.main)
  const main = defineHarnessAgent({
    model: mainModel,
    contextWindow: 100_000,
    storage,
    logger: silent,
    inbox: { pollMs: 20 },
    ...recovery,
    plugins: [
      subagent({
        agents: { worker: { agent: worker, description: 'does work' } },
        approvals: 'park',
        background: true,
        selfAgent: () => holder.main as Agent,
      }),
    ] as never,
  }) as Agent
  holder.main = main
  return { main, worker, mainModel }
}

type Part = { type: string; data?: { name?: string; text?: string; data?: { status?: string } } }
const events = async (agent: Agent, id: string) =>
  (await agent.session(id).messages())
    .flatMap((m) => m.parts as Part[])
    .filter((p) => p.type === 'data-eh.event' && p.data?.name === 'subagent')

describe('reconcileBackgroundChildren', () => {
  test('hard crash: the restarted instance repairs the child and reports once', async () => {
    const storage = newStorage()
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    // process A: the child stops inside a tool and the process dies (never closed, never finishes)
    const a = processOf(storage, {
      main: [{ toolCalls: [spawn] }, { text: 'started' }],
      worker: [{ toolCalls: [{ toolName: 'gated', toolCallId: 'g1', input: {} }] }],
      gate,
    })
    await a.main.session('m').send('go').result
    const childId = (await a.main.session('m').children())[0]?.sessionId as string
    expect(childId).toBeDefined()
    await until('child turn active', async () => {
      return (await a.worker.peek(childId).stats()).activeTurn !== null
    })

    // process B over the same storage (A never ends)
    // (the dead owner's heartbeat is long past: the stale rule of spec 05 §9)
    const dead = (await storage.state.get(childId)) as unknown as {
      core: { activeTurn: { heartbeatAt: number } }
    }
    dead.core.activeTurn.heartbeatAt = 0
    await storage.state.set(childId, dead as never)
    const b = processOf(storage, {
      main: [{ text: 'noted the interruption' }],
      worker: [],
    })
    const parent = b.main.session('m')
    const first = await reconcileBackgroundChildren(parent, {
      openChild: (id) => b.worker.session(id),
    })
    expect(first[0]).toMatchObject({ outcome: 'reported', status: 'interrupted', recovered: true })
    const stored = await events(b.main, 'm')
    expect(stored.filter((e) => e.data?.data?.status === 'interrupted')).toHaveLength(1)
    // the child is usable again
    expect((await b.worker.peek(childId).stats()).activeTurn).toBeNull()
    // idempotent: a second pass (and a pass on another instance) adds nothing
    await reconcileBackgroundChildren(parent, { openChild: (id) => b.worker.session(id) })
    const c = processOf(storage, { main: [], worker: [] })
    await reconcileBackgroundChildren(c.main.session('m'), {
      openChild: (id) => c.worker.session(id),
    })
    expect(
      (await events(b.main, 'm')).filter((e) => e.data?.data?.status === 'interrupted'),
    ).toHaveLength(1)
    // the parent was woken by the report
    await until('parent answered', async () =>
      JSON.stringify(await b.main.session('m').messages()).includes('noted the interruption'),
    )
    open()
    await b.main.close()
    await c.main.close()
  })

  test('a child that never started is reported after the grace period', async () => {
    const storage = newStorage()
    const a = processOf(storage, {
      deadWorker: true,
      main: [{ toolCalls: [spawn] }, { text: 'started' }],
      worker: [],
    })
    await a.main.session('m').send('go').result
    const parent = a.main.session('m')
    const early = await reconcileBackgroundChildren(parent, {
      openChild: (id) => a.worker.session(id),
    })
    expect(early[0]?.outcome).toBe('running')
    const late = await reconcileBackgroundChildren(parent, {
      openChild: (id) => a.worker.session(id),
      now: () => Date.now() + 120_000,
    })
    expect(late[0]).toMatchObject({ outcome: 'reported', status: 'not_started' })
    await reconcileBackgroundChildren(parent, {
      openChild: (id) => a.worker.session(id),
      now: () => Date.now() + 130_000,
    })
    expect(
      (await events(a.main, 'm')).filter((e) => e.data?.data?.status === 'not_started'),
    ).toHaveLength(1)
    await a.main.close()
  })

  test('a running child past timeoutMs gets one timed-out report', async () => {
    const storage = newStorage()
    const a = processOf(storage, {
      main: [{ toolCalls: [spawn] }, { text: 'started' }],
      worker: [{ toolCalls: [{ toolName: 'gated', toolCallId: 'g1', input: {} }] }],
    })
    await a.main.session('m').send('go').result
    const childId = (await a.main.session('m').children())[0]?.sessionId as string
    await until(
      'child running',
      async () => (await a.worker.peek(childId).stats()).activeTurn !== null,
    )
    const run = () =>
      reconcileBackgroundChildren(a.main.session('m'), {
        openChild: (id) => a.worker.session(id),
        timeoutMs: 60_000,
        now: () => Date.now() + 10 * 60_000,
      })
    expect((await run())[0]).toMatchObject({ outcome: 'reported', status: 'timed_out' })
    await run()
    expect(
      (await events(a.main, 'm')).filter((e) => e.data?.data?.status === 'timed_out'),
    ).toHaveLength(1)
  })
})
