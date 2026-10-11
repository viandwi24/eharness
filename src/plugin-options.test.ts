import { describe, expect, test } from 'bun:test'
import { ask } from './ask/index.ts'
import { group } from './group/index.ts'
import { memory } from './memory/index.ts'
import { todos } from './todos/index.ts'
import { webFetch } from './web/index.ts'

const bad = (fn: () => unknown, plugin: string): void => {
  try {
    fn()
  } catch (error) {
    expect((error as { code?: string }).code).toBe('EH_CONFIG_INVALID')
    expect((error as Error).message).toContain(`${plugin}:`)
    return
  }
  throw new Error('expected EH_CONFIG_INVALID')
}

describe('plugin numeric options are validated', () => {
  test('todos', () => {
    bad(() => todos({ maxItems: 0 }), 'todos')
    bad(() => todos({ maxNudges: -1 }), 'todos')
    bad(() => todos({ remindEvery: Number.NaN }), 'todos')
    expect(() => todos({ maxNudges: 0, remindEvery: 0, maxItems: 1 })).not.toThrow()
  })
  test('ask', () => {
    bad(() => ask({ maxQuestions: 0 }), 'ask')
    bad(() => ask({ maxQuestions: 5 }), 'ask')
    expect(() => ask({ maxQuestions: 2 })).not.toThrow()
  })
  test('group', () => {
    bad(() => group({ botId: 'b', historyLimit: -1 }), 'group')
    bad(() => group({ botId: 'b', maxBotTurns: { count: 1.5, windowMs: 1000 } }), 'group')
    bad(() => group({ botId: 'b', maxBotTurns: { count: 1, windowMs: 0 } }), 'group')
    expect(() => group({ botId: 'b', historyLimit: 0 })).not.toThrow()
  })
  test('webFetch', () => {
    bad(() => webFetch({ maxBytes: 0 }), 'webFetch')
    bad(() => webFetch({ timeoutMs: -5 }), 'webFetch')
    bad(() => webFetch({ maxRedirects: 1.5 }), 'webFetch')
    expect(() => webFetch({ maxRedirects: 0 })).not.toThrow()
  })
  test('memory (already validated)', () => {
    expect(() => memory({ roots: [], maxFileChars: 0 } as never)).toThrow('memory:')
  })
})
