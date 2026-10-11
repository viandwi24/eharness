import { expect, test } from 'bun:test'
import { createDedupedWarningLog } from '../src/infra/eh/warning-log'

test('repeats of one repaired message print once per window, with a suppressed count', () => {
  let t = 0
  const lines: string[] = []
  const log = createDedupedWarningLog({
    dedupeWindowMs: 1_000,
    now: () => t,
    print: (l) => lines.push(l),
  })
  const w = (id: string) => ({
    code: 'W_REPAIRED_MESSAGE' as const,
    message: `Stored message ${id} was repaired`,
    details: { messageId: id },
  })
  log(w('a'))
  log(w('a'))
  log(w('b'))
  expect(lines).toHaveLength(2)
  t = 2_000
  log(w('a'))
  expect(lines).toHaveLength(3)
  expect(lines[2]).toContain('(1 similar suppressed')
})
