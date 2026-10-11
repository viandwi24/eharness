/**
 * `enqueue(…, { id, metadata })`: the caller id reaches the turn (`ctx.turn.source`,
 * `metadata.eharness.inboxKey`) and app metadata lands in `metadata.app` (spec 05 §12).
 */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type { HarnessContext, TurnSource } from '../plugin/types.ts'
import { inMemoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

const appOf = (m: HarnessUIMessage | undefined): unknown =>
  (m?.metadata as { app?: unknown } | undefined)?.app

for (const durable of [false, true]) {
  describe(`enqueue source and metadata (${durable ? 'durable inbox' : 'local'})`, () => {
    function setup() {
      const storage = {
        messages: defaultMemoryMessages(),
        state: defaultMemoryState(),
        ...(durable ? { inbox: inMemoryInbox() } : {}),
      }
      const sources: Array<TurnSource | undefined> = []
      const agent = defineHarnessAgent({
        model: scriptedModel([{ text: 'one' }, { text: 'two' }]),
        contextWindow: 100_000,
        storage,
        logger: silent,
        inbox: { pollMs: 0 },
        plugins: [
          definePlugin({
            name: 'probe',
            setup: () => ({
              hooks: {
                'turn.start': (ctx: HarnessContext) => void sources.push(ctx.turn?.source),
              },
            }),
          }),
        ],
      })
      return { storage, sources, agent }
    }
    const users = async (storage: ReturnType<typeof setup>['storage']) =>
      ((await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]).filter(
        (m) => m.role === 'user',
      )

    test('caller id and metadata reach the turn and the stored message', async () => {
      const { storage, sources, agent } = setup()
      const session = agent.session('s1')
      const result = await session.enqueue('fire', {
        id: 'sched:r1:1',
        metadata: { routine: { id: 'r1', name: 'Morning briefing' } },
      })
      await until('user stored', async () => (await users(storage)).length === 1)
      const [user] = await users(storage)
      expect(user?.metadata?.eharness?.inboxId).toBe(result.inboxId)
      expect(user?.metadata?.eharness?.inboxKey).toBe('sched:r1:1')
      expect(appOf(user)).toEqual({
        routine: { id: 'r1', name: 'Morning briefing' },
      })
      await until('hook ran', () => sources.length === 1)
      expect(sources[0]).toEqual({
        kind: 'inbox',
        id: result.inboxId,
        ids: [result.inboxId],
        key: 'sched:r1:1',
        keys: ['sched:r1:1'],
      })
    })

    test('without id there is no key; without metadata there is no app', async () => {
      const { storage, sources, agent } = setup()
      const result = await agent.session('s1').enqueue('plain')
      await until('user stored', async () => (await users(storage)).length === 1)
      const [user] = await users(storage)
      expect(user?.metadata?.eharness?.inboxKey).toBeUndefined()
      expect(appOf(user)).toBeUndefined()
      await until('hook ran', () => sources.length === 1)
      expect(sources[0]).toMatchObject({ id: result.inboxId, keys: [] })
      expect(sources[0]?.key).toBeUndefined()
    })

    test('a collect burst lists every id and key and merges metadata', async () => {
      const { storage, sources, agent } = setup()
      const session = agent.session('s1')
      const collect = { quietMs: 20, maxWaitMs: 200 }
      await session.enqueue('a', { mode: 'collect', collect, id: 'k1', metadata: { a: 1, b: 1 } })
      await session.enqueue('b', { mode: 'collect', collect, id: 'k2', metadata: { b: 2 } })
      await until('user stored', async () => (await users(storage)).length === 1)
      const [user] = await users(storage)
      expect(appOf(user)).toEqual({ a: 1, b: 2 })
      expect(user?.metadata?.eharness?.collected?.map((c) => c.inboxKey)).toEqual(['k1', 'k2'])
      await until('hook ran', () => sources.length === 1)
      expect(sources[0]?.keys).toEqual(['k1', 'k2'])
      expect(sources[0]?.ids.length).toBe(2)
    })

    test('metadata is validated', async () => {
      const { agent } = setup()
      const session = agent.session('s1')
      for (const metadata of [
        'x',
        [],
        { big: 'x'.repeat(17 * 1024) },
        { n: 1n },
        Object.create({ inherited: 1 }),
      ]) {
        await expect(session.enqueue('a', { metadata: metadata as never })).rejects.toMatchObject({
          code: 'EH_INVALID_INPUT',
        })
      }
    })
  })
}
