import { describe, expect, test } from 'bun:test'
import type { HarnessWarning } from '../errors.ts'
import {
  DEFAULT_TOOL_OUTPUT_MAX_CHARS,
  isLimitedOutput,
  limitToolOutput,
  toolOutputBudget,
} from './output-limits.ts'

describe('toolOutputBudget', () => {
  test('default, maxChars, perTool number and false', () => {
    expect(toolOutputBudget(undefined, 'x')).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS)
    expect(toolOutputBudget({ maxChars: 10 }, 'x')).toBe(10)
    expect(toolOutputBudget({ maxChars: 10, perTool: { x: 3 } }, 'x')).toBe(3)
    expect(toolOutputBudget({ maxChars: 10, perTool: { x: false } }, 'x')).toBeUndefined()
    expect(toolOutputBudget({ perTool: { y: 1 } }, 'x')).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS)
    expect(toolOutputBudget({ maxChars: -5 }, 'x')).toBe(0)
  })
})

describe('limitToolOutput', () => {
  const run = (
    output: unknown,
    config: Parameters<typeof toolOutputBudget>[0],
    put?: () => Promise<string>,
  ) => {
    const warnings: HarnessWarning[] = []
    const result = limitToolOutput('t', 'c1', output, {
      config,
      toolOutputs: put === undefined ? undefined : { put },
      warn: (w) => warnings.push(w),
    })
    return { result, warnings }
  }

  test('within budget: unchanged, no warning (same reference)', async () => {
    const value = { a: 1 }
    const { result, warnings } = run(value, { maxChars: 100 })
    expect(await result).toBe(value)
    expect(warnings).toEqual([])
  })

  test('undefined output and unlimited tools pass through', async () => {
    expect(await run(undefined, { maxChars: 0 }).result).toBeUndefined()
    expect(await run('x'.repeat(10), { maxChars: 1, perTool: { t: false } }).result).toBe(
      'x'.repeat(10),
    )
  })

  test('a failing evict falls back to truncate', async () => {
    const { result, warnings } = run('abcdefghij', { maxChars: 4, strategy: 'evict' }, async () => {
      throw new Error('disk full')
    })
    expect(await result).toBe('ab…[truncated 6 chars]…ij')
    expect(warnings[0]?.details?.strategy).toBe('truncate')
  })

  test('isLimitedOutput recognises only the limited form', () => {
    expect(isLimitedOutput({ truncated: true, preview: '', originalChars: 1 })).toBe(true)
    expect(isLimitedOutput({ truncated: true, preview: '' })).toBe(false)
    expect(isLimitedOutput('truncated')).toBe(false)
    expect(isLimitedOutput(null)).toBe(false)
  })
})
