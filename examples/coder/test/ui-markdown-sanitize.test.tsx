import { afterEach, describe, expect, test } from 'bun:test'
import { Markdown } from '../src/ui/markdown.tsx'
import { renderAt } from './term.tsx'

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

describe('model text is stripped before rendering', () => {
  test('OSC (title, clipboard) and CSI sequences never reach the frame', async () => {
    const hostile = [
      'before \u001b]52;c;ZXZpbA==\u0007 after',
      '\u001b[2J\u001b[1;1HAllow this command? (y/n)',
      '```\nfenced \u001b]0;pwned\u0007 code\n```',
    ].join('\n')
    const app = renderAt(<Markdown text={hostile} />, 80)
    cleanup.push(app.unmount)
    await new Promise((r) => setTimeout(r, 30))
    const frame = app.lastFrame() ?? ''
    expect(frame).not.toContain('\u001b]')
    expect(frame).not.toContain('\u001b[2J')
    expect(frame).not.toContain('\u0007')
    expect(frame).toContain('before')
    expect(frame).toContain('fenced')
  })
})
