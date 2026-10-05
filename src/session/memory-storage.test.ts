import { describe, expect, test } from 'bun:test'
import type { InboxAdapter, InboxItem, MessageAdapter } from '../agent/session-types.ts'
import { uuidv7 } from '../messages/ids.ts'
import { memoryInbox, memoryMessages, memoryState } from '../storage/memory.ts'
import { inboxAdapterConformance } from '../testing/inbox-adapter.conformance.ts'
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

describe('memoryInbox() conformance', () => {
  for (const c of inboxAdapterConformance(() => memoryInbox(), {
    requireNotify: true,
    requirePending: true,
  })) {
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

describe('inboxAdapterConformance detects broken adapters', () => {
  test('a non-atomic claim (two claimers get the same item) fails the race case', async () => {
    const items: InboxItem[] = []
    const claimed = new Set<string>()
    const broken: InboxAdapter = {
      async enqueue(_sessionId, item) {
        const id = uuidv7()
        items.push({ ...structuredClone(item), id, attempts: 0 })
        return id
      },
      // reads, waits, then marks: concurrent claimers read the same ready items
      async claim(_sessionId, _owner, opts) {
        const ready = items.filter((i) => !claimed.has(i.id)).slice(0, opts?.limit ?? 1_000)
        await new Promise((resolve) => setTimeout(resolve, 5))
        for (const item of ready) claimed.add(item.id)
        return structuredClone(ready)
      },
      async ack() {},
      async release(ids) {
        for (const id of ids) claimed.delete(id)
      },
    }
    const race = inboxAdapterConformance(() => broken).find((c) => c.name.includes('exactly once'))
    await expect(race?.run()).rejects.toThrow()
  })
})
