import { describe, expect, test } from 'bun:test'
import { createStore, type StoreTimers } from './store.ts'

function fakeTimers(): StoreTimers & { run(): void; pending(): number } {
  let next = 1
  const tasks = new Map<number, () => void>()
  return {
    setTimeout(fn) {
      const id = next++
      tasks.set(id, fn)
      return id
    },
    clearTimeout(handle) {
      tasks.delete(handle as number)
    },
    run() {
      for (const [id, fn] of [...tasks]) {
        tasks.delete(id)
        fn()
      }
    },
    pending: () => tasks.size,
  }
}

describe('store contract', () => {
  test('subscribe calls back synchronously with the current value, then on change', () => {
    const store = createStore({ n: 1 })
    const seen: number[] = []
    const off = store.subscribe((v) => seen.push(v.n))
    expect(seen).toEqual([1])
    store.set({ n: 2 })
    store.update((v) => ({ n: v.n + 1 }))
    expect(seen).toEqual([1, 2, 3])
    off()
    store.set({ n: 9 })
    expect(seen).toEqual([1, 2, 3])
    off() // idempotent
  })

  test('get() is referentially stable until the store changes; same value does not notify', () => {
    const store = createStore({ items: [1] })
    const a = store.get()
    expect(store.get()).toBe(a)
    let calls = 0
    store.subscribe(() => calls++)
    store.set(a)
    expect(calls).toBe(1) // only the initial call
    const b = { items: [1, 2] }
    store.set(b)
    expect(store.get()).toBe(b)
    expect(calls).toBe(2)
  })

  test('snapshots are frozen (objects and the arrays inside)', () => {
    const store = createStore({ items: [1] })
    expect(Object.isFrozen(store.get())).toBe(true)
    expect(Object.isFrozen(store.get().items)).toBe(true)
    expect(() => (store.get().items as number[]).push(2)).toThrow()
  })

  test('onActive on the first subscriber, onIdle one grace period after the last', () => {
    const timers = fakeTimers()
    const log: string[] = []
    const store = createStore(0, {
      timers,
      onActive: () => log.push('active'),
      onIdle: () => log.push('idle'),
    })
    const a = store.subscribe(() => {})
    const b = store.subscribe(() => {})
    expect(log).toEqual(['active'])
    a()
    b()
    expect(timers.pending()).toBe(1)
    expect(log).toEqual(['active'])
    timers.run()
    expect(log).toEqual(['active', 'idle'])
    store.subscribe(() => {})()
    expect(log).toEqual(['active', 'idle', 'active'])
  })

  test('a subscriber inside the grace period cancels the idle', () => {
    const timers = fakeTimers()
    const log: string[] = []
    const store = createStore(0, {
      timers,
      onActive: () => log.push('a'),
      onIdle: () => log.push('i'),
    })
    store.subscribe(() => {})()
    const again = store.subscribe(() => {})
    timers.run()
    expect(log).toEqual(['a'])
    again()
  })
})
