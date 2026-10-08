import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { CoderMessage } from '../src/contracts.ts'
import { MessageView } from '../src/ui/MessageView.tsx'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const plain = (f: string | undefined): string => (f ?? '').replace(/\u001b\[[0-9;]*m/g, '')
let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function show(parts: unknown[]): string {
  const message = { id: 'a1', role: 'assistant', parts } as unknown as CoderMessage
  const app = render(<MessageView message={message} expanded={false} bash={{}} timing={{}} />)
  cleanup.push(() => app.unmount())
  return plain(app.lastFrame())
}
const input = (source: string, text: string): unknown => ({
  type: 'data-eh.input',
  data: { source, text },
})

describe('steered input in an assistant message', () => {
  test('a user steer renders as a user line with the marker, in place', () => {
    const out = show([
      { type: 'text', text: 'working' },
      input('user', 'use bun instead'),
      { type: 'text', text: 'ok' },
    ])
    expect(out).toContain('> use bun instead')
    expect(out).toContain('(sent while the agent was working)')
    expect(out.indexOf('working')).toBeLessThan(out.indexOf('use bun instead'))
    expect(out.indexOf('use bun instead')).toBeLessThan(out.indexOf('ok'))
  })

  test('an approval note renders as a dim Note line', () => {
    const out = show([
      {
        type: 'data-eh.input',
        data: {
          source: 'user',
          text: '<user-note tool="edit_file" call="c1">\nkeep it small\n</user-note>',
          approvalNote: { toolCallId: 'c1', toolName: 'edit_file', text: 'keep it small' },
        },
      },
    ])
    expect(out).toContain('Note: keep it small')
    expect(out).not.toContain('user-note')
    expect(out).not.toContain('sent while')
    expect(out).not.toContain('> ')
  })

  test('event input is a dim system line; plugin context is hidden', () => {
    const out = show([input('event', 'build finished'), input('plugin:todos', 'secret context')])
    expect(out).toContain('build finished')
    expect(out).not.toContain('secret context')
  })
})
