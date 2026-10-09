import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { MessageAdapter, StateAdapter } from '../agent/session-types.ts'
import { isHarnessError } from '../errors.ts'
import { createUuidV7Generator, uuidv7 } from '../messages/ids.ts'
import { createKindMessage } from '../messages/kinds.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

/** Sorts after every generated id. */
const LAST_ID = 'ffffffff-ffff-7fff-bfff-ffffffffffff'
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(steps: Array<{ text: string } | { toolCalls: never }> = []) {
  const messages = memoryMessages()
  const state = memoryState()
  const model = scriptedModel([
    ...(steps as never[]),
    ...Array.from({ length: 12 }, (_, i) => ({ text: `answer ${i}` })),
  ])
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: () => {},
  })
  return { agent, messages, state }
}

async function turn(agent: ReturnType<typeof setup>['agent'], id: string, text: string) {
  const result = await agent.session(id).send(text).result
  if (result.stop !== 'complete') throw new Error(`turn stopped: ${result.stop}`)
  return result
}

const ids = (messages: HarnessUIMessage[]) => messages.map((m) => m.id)

async function rejection(promise: Promise<unknown>): Promise<{ code: string; reason?: unknown }> {
  try {
    await promise
  } catch (error) {
    if (isHarnessError(error)) {
      return { code: error.code, reason: (error.details as { reason?: unknown })?.reason }
    }
    throw error
  }
  throw new Error('expected a rejection')
}

async function patchState(
  state: StateAdapter,
  id: string,
  patch: (core: Record<string, unknown>, snapshot: { plugins: Record<string, never> }) => void,
) {
  const stored = await state.get(id)
  if (stored === null) throw new Error('no state')
  patch(stored.core as Record<string, unknown>, stored as never)
  await state.set(id, stored)
}

async function history(messages: MessageAdapter, id: string) {
  return (await messages.load({ sessionId: id })) as HarnessUIMessage[]
}

describe('session.fork()', () => {
  test('copies every message (ids kept), the state that stays valid and records the lineage', async () => {
    const { agent, messages, state } = setup()
    await turn(agent, 's1', 'one')
    await turn(agent, 's1', 'two')
    await patchState(state, 's1', (core, snapshot) => {
      core.grants = { 'bash:*': 'always' }
      snapshot.plugins = { app: { note: 'x' } } as never
    })
    const source = await history(messages, 's1')
    expect(source).toHaveLength(4)

    const fork = await agent.session('s1').fork({ id: 'f1' })
    expect(fork.id).toBe('f1')
    expect(agent.session('f1')).toBe(fork) // the cached, opened handle
    expect(await history(messages, 'f1')).toEqual(source)

    const stored = await state.get('f1')
    expect(stored?.core.usage).toEqual((await state.get('s1'))?.core.usage)
    expect(stored?.core.grants).toEqual({ 'bash:*': 'always' })
    expect(stored?.plugins).toEqual({ app: { note: 'x' } })
    expect(stored?.core.forkedFrom).toEqual({ sessionId: 's1', at: expect.any(Number) })
    expect(stored?.core.activeTurn).toBeUndefined()
    // the source is untouched
    expect(await history(messages, 's1')).toEqual(source)
    expect((await state.get('s1'))?.core.forkedFrom).toBeUndefined()
  })

  test('generates an id and continues the conversation independently', async () => {
    const { agent, messages } = setup()
    await turn(agent, 's1', 'one')
    const fork = await agent.session('s1').fork()
    expect(fork.id).not.toBe('s1')
    await turn(agent, fork.id, 'two (fork)')
    expect(await history(messages, fork.id)).toHaveLength(4)
    expect(await history(messages, 's1')).toHaveLength(2)
    // new ids still sort after the copied ones
    const copied = ids(await history(messages, fork.id))
    expect([...copied].sort()).toEqual(copied)
  })

  test('beforeMessageId copies the messages strictly before it', async () => {
    const { agent, messages, state } = setup()
    await turn(agent, 's1', 'one')
    await turn(agent, 's1', 'two')
    const source = await history(messages, 's1')
    const secondUser = source[2] as HarnessUIMessage
    const fork = await agent.session('s1').fork({ id: 'f1', beforeMessageId: secondUser.id })
    expect(ids(await history(messages, 'f1'))).toEqual(ids(source.slice(0, 2)))
    expect((await state.get('f1'))?.core.forkedFrom).toEqual({
      sessionId: 's1',
      beforeMessageId: secondUser.id,
      at: expect.any(Number),
    })
    expect(await fork.messages()).toHaveLength(2)
    // a cut before the first message is an empty session
    const empty = await agent
      .session('s1')
      .fork({ id: 'f0', beforeMessageId: (source[0] as HarnessUIMessage).id })
    expect(await empty.messages()).toEqual([])
  })

  test('copies large histories in batches', async () => {
    const messages = memoryMessages()
    const all: HarnessUIMessage[] = []
    for (let i = 0; i < 450; i++) {
      all.push({
        id: uuidv7(),
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `m${i}` }],
      })
    }
    await messages.save('big', all)
    const saved: number[] = []
    const spy: MessageAdapter = {
      ...messages,
      load: (q) => messages.load(q),
      save: async (id, batch) => {
        if (id === 'big-fork') saved.push(batch.length)
        return messages.save(id, batch)
      },
    }
    const spied = defineHarnessAgent({
      model: scriptedModel([]),
      contextWindow: 100_000,
      storage: { messages: spy, state: memoryState() },
      logger: silent,
    })
    await spied.session('big').fork({ id: 'big-fork' })
    expect(saved).toEqual([200, 200, 50])
    expect(ids(await history(messages, 'big-fork'))).toEqual(ids(all))
  })

  test('compaction: the pointer follows the newest marker that was copied', async () => {
    const { agent, messages, state } = setup()
    await turn(agent, 's1', 'one')
    await turn(agent, 's1', 'two')
    const before = await history(messages, 's1')
    const marker = createKindMessage(
      'eh.compaction',
      {
        summary: 'one and two happened',
        resumeFromId: (before[2] as HarnessUIMessage).id,
        tokens: { before: 10, after: 5 },
        trigger: 'manual',
      },
      { id: createUuidV7Generator()((before.at(-1) as HarnessUIMessage).id) },
    )
    await messages.save('s1', [marker])
    await agent.closeSession('s1')
    await turn(agent, 's1', 'three')
    expect((await state.get('s1'))?.core.compaction?.markerId).toBe(marker.id)
    const source = await history(messages, 's1')
    const thirdUser = source.find((m) => m.id > marker.id && m.role === 'user') as HarnessUIMessage

    // cut after the marker: marker copied, pointer valid
    await agent.session('s1').fork({ id: 'after', beforeMessageId: thirdUser.id })
    expect((await history(messages, 'after')).some((m) => m.id === marker.id)).toBe(true)
    expect((await state.get('after'))?.core.compaction).toEqual({
      markerId: marker.id,
      resumeFromId: (before[2] as HarnessUIMessage).id,
    })
    expect(
      ((await agent.session('after').stats()) as { messages: number }).messages,
    ).toBeGreaterThan(0)

    // cut before the marker: marker not copied, no pointer
    await agent.session('s1').fork({ id: 'cut', beforeMessageId: marker.id })
    expect((await history(messages, 'cut')).some((m) => m.id === marker.id)).toBe(false)
    expect((await state.get('cut'))?.core.compaction).toBeUndefined()

    // the whole session keeps its pointer
    await agent.session('s1').fork({ id: 'whole' })
    expect((await state.get('whole'))?.core.compaction?.markerId).toBe(marker.id)
  })

  test('rewinds: the mirror lists only the rewind markers that were copied', async () => {
    const { agent, messages, state } = setup()
    await turn(agent, 's1', 'one')
    await agent.session('s1').regenerate().result
    const source = await history(messages, 's1')
    const rewind = source.find(
      (m) => m.metadata?.eharness?.kind === 'eh.rewind',
    ) as HarnessUIMessage
    expect(rewind).toBeDefined()
    const whole = await agent.session('s1').fork({ id: 'whole' })
    expect((await state.get('whole'))?.core.rewinds).toEqual([
      { afterId: expect.anything(), rewindId: rewind.id },
    ])
    // the rewound answer stays hidden in the fork
    expect(await whole.messages()).toEqual(await agent.session('s1').messages())
    await agent.session('s1').fork({ id: 'cut', beforeMessageId: rewind.id })
    expect((await state.get('cut'))?.core.rewinds).toBeUndefined()
    expect((await history(messages, 'cut')).some((m) => m.id === rewind.id)).toBe(false)
  })

  test('copyState none copies no state, only the lineage', async () => {
    const { agent, state } = setup()
    await turn(agent, 's1', 'one')
    await patchState(state, 's1', (core, snapshot) => {
      core.grants = { a: 'always' }
      snapshot.plugins = { app: { k: 1 } } as never
    })
    await agent.session('s1').fork({ id: 'f1', copyState: 'none' })
    const stored = await state.get('f1')
    expect(stored?.plugins).toEqual({})
    expect(Object.keys(stored?.core ?? {})).toEqual(['forkedFrom'])
  })

  test('never copies activeTurn, pending, abortRequest or inbox bookkeeping', async () => {
    const { agent, state } = setup()
    await turn(agent, 's1', 'one')
    await patchState(state, 's1', (core) => {
      core.abortRequest = { turnId: 't', at: 1 }
      core.inboxDelivered = ['a']
      core.parent = { sessionId: 'p', turnId: 't', depth: 1 }
      core.children = [{ sessionId: 'c', turnId: 't', createdAt: 1 }]
      // a stale unfinished turn that is newer than the cut
      core.activeTurn = {
        turnId: 't',
        kind: 'send',
        messageId: 'zzzz-after-everything',
        owner: 'dead',
        startedAt: 1,
        heartbeatAt: 1,
      }
    })
    await agent.session('s1').fork({ id: 'f1', beforeMessageId: LAST_ID })
    const core = (await state.get('f1'))?.core ?? {}
    expect(Object.keys(core).sort()).toEqual(['forkedFrom', 'usage'].sort())
  })

  test('refuses a copy that includes an unfinished turn or a pending message', async () => {
    const { agent, messages, state } = setup()
    await turn(agent, 's1', 'one')
    await turn(agent, 's1', 'two')
    const source = await history(messages, 's1')
    const assistant2 = source[3] as HarnessUIMessage
    await patchState(state, 's1', (core) => {
      core.pending = { messageId: assistant2.id, approvals: [], clientTools: [] }
    })
    expect(await rejection(agent.session('s1').fork())).toEqual({
      code: 'EH_INVALID_INPUT',
      reason: 'pending',
    })
    // a cut after the pending message includes it too
    expect((await rejection(agent.session('s1').fork({ beforeMessageId: LAST_ID }))).reason).toBe(
      'pending',
    )
    // a cut at or before the pending message leaves it out
    const ok = await agent.session('s1').fork({ id: 'f1', beforeMessageId: assistant2.id })
    expect((await state.get(ok.id))?.core.pending).toBeUndefined()
    expect(await history(messages, 'f1')).toHaveLength(3)
    // nothing was stored by the refused forks
    expect(await state.get('s1')).not.toBeNull()

    await patchState(state, 's1', (core) => {
      delete core.pending
      core.activeTurn = {
        turnId: 't',
        kind: 'send',
        messageId: assistant2.id,
        owner: 'dead',
        startedAt: 1,
        heartbeatAt: 1,
      }
    })
    expect((await rejection(agent.session('s1').fork())).reason).toBe('active-turn')
  })

  test('refuses while a turn runs, here or in another instance', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = tool({
      description: 'wait',
      inputSchema: z.object({}),
      execute: async () => {
        await gate
        return 'ok'
      },
    })
    const messages = memoryMessages()
    const state = memoryState()
    const make = () =>
      defineHarnessAgent({
        model: scriptedModel([{ toolCalls: [{ toolName: 'slow', input: {} }] }, { text: 'done' }]),
        contextWindow: 100_000,
        tools: { slow },
        storage: { messages, state },
        logger: silent,
      })
    const a = make()
    const b = make()
    const run = a.session('s1').send('go')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await rejection(a.session('s1').fork())).code).toBe('EH_SESSION_BUSY')
    expect((await rejection(b.session('s1').fork())).code).toBe('EH_SESSION_BUSY')
    release()
    await run.result
    const fork = await b.session('s1').fork({ id: 'f1' })
    expect((await fork.messages()).length).toBe(2)
  })

  test('refuses an existing, live or own id and a closed session', async () => {
    const { agent } = setup()
    await turn(agent, 's1', 'one')
    await agent.session('s1').fork({ id: 'f1' })
    expect((await rejection(agent.session('s1').fork({ id: 'f1' }))).reason).toBe('exists')
    expect((await rejection(agent.session('s1').fork({ id: 's1' }))).reason).toBe('same-id')
    agent.session('live')
    expect((await rejection(agent.session('s1').fork({ id: 'live' }))).reason).toBe('exists')
    expect((await rejection(agent.session('s1').fork({ id: '' }))).code).toBe('EH_INVALID_INPUT')
    const session = agent.session('s1')
    await agent.closeSession('s1')
    expect((await rejection(session.fork())).code).toBe('EH_SESSION_CLOSED')
  })

  test('forks work from another instance sharing the storage (restart)', async () => {
    const messages = memoryMessages()
    const state = memoryState()
    const make = () =>
      defineHarnessAgent({
        model: scriptedModel([{ text: 'hi' }]),
        contextWindow: 100_000,
        storage: { messages, state },
        logger: silent,
      })
    await make().session('s1').send('one').result
    const fork = await make().session('s1').fork({ id: 'f1' })
    expect(await fork.messages()).toHaveLength(2)
  })
})
