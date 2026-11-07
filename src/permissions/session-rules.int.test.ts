/** Session rules are kept per session id (ADR-0070 point 3): they never leak to other sessions. */
import { describe, expect, test } from 'bun:test'
import { filesystem } from '../filesystem/index.ts'
import { inMemoryFs } from '../filesystem/memory.ts'
import { defineHarnessAgent, type HarnessWarning } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { createPermissionEngine } from './engine.ts'
import { permissions } from './plugin.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const readCall = { toolName: 'read_file', input: { path: '/a.txt' } }

function engineOf(extra: { persist?: (rules: unknown) => void; warnings?: HarnessWarning[] } = {}) {
  return createPermissionEngine({
    roots: () => [{ virtual: '/', real: '/' }],
    ...(extra.persist === undefined ? {} : { persist: extra.persist }),
    ...(extra.warnings === undefined
      ? {}
      : { onWarning: (w: HarnessWarning) => extra.warnings?.push(w) }),
  })
}

describe('session rules per session id', () => {
  test('regression: a deny rule added for S1 does not apply in S2 (same engine, same plugin)', async () => {
    const engine = engineOf()
    await engine.addRule('deny', 'Read(/a.txt)', 'session', { session: 'S1' })
    const agent = defineHarnessAgent({
      model: scriptedModel(
        Array.from({ length: 2 }, () => [{ toolCalls: [readCall] }, { text: 'done' }]).flat(),
      ),
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: silent,
      plugins: [
        filesystem({ fs: inMemoryFs({ seed: { '/a.txt': 'hello\n' } }) }),
        permissions({ engine }),
      ],
    })
    const outputOf = async (id: string): Promise<string> => {
      const session = agent.session(id)
      await session.send('read it').result
      return JSON.stringify(await session.messages())
    }
    expect(await outputOf('S1')).toContain('output-denied')
    const s2 = await outputOf('S2')
    expect(s2).not.toContain('output-denied')
    expect(s2).toContain('hello')
  })

  test('decide only applies a session rule to its own session', async () => {
    const engine = engineOf()
    await engine.addRule('deny', 'Read(/a.txt)', 'session', { session: 'S1' })
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('denied')
    expect(engine.decide(readCall, undefined, 'S2').status).toBe('approved')
    expect(engine.decide(readCall).status).toBe('approved')
    expect((await engine.decideAsync(readCall, { session: 'S1' })).status).toBe('denied')
    expect((await engine.decideAsync(readCall, { session: 'S2' })).status).toBe('approved')
    expect(engine.rules().deny).toEqual([])
    expect(engine.rules({ session: 'S1' }).deny).toEqual(['Read(/a.txt)'])
    expect(engine.rules({ session: 'S2' }).deny).toEqual([])
  })

  test('readBlocked follows the session', async () => {
    const engine = engineOf()
    await engine.addRule('deny', 'Read(/a.txt)', 'session', { session: 'S1' })
    expect(engine.readBlocked('/a.txt', 'S1')).toBe(true)
    expect(engine.readBlocked('/a.txt', 'S2')).toBe(false)
    expect(engine.readBlocked('/a.txt')).toBe(false)
  })

  test('session rules are memory only; project rules are stored and apply everywhere', async () => {
    const persisted: unknown[] = []
    const engine = engineOf({ persist: (rules) => void persisted.push(rules) })
    await engine.allow('Read(/a.txt)', 'session', { session: 'S1' })
    expect(persisted).toHaveLength(0)
    await engine.addRule('deny', 'Read(/a.txt)')
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toEqual({ allow: [], ask: [], deny: ['Read(/a.txt)'] })
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('denied')
    expect(engine.decide(readCall, undefined, 'S2').status).toBe('denied')
  })

  test('removeRule of a session rule is scoped to the session and does not persist', async () => {
    const persisted: unknown[] = []
    const engine = engineOf({ persist: (rules) => void persisted.push(rules) })
    await engine.addRule('deny', 'Read(/a.txt)', 'session', { session: 'S1' })
    expect(await engine.removeRule('deny', 'Read(/a.txt)', { session: 'S2' })).toBe(false)
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('denied')
    expect(await engine.removeRule('deny', 'Read(/a.txt)', { session: 'S1' })).toBe(true)
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('approved')
    expect(persisted).toHaveLength(0)
  })

  test('without an id the rule stays engine-wide and warns once per engine', async () => {
    const warnings: HarnessWarning[] = []
    const engine = engineOf({ warnings })
    await engine.addRule('deny', 'Read(/a.txt)', 'session')
    await engine.allow('Read(/b.txt)', 'session')
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('denied')
    expect(engine.decide(readCall, undefined, 'S2').status).toBe('denied')
    expect(engine.rules().deny).toEqual(['Read(/a.txt)'])
    expect(warnings.map((w) => w.code)).toEqual(['W_PERMISSION_SESSION_RULE_GLOBAL'])
    expect(await engine.removeRule('deny', 'Read(/a.txt)')).toBe(true)
    expect(engine.decide(readCall, undefined, 'S1').status).toBe('approved')
  })

  test('the map is bounded: the oldest session is forgotten', async () => {
    const engine = engineOf()
    for (let i = 0; i < 1_001; i++) {
      await engine.addRule('deny', 'Read(/a.txt)', 'session', { session: `s${i}` })
    }
    expect(engine.decide(readCall, undefined, 's0').status).toBe('approved')
    expect(engine.decide(readCall, undefined, 's1').status).toBe('denied')
    expect(engine.decide(readCall, undefined, 's1000').status).toBe('denied')
  })
})
