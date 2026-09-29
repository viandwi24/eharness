import { describe, expect, test } from 'bun:test'
import { defaultMemoryMessages, defaultMemoryState } from '../session/memory-storage.ts'
import { messageAdapterConformance } from '../testing/message-adapter.conformance.ts'
import { stateAdapterConformance } from '../testing/state-adapter.conformance.ts'
import { memoryMessages, memoryState } from './memory.ts'

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
