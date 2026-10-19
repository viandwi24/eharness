import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '../src/app/ports.ts'
import { writtenPaths } from '../src/app/tasks.ts'
import { finalTextOf } from '../src/infra/eh/task-index.ts'

const write = (
  path: string,
  state = 'output-available',
  output = 'ok',
): ChatMessage['parts'][number] => ({
  type: 'tool-write_file',
  state,
  input: { path },
  output,
})

describe('writtenPaths', () => {
  test('lists successful writes once, newest first, without internal folders', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        parts: [
          write('/reports/a.md'),
          write('/reports/b.md'),
          write('/reports/a.md'),
          write('/memories/note.md'),
          write('/reports/failed.md', 'output-available', 'Error: stale'),
          write('/reports/pending.md', 'input-available'),
          {
            type: 'tool-read_file',
            state: 'output-available',
            input: { path: '/x.md' },
            output: 'x',
          },
        ],
      },
    ]
    expect(writtenPaths(messages)).toEqual(['/reports/b.md', '/reports/a.md'])
  })
})

describe('finalTextOf', () => {
  test('takes the text after the last tool call, not the early narration', () => {
    const message = {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'I will start by checking my notes.' },
        { type: 'tool-read_file', state: 'output-available' },
        { type: 'text', text: 'Working on it.' },
        { type: 'tool-write_file', state: 'output-available' },
        { type: 'step-start' },
        { type: 'text', text: 'Final report: done.' },
      ],
    }
    expect(finalTextOf(message)).toBe('Final report: done.')
  })
  test('falls back to the last text when the turn ended on a tool call', () => {
    const message = {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
        { type: 'tool-x', state: 'output-available' },
      ],
    }
    expect(finalTextOf(message)).toBe('second')
  })
})
