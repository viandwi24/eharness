import { describe, expect, test } from 'bun:test'
import { activityStoreConformance } from '../testing/index.ts'
import { memoryActivityStore } from './memory.ts'

describe('memoryActivityStore conformance', () => {
  for (const c of activityStoreConformance(() => {
    const store = memoryActivityStore()
    return { store, peer: () => store }
  })) {
    test(c.name, c.run)
  }
})

test('pruneBoundary is exported and keeps the head', async () => {
  const store = memoryActivityStore()
  await store.append([{ type: 'a' }, { type: 'b' }])
  expect((await store.prune({ keepLast: 1 })).prunedThrough).toBe(1)
})
