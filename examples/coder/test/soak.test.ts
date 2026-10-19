/** The long-session soak (scripts/soak-session.ts), shortened: kills, resume, retry, rewind, compaction. */
import { expect, test } from 'bun:test'
import { runSoak } from '../scripts/soak-session.ts'

test('a long scripted session survives repeated compaction, three kills, /retry and /rewind', async () => {
  const report = await runSoak({ turns: 18 })
  expect(report.problems).toEqual([])
  expect(report.segments.filter((s) => s.killed)).toHaveLength(3)
  expect(report.compactionMarkers).toBeGreaterThanOrEqual(3)
  expect(report.summarizerCalls).toBeGreaterThanOrEqual(3)
  expect(report.peakPromptTokens).toBeLessThanOrEqual(report.window)
}, 120_000)
