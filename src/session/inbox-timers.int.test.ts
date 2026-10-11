/**
 * `enqueue(…, { availableAt, id })` (spec 05 §12 rule 17): a durable timer and caller-supplied
 * idempotency keys, across two instances sharing one inbox.
 */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { inMemoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { sleep, until } from '../testing/test-utils.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(pollMs = 0) {
  const storage = {
    messages: defaultMemoryMessages(),
    state: defaultMemoryState(),
    inbox: inMemoryInbox(),
  }
  const model = scriptedModel([{ text: 'one' }, { text: 'two' }, { text: 'three' }])
  const make = (poll = pollMs) =>
    defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage,
      logger: silent,
      inbox: { pollMs: poll },
    })
  return { storage, model, make }
}

async function users(storage: ReturnType<typeof setup>['storage']): Promise<string[]> {
  const all = (await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  return all
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
}

describe('enqueue availableAt', () => {
  test('a future item is not delivered early and runs once due (pollMs 0)', async () => {
    const { storage, model, make } = setup()
    const agent = make()
    const session = agent.session('s1')
    const at = Date.now() + 150
    const result = await session.enqueue('fire', { availableAt: at })
    expect(result.duplicate).toBeUndefined()
    await sleep(60)
    expect(model.prompts.length).toBe(0)
    expect(await users(storage)).toEqual([])
    await until('delivered', async () => (await users(storage)).length === 1)
    expect(Date.now()).toBeGreaterThanOrEqual(at)
    expect(model.prompts.length).toBe(1)
    await agent.close()
  })

  test('an instance that did not enqueue delivers it by polling', async () => {
    const { storage, make } = setup()
    const a = make(0)
    const b = make(10)
    await b.session('s1').idle()
    await a.session('s1').enqueue('later', { availableAt: Date.now() + 80 })
    await until('delivered by b', async () => (await users(storage)).length === 1)
    await a.close()
    await b.close()
  })

  test('invalid options are EH_INVALID_INPUT', async () => {
    const { make } = setup()
    const agent = make()
    const session = agent.session('s1')
    await expect(session.enqueue('x', { availableAt: Number.NaN })).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
    await expect(
      session.enqueue('x', { availableAt: Date.now() + 1000, mode: 'collect' }),
    ).rejects.toMatchObject({ code: 'EH_INVALID_INPUT' })
    await expect(session.enqueue('x', { id: '' })).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
    await agent.close()
  })

  test('without an inbox a future availableAt is refused', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      contextWindow: 100_000,
      logger: silent,
    })
    await expect(
      agent.session('s1').enqueue('x', { availableAt: Date.now() + 10_000 }),
    ).rejects.toMatchObject({ code: 'EH_INVALID_INPUT' })
    await agent.close()
  })
})

describe('enqueue id (idempotency)', () => {
  test('a repeated id is a no-op, also after the item was processed', async () => {
    const { storage, model, make } = setup()
    const agent = make()
    const session = agent.session('s1')
    const first = await session.enqueue('fire', { id: 'sched:daily:1' })
    expect(first.duplicate).toBeUndefined()
    const repeat = await session.enqueue('fire', { id: 'sched:daily:1' })
    expect(repeat).toMatchObject({ duplicate: true, inboxId: first.inboxId })
    await until('processed', async () => (await users(storage)).length === 1)
    await session.idle()
    const late = await session.enqueue('fire', { id: 'sched:daily:1' })
    expect(late).toMatchObject({ duplicate: true, inboxId: first.inboxId })
    // another instance sharing the inbox sees the same key
    const other = make()
    const viaB = await other.session('s1').enqueue('fire', { id: 'sched:daily:1' })
    expect(viaB.duplicate).toBe(true)
    const next = await session.enqueue('fire 2', { id: 'sched:daily:2' })
    expect(next.duplicate).toBeUndefined()
    await until('second processed', async () => (await users(storage)).length === 2)
    expect(model.prompts.length).toBe(2)
    await agent.close()
    await other.close()
  })

  test('without an inbox the id dedupes within the session object', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }, { text: 'y' }]),
      contextWindow: 100_000,
      logger: silent,
    })
    const session = agent.session('s1')
    const first = await session.enqueue('a', { id: 'k' })
    const again = await session.enqueue('a', { id: 'k' })
    expect(again).toMatchObject({ duplicate: true, inboxId: first.inboxId })
    await agent.close()
  })

  test('an adapter without enqueueOnce refuses an id', async () => {
    const inner = inMemoryInbox()
    const storage = {
      messages: defaultMemoryMessages(),
      state: defaultMemoryState(),
      inbox: {
        enqueue: inner.enqueue,
        claim: inner.claim,
        ack: inner.ack,
        release: inner.release,
      },
    }
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      contextWindow: 100_000,
      storage,
      logger: silent,
    })
    await expect(agent.session('s1').enqueue('a', { id: 'k' })).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
    await agent.close()
  })
})
