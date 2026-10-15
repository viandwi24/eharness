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

  test('an MCP image is not counted and never cut; only the text is shortened', async () => {
    const image = { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/jpeg' }
    const small = { content: [{ type: 'text', text: 'Screenshot 540x1200' }, image] }
    const kept = run(small, { maxChars: 1000 })
    expect(await kept.result).toBe(small)
    expect(kept.warnings).toEqual([])

    const long = {
      content: [{ type: 'text', text: 'x'.repeat(5000) }, image],
      structuredContent: { text: 'x'.repeat(5000) },
    }
    const cut = run(long, { maxChars: 1000 })
    const out = (await cut.result) as { content: Array<{ type: string; text?: string }> }
    expect(isLimitedOutput(out)).toBe(false)
    expect(out.content[1]).toBe(image)
    expect((out.content[0]?.text ?? '').length).toBeLessThan(1200)
    expect('structuredContent' in out).toBe(false)
    expect(cut.warnings[0]?.code).toBe('W_TOOL_OUTPUT_LIMITED')
  })

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

  test('a structured preview fits the budget including its JSON escaping', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ k: `v${i}`, q: '"quoted"' }))
    const { result } = run(rows, { maxChars: 1_000 })
    const limited = (await result) as { preview: string; originalChars: number }
    expect(limited.originalChars).toBe(JSON.stringify(rows).length)
    const marker = /…\[truncated \d+ chars\]…/.exec(limited.preview)?.[0] ?? ''
    expect(marker).not.toBe('')
    const escaped = JSON.stringify(limited.preview).length - 2 - marker.length
    expect(escaped).toBeLessThanOrEqual(1_000)
    expect(escaped).toBeGreaterThan(900)
  })

  test('isLimitedOutput recognises only the limited form', () => {
    expect(isLimitedOutput({ truncated: true, preview: '', originalChars: 1 })).toBe(true)
    expect(isLimitedOutput({ truncated: true, preview: '' })).toBe(false)
    expect(isLimitedOutput('truncated')).toBe(false)
    expect(isLimitedOutput(null)).toBe(false)
  })
})
