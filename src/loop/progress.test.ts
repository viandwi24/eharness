import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { createProgressTracker } from './progress.ts'

let id = 0
function step(
  calls: Array<{ tool: string; input: unknown; output: unknown; error?: boolean }>,
): ModelMessage[] {
  const withIds = calls.map((c) => ({ ...c, id: `c${id++}` }))
  return [
    {
      role: 'assistant',
      content: withIds.map((c) => ({
        type: 'tool-call' as const,
        toolCallId: c.id,
        toolName: c.tool,
        input: c.input,
      })),
    },
    {
      role: 'tool',
      content: withIds.map((c) => ({
        type: 'tool-result' as const,
        toolCallId: c.id,
        toolName: c.tool,
        output: c.error
          ? { type: 'error-text' as const, value: String(c.output) }
          : { type: 'json' as const, value: c.output as never },
      })),
    },
  ]
}

describe('progress tracker', () => {
  test('the same call with the same result three times is a repeat', () => {
    const t = createProgressTracker()
    const same = () => step([{ tool: 'read', input: { a: 1, b: 2 }, output: 'x' }])
    expect(t.observe(same())).toBeUndefined()
    expect(t.observe(same())).toBeUndefined()
    expect(t.observe(same())).toEqual({ kind: 'repeat', toolName: 'read', count: 3 })
    expect(t.novel).toBe(1)
  })

  test('key order does not matter; a different result is progress', () => {
    const t = createProgressTracker()
    t.observe(step([{ tool: 'read', input: { a: 1, b: 2 }, output: 'x' }]))
    t.observe(step([{ tool: 'read', input: { b: 2, a: 1 }, output: 'x' }]))
    expect(t.observe(step([{ tool: 'read', input: { a: 1, b: 2 }, output: 'y' }]))).toBeUndefined()
    expect(t.novel).toBe(2)
  })

  test('an A/B cycle is caught by the window count', () => {
    const t = createProgressTracker()
    const a = () => step([{ tool: 'a', input: {}, output: 1 }])
    const b = () => step([{ tool: 'b', input: {}, output: 2 }])
    const seen = [a(), b(), a(), b(), a()].map((s) => t.observe(s))
    expect(seen.at(-1)).toEqual({ kind: 'repeat', toolName: 'a', count: 3 })
  })

  test('calls that fall out of the window are forgotten', () => {
    const t = createProgressTracker({ window: 2 })
    const same = () => step([{ tool: 'r', input: {}, output: 1 }])
    t.observe(same())
    t.observe(step([{ tool: 'x', input: 1, output: 1 }]))
    t.observe(step([{ tool: 'x', input: 2, output: 1 }]))
    expect(t.observe(same())).toBeUndefined()
  })

  test('an error streak is reported; one success resets it', () => {
    const t = createProgressTracker({ errorStreak: 3 })
    const fail = (n: number) => step([{ tool: 'run', input: n, output: 'boom', error: true }])
    t.observe(fail(1))
    t.observe(fail(2))
    t.observe(step([{ tool: 'run', input: 9, output: 'ok' }]))
    t.observe(fail(3))
    t.observe(fail(4))
    expect(t.observe(fail(5))).toEqual({ kind: 'errors', count: 3 })
  })

  test('ignored tools, denied calls and text-only steps do not count; reset forgets', () => {
    const t = createProgressTracker({ ignoreTools: ['wait'] })
    const wait = () => step([{ tool: 'wait', input: {}, output: 'pending' }])
    for (let i = 0; i < 5; i++) expect(t.observe(wait())).toBeUndefined()
    expect(t.observe([{ role: 'assistant', content: 'just text' }])).toBeUndefined()
    const same = () => step([{ tool: 'r', input: {}, output: 1 }])
    t.observe(same())
    t.observe(same())
    t.reset()
    expect(t.observe(same())).toBeUndefined()
    expect(t.novel).toBe(2)
  })
})

describe('tool error streak', () => {
  test('one tool failing with varying inputs while another succeeds is caught', () => {
    const t = createProgressTracker({ toolErrorStreak: 4 })
    let n = 0
    let last: ReturnType<typeof t.observe>
    for (let i = 0; i < 4; i++) {
      last = t.observe(
        step([
          {
            tool: 'web_search',
            input: { q: `query ${n}` },
            output: 'ERROR: not configured',
            error: true,
          },
        ]),
      )
      // a different tool succeeds with new input each time: the step-level streak resets
      expect(
        t.observe(step([{ tool: 'web_fetch', input: { u: n++ }, output: `page ${n}` }])),
      ).toBeUndefined()
    }
    expect(last).toEqual({ kind: 'tool-errors', toolName: 'web_search', count: 4 })
  })

  test('returned `ERROR:` strings count as failures', () => {
    const t = createProgressTracker({ errorStreak: 2 })
    const fail = (n: number) => [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool-call' as const, toolCallId: `e${n}`, toolName: 'x', input: n }],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: `e${n}`,
            toolName: 'x',
            output: { type: 'text' as const, value: 'ERROR: nope' },
          },
        ],
      },
    ]
    t.observe(fail(1))
    expect(t.observe(fail(2))).toEqual({ kind: 'errors', count: 2 })
    expect(t.novel).toBe(0)
  })

  test('a success of the same tool clears its streak; reset clears all', () => {
    const t = createProgressTracker({ toolErrorStreak: 3 })
    const fail = (n: number) => step([{ tool: 's', input: n, output: 'ERROR', error: true }])
    t.observe(fail(1))
    t.observe(fail(2))
    t.observe(step([{ tool: 's', input: 3, output: 'ok' }]))
    t.observe(fail(4))
    t.observe(fail(5))
    t.reset()
    expect(t.observe(fail(6))).toBeUndefined()
  })
})
