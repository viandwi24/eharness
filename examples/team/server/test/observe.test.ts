import { describe, expect, test } from 'bun:test'
import { createObserver } from '../src/infra/eh/observe.ts'

describe('observe adapter', () => {
  test('logs only slow or failed spans and counts failures and counters', () => {
    const lines: string[] = []
    const o = createObserver({ log: (m) => lines.push(m), slowMs: 100, slowModelMs: 1000 })
    o.observe({ type: 'span', name: 'state.write', durationMs: 5, ok: true, sessionId: 's1' })
    o.observe({ type: 'span', name: 'state.write', durationMs: 150, ok: true, sessionId: 's1' })
    // long phases have their own threshold
    o.observe({ type: 'span', name: 'model.call', durationMs: 500, ok: true, sessionId: 's1' })
    o.observe({ type: 'span', name: 'tool.execute', durationMs: 3, ok: false, tool: 'bash' })
    o.observe({ type: 'count', name: 'hook.timeout', hook: 'turn.end' })
    o.observe({ type: 'count', name: 'warning', code: 'W_X' })
    expect(lines).toEqual([
      'team: observe slow state.write 150ms s1',
      'team: observe failed tool.execute 3ms bash',
      'team: observe hook.timeout turn.end',
    ])
    expect(o.snapshot()).toEqual({
      'fail:tool.execute': 1,
      'count:hook.timeout': 1,
      'count:warning': 1,
    })
  })
})

// The example's own bunfig preload sets the flag; a run from the repo root uses the root preload,
// which turns the invariants on for every agent itself.
const fromServerDir =
  import.meta.dir.endsWith('/test') && process.cwd().endsWith('examples/team/server')

describe('test setup', () => {
  test.skipIf(!fromServerDir)('session invariants are on (bunfig preload)', () => {
    expect(process.env.TEAM_DEBUG_INVARIANTS).toBe('1')
  })
})
