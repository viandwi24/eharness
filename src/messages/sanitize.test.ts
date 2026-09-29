import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'
import { sanitizeModelMessages } from './sanitize.ts'
import { INTERRUPTED_UNKNOWN } from './texts.ts'

const call: ModelMessage = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: { amount: 1 } },
    { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1' },
  ],
}

describe('sanitizeModelMessages: approvals', () => {
  test('a trailing approved response without a result is left for AI SDK to execute', () => {
    const wire: ModelMessage[] = [
      { role: 'user', content: 'pay' },
      call,
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }],
      },
    ]
    expect(sanitizeModelMessages(wire)).toEqual(wire)
  })

  test('an automatic approval followed by its result keeps the result (never re-executed)', () => {
    const tool: ModelMessage = {
      role: 'tool',
      content: [
        { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'pay',
          output: { type: 'text', value: 'paid' },
        },
      ],
    }
    const wire: ModelMessage[] = [{ role: 'user', content: 'pay' }, call, tool]
    expect(sanitizeModelMessages(wire)).toEqual(wire)
  })

  test('a non-trailing approved response without a result gets an interrupted result', () => {
    const wire: ModelMessage[] = [
      { role: 'user', content: 'pay' },
      call,
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }],
      },
      { role: 'user', content: 'next' },
    ]
    const out = sanitizeModelMessages(wire)
    expect(JSON.stringify(out[2])).toContain(INTERRUPTED_UNKNOWN)
  })
})
