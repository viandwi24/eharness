import { describe, expect, test } from 'bun:test'
import { createSseParser, type SseMessage } from './sse.ts'

const collect = (): { out: SseMessage[]; p: ReturnType<typeof createSseParser> } => {
  const out: SseMessage[] = []
  return { out, p: createSseParser((m) => out.push(m)) }
}

describe('sse parser', () => {
  test('parses id, event, data and ignores comments', () => {
    const { out, p } = collect()
    p.push(': keep-alive\n\nid: 7\nevent: task-changed\ndata: {"a":1}\n\n')
    expect(out).toEqual([{ id: '7', event: 'task-changed', data: '{"a":1}' }])
  })

  test('handles chunks split anywhere, CRLF and multi-line data', () => {
    const { out, p } = collect()
    const raw = 'id: 1\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\nid: 2\ndata: c\n\n'
    for (const ch of raw) p.push(ch)
    expect(out).toEqual([
      { id: '1', event: 'x', data: 'a\nb' },
      { id: '2', event: 'message', data: 'c' },
    ])
  })

  test('an event without data is dropped; the last id sticks', () => {
    const { out, p } = collect()
    p.push('id: 3\n\ndata: z\n\n')
    expect(out).toEqual([{ id: '3', event: 'message', data: 'z' }])
  })

  test('retry field and reset', () => {
    const { out, p } = collect()
    p.push('retry: 3000\ndata: a\n\ndata: half')
    p.reset()
    p.push('data: b\n\n')
    expect(out).toEqual([
      { event: 'message', data: 'a', retry: 3000 },
      { event: 'message', data: 'b' },
    ])
  })
})
