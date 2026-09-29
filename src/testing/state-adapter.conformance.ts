import type { SessionStateSnapshot, StateAdapter } from '../index.ts'
import { assertJsonEqual, assertTrue, uniqueSessionId } from './assert.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link stateAdapterConformance}. */
export interface StateAdapterConformanceOptions {
  /** Require `setIf` (compare-and-set). Default false: `setIf` cases run only when present. */
  requireSetIf?: boolean
}

function snapshot(rev: number, extra: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
  return {
    v: 1,
    rev,
    core: {
      usage: { inputTokens: 10, outputTokens: 5, turns: 1 },
      activeTurn: {
        turnId: 't1',
        kind: 'send',
        messageId: 'm1',
        owner: 'o1',
        startedAt: 1_790_000_000_000,
        heartbeatAt: 1_790_000_000_500,
      },
    },
    plugins: {
      filesystem: { lastRead: { '/a.md': 'v1' }, list: [1, 'two', null, true, 2.5] },
      app: { note: 'ø ✓ 😀' },
    },
    ...extra,
  }
}

/**
 * Conformance cases for a {@link StateAdapter} (spec 05 §7): `null` for unknown sessions,
 * JSON round-trip, copies on read, session isolation, overwrite, and — when implemented (or
 * required) — compare-and-set semantics of `setIf` on `rev`.
 *
 * @example
 * ```ts
 * for (const c of stateAdapterConformance(() => postgresState(db))) test(c.name, c.run)
 * ```
 * @see docs/specs/05-session-and-storage.md#7-state
 */
export function stateAdapterConformance(
  factory: () => StateAdapter | Promise<StateAdapter>,
  options: StateAdapterConformanceOptions = {},
): ConformanceCase[] {
  const withSetIf = async (): Promise<Required<StateAdapter> | undefined> => {
    const adapter = await factory()
    if (adapter.setIf === undefined) {
      assertTrue(options.requireSetIf !== true, 'setIf is required but not implemented')
      return undefined
    }
    return adapter as Required<StateAdapter>
  }
  return [
    {
      name: 'get returns null for an unknown session',
      run: async () => {
        const adapter = await factory()
        assertTrue((await adapter.get(uniqueSessionId('none'))) === null, 'expected null')
      },
    },
    {
      name: 'set then get round-trips JSON deep-equal',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('roundtrip')
        await adapter.set(sessionId, snapshot(1))
        assertJsonEqual(await adapter.get(sessionId), snapshot(1), 'get after set')
      },
    },
    {
      name: 'set overwrites the whole snapshot',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('overwrite')
        await adapter.set(sessionId, snapshot(1))
        const next = snapshot(2, { core: {}, plugins: { app: { only: true } } })
        await adapter.set(sessionId, next)
        assertJsonEqual(await adapter.get(sessionId), next, 'get after second set')
      },
    },
    {
      name: 'get returns copies and set copies its input',
      run: async () => {
        const adapter = await factory()
        const sessionId = uniqueSessionId('copy')
        const written = snapshot(1)
        await adapter.set(sessionId, written)
        written.plugins.app = { note: 'mutated after set' }
        const read = await adapter.get(sessionId)
        if (read !== null) read.plugins.app = { note: 'mutated after get' }
        assertJsonEqual(await adapter.get(sessionId), snapshot(1), 'stored snapshot')
      },
    },
    {
      name: 'sessions are isolated',
      run: async () => {
        const adapter = await factory()
        const one = uniqueSessionId('iso-a')
        const two = uniqueSessionId('iso-b')
        await adapter.set(one, snapshot(1))
        assertTrue((await adapter.get(two)) === null, 'other session must stay empty')
      },
    },
    {
      name: 'setIf(expectedRev: null) writes only when no snapshot exists',
      run: async () => {
        const adapter = await withSetIf()
        if (adapter === undefined) return
        const sessionId = uniqueSessionId('cas-null')
        assertTrue(await adapter.setIf(sessionId, snapshot(1), null), 'first write must succeed')
        assertTrue(
          !(await adapter.setIf(sessionId, snapshot(1, { plugins: {} }), null)),
          'second write with expectedRev null must conflict',
        )
        assertJsonEqual(await adapter.get(sessionId), snapshot(1), 'stored snapshot')
      },
    },
    {
      name: 'setIf writes when the stored rev matches and reports conflicts otherwise',
      run: async () => {
        const adapter = await withSetIf()
        if (adapter === undefined) return
        const sessionId = uniqueSessionId('cas-rev')
        await adapter.set(sessionId, snapshot(3))
        assertTrue(!(await adapter.setIf(sessionId, snapshot(4), 2)), 'stale rev must conflict')
        assertJsonEqual(await adapter.get(sessionId), snapshot(3), 'unchanged after conflict')
        assertTrue(await adapter.setIf(sessionId, snapshot(4), 3), 'matching rev must succeed')
        assertJsonEqual(await adapter.get(sessionId), snapshot(4), 'stored after setIf')
      },
    },
    {
      name: 'concurrent setIf with the same expectedRev: exactly one wins',
      run: async () => {
        const adapter = await withSetIf()
        if (adapter === undefined) return
        const sessionId = uniqueSessionId('cas-race')
        await adapter.set(sessionId, snapshot(1))
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            adapter.setIf(sessionId, snapshot(2, { plugins: { app: { writer: i } } }), 1),
          ),
        )
        assertTrue(results.filter(Boolean).length === 1, `expected one winner, got ${results}`)
      },
    },
  ]
}
