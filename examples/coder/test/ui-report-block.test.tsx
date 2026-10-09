import { afterEach, describe, expect, test } from 'bun:test'
import type { CoderMessage } from '../src/contracts.ts'
import { MessageView, SteeredInput } from '../src/ui/MessageView.tsx'
import { previewText } from '../src/ui/ReportBlock.tsx'
import { renderAt } from './term.tsx'

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

const report = Array.from({ length: 40 }, (_, i) => `finding ${i}`).join('\n')
const event = `Background subagent agent-1 "writer" (general-purpose: notes) finished.\n\n${report}`

describe('previewText', () => {
  test('keeps up to the row budget and counts the lines that are left', () => {
    const p = previewText(report, 80, 8)
    expect(p.text.split('\n')).toHaveLength(8)
    expect(p.hidden).toBe(32)
    expect(p.truncated).toBe(true)
  })

  test('a short report is shown whole', () => {
    expect(previewText('one\ntwo', 80, 8)).toEqual({
      text: 'one\ntwo',
      hidden: 0,
      truncated: false,
    })
  })

  test('wrapped rows count toward the limit', () => {
    const lines = Array.from({ length: 6 }, () => 'word '.repeat(20).trim()) // 2 rows each at 60
    const p = previewText(lines.join('\n'), 60, 8)
    expect(p.text.split('\n')).toHaveLength(4)
    expect(p.hidden).toBe(2)
  })

  test('one very long line is cut to the budget with an ellipsis', () => {
    const p = previewText('x'.repeat(2000), 40, 8)
    expect(p.truncated).toBe(true)
    expect(p.hidden).toBe(0)
    expect(p.text.endsWith('…')).toBe(true)
    expect(p.text.length).toBeLessThan(400)
  })

  test('a code fence left open by the cut is closed', () => {
    const src = [
      '```ts',
      ...Array.from({ length: 20 }, (_, i) => `const a${i} = ${i}`),
      '```',
    ].join('\n')
    const p = previewText(src, 80, 8)
    expect(p.text.endsWith('```')).toBe(true)
    expect(p.text.split('\n').filter((l) => l.startsWith('```'))).toHaveLength(2)
  })
})

describe('agent reports in the main chat', () => {
  test('a finished subagent: header, markdown preview, hidden line count', async () => {
    const app = renderAt(
      <SteeredInput source="event" text={`<event name="subagent">${event}</event>`} />,
      80,
    )
    cleanup.push(app.unmount)
    await tick()
    const frame = app.lastFrame()
    expect(frame).toContain('⏺ Message from writer · general-purpose · finished')
    expect(frame).toContain('⎿ finding 0')
    expect(frame).toContain('finding 7')
    expect(frame).not.toContain('finding 8')
    expect(frame).toContain('… +32 lines (ctrl+o to expand)')
  })

  test('expanded shows the whole report and no hint', async () => {
    const app = renderAt(
      <SteeredInput source="event" text={`<event name="subagent">${event}</event>`} expanded />,
      80,
      80,
    )
    cleanup.push(app.unmount)
    await tick()
    const frame = app.lastFrame()
    expect(frame).toContain('finding 39')
    expect(frame).not.toContain('ctrl+o to expand')
  })

  test('a failed run keeps its status word', async () => {
    const app = renderAt(
      <SteeredInput
        source="event"
        text={'Resumed subagent agent-2 (explore: look) failed.\n\nboom'}
      />,
      80,
    )
    cleanup.push(app.unmount)
    await tick()
    const frame = app.lastFrame()
    expect(frame).toContain('⏺ Message from agent-2 · explore · failed (resumed)')
    expect(frame).toContain('⎿ boom')
    expect(frame).not.toContain('ctrl+o')
  })

  test('an agent-message kind message uses the same block', async () => {
    const message = {
      id: 'e1',
      role: 'user',
      metadata: { eharness: { kind: 'eh.event' } },
      parts: [
        {
          type: 'data-eh.event',
          data: {
            name: 'agent-message',
            text: '<agent-message from="writer" id="agent-1" relation="child">\n## Notes\n\n- one\n- two\n</agent-message>',
          },
        },
      ],
    } as unknown as CoderMessage
    const app = renderAt(
      <MessageView message={message} expanded={false} bash={{}} timing={{}} />,
      80,
    )
    cleanup.push(app.unmount)
    await tick()
    const frame = app.lastFrame()
    expect(frame).toContain('⏺ Message from writer')
    expect(frame).toContain('Notes')
    expect(frame).toContain('one')
    expect(frame).not.toContain('## Notes')
  })
})
