import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import {
  chatBridgeOf,
  createReactBindings,
  type ReactLike,
  type UseChatResultLike,
} from './react.ts'
import { createStore } from './store.ts'

const m = (id: string): UIMessage => ({ id, role: 'user', parts: [] })

function result(messages: UIMessage[], calls: string[] = []): UseChatResultLike {
  return {
    messages,
    status: 'ready',
    setMessages: (next) => calls.push(`set:${(next as UIMessage[]).map((x) => x.id).join(',')}`),
    sendMessage: async (x) => void calls.push(`send:${x.text}`),
    regenerate: async () => void calls.push('regenerate'),
    resumeStream: async () => void calls.push('resume'),
    stop: async () => void calls.push('stop'),
    clearError: () => void calls.push('clear'),
  }
}

describe('chatBridgeOf', () => {
  test('reads the latest result and shows its own writes before the next render', () => {
    const calls: string[] = []
    let current = result([m('a')], calls)
    const bridge = chatBridgeOf(() => current)
    expect(bridge.messages.map((x) => x.id)).toEqual(['a'])
    bridge.messages = [m('a'), m('b')]
    expect(bridge.messages.map((x) => x.id)).toEqual(['a', 'b'])
    expect(calls).toEqual(['set:a,b'])
    current = result([m('a'), m('b'), m('c')], calls) // React re-rendered
    expect(bridge.messages.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(bridge.status).toBe('ready')
  })

  test('forwards the actions', async () => {
    const calls: string[] = []
    const bridge = chatBridgeOf(() => result([], calls))
    await bridge.sendMessage({ text: 'hi' })
    await bridge.resumeStream()
    await bridge.stop()
    bridge.clearError()
    expect(calls).toEqual(['send:hi', 'resume', 'stop', 'clear'])
  })
})

describe('createReactBindings', () => {
  test('useStore subscribes through useSyncExternalStore and skips the synchronous initial call', () => {
    let notified = 0
    const React: ReactLike = {
      useSyncExternalStore: (subscribe, getSnapshot) => {
        subscribe(() => notified++)
        return getSnapshot()
      },
      useEffect: () => {},
      useMemo: (factory) => factory(),
    }
    const { useStore } = createReactBindings(React)
    const store = createStore({ n: 1 })
    expect(useStore(store)).toEqual({ n: 1 })
    expect(notified).toBe(0)
    store.set({ n: 2 })
    expect(notified).toBe(1)
  })
})
