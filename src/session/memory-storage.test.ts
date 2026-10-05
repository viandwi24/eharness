import { describe, expect, test } from 'bun:test'
import type { MessageAdapter } from '../agent/session-types.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { messageAdapterConformance } from '../testing/message-adapter.conformance.ts'
import { stateAdapterConformance } from '../testing/state-adapter.conformance.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

describe('memoryMessages() conformance', () => {
  for (const c of messageAdapterConformance(() => memoryMessages(), { requireLastId: true })) {
    test(c.name, c.run)
  }
})

describe('memoryState() conformance', () => {
  for (const c of stateAdapterConformance(() => memoryState(), { requireSetIf: true })) {
    test(c.name, c.run)
  }
})

describe('core default memory adapters conformance', () => {
  for (const c of messageAdapterConformance(() => defaultMemoryMessages(), {
    requireLastId: true,
  })) {
    test(c.name, c.run)
  }
  for (const c of stateAdapterConformance(() => defaultMemoryState(), { requireSetIf: true })) {
    test(c.name, c.run)
  }
})

describe('memoryMessages()', () => {
  test('rejects fromId together with beforeId', async () => {
    await expect(
      memoryMessages().load({ sessionId: 's', fromId: 'a', beforeId: 'b' }),
    ).rejects.toThrow()
  })
})

describe('conformance suites detect broken adapters', () => {
  test('an adapter that does not copy fails the copy case', async () => {
    const store: unknown[] = []
    const broken = {
      load: async () => store as never[],
      save: async (_: string, messages: unknown[]) => {
        store.push(...messages)
      },
    }
    const copy = messageAdapterConformance(() => broken).find((c) => c.name.includes('copies'))
    await expect(copy?.run()).rejects.toThrow()
  })
  /** Run every case; the names of the failing ones. */
  async function failing(adapter: () => MessageAdapter): Promise<string[]> {
    const out: string[] = []
    for (const c of messageAdapterConformance(adapter)) {
      try {
        await c.run()
      } catch {
        out.push(c.name)
      }
    }
    return out
  }

  test('an adapter whose save merges instead of replacing fails the suite', async () => {
    const merging = (): MessageAdapter => {
      const inner = memoryMessages()
      return {
        load: (q) => inner.load(q),
        async save(sessionId, messages) {
          const stored = await inner.load({ sessionId })
          const merged = messages.map((m) => {
            const old = stored.find((s) => s.id === m.id)
            if (old === undefined) return m
            return {
              ...old,
              ...m,
              metadata: { ...(old.metadata ?? {}), ...(m.metadata ?? {}) },
            } as typeof m
          })
          await inner.save(sessionId, merged)
        },
      }
    }
    expect(await failing(merging)).toEqual([
      'save replaces the whole message (dropped keys stay dropped)',
    ])
  })

  test('an adapter whose fromId needs an exact id fails the suite', async () => {
    const indexed = (): MessageAdapter => {
      const inner = memoryMessages()
      return {
        save: (sessionId, messages) => inner.save(sessionId, messages),
        async load(q) {
          if (q.fromId === undefined) return inner.load(q)
          const all = await inner.load({ sessionId: q.sessionId })
          const index = all.findIndex((m) => m.id === q.fromId)
          return index < 0 ? all : all.slice(index)
        },
      }
    }
    expect(await failing(indexed)).toEqual([
      '{ fromId } between stored ids starts at the next newer one',
    ])
  })

  test('a setIf without CAS fails the setIf case', async () => {
    const state = memoryState()
    const broken = {
      ...state,
      setIf: async (id: string, s: never) => {
        await state.set(id, s)
        return true
      },
    }
    const cas = stateAdapterConformance(() => broken).find((c) => c.name.includes('stored rev'))
    await expect(cas?.run()).rejects.toThrow()
  })
})
