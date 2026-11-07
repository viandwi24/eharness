/** `SessionLock.acquire` receives `recovery.instanceId` as `owner` (spec 05 §8, P62 E3). */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type SessionLock } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function build(recovery: Record<string, unknown> | false | undefined) {
  const calls: Array<{ owner?: string; signal: boolean }> = []
  const lock: SessionLock = {
    async acquire(_id, opts) {
      calls.push({
        ...(opts.owner === undefined ? {} : { owner: opts.owner }),
        signal: opts.signal instanceof AbortSignal,
      })
      return async () => {}
    },
  }
  const agent = defineHarnessAgent({
    model: scriptedModel([{ text: 'ok' }, { text: 'again' }]),
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    ...(recovery === undefined ? {} : { recovery }),
  } as never)
  return { agent, calls, lock }
}

describe('lock owner', () => {
  test('a turn and recover() pass recovery.instanceId as owner', async () => {
    const { agent, calls, lock } = build({ instanceId: 'srv-1' })
    const session = agent.session('s1', { lock })
    await session.send('hi').result
    await session.recover()
    expect(calls.length).toBe(2)
    expect(calls.every((c) => c.owner === 'srv-1' && c.signal)).toBe(true)
    await agent.close()
  })

  test('without an instanceId (or with recovery: false) no owner is passed', async () => {
    for (const recovery of [undefined, { staleMs: 5_000 }, false] as const) {
      const { agent, calls, lock } = build(recovery as never)
      await agent.session('s1', { lock }).send('hi').result
      expect(calls.length).toBe(1)
      expect(calls[0]?.owner).toBeUndefined()
      await agent.close()
    }
  })
})
