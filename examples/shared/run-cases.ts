/**
 * Run conformance cases from a script (outside a test runner): prints one line per case and sets
 * `process.exitCode = 1` when a case fails. In a test file, register them instead:
 * `for (const c of cases) test(c.name, c.run)`.
 */
import type { ConformanceCase } from 'eharness/testing'

export async function runCases(title: string, cases: ConformanceCase[]): Promise<boolean> {
  let failed = 0
  console.log(`\n${title}`)
  for (const c of cases) {
    try {
      await c.run()
      console.log(`  ✓ ${c.name}`)
    } catch (error) {
      failed++
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`  ${cases.length - failed}/${cases.length} passed`)
  if (failed > 0) process.exitCode = 1
  return failed === 0
}
