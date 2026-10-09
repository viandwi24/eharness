import { afterEach, describe, expect, test } from 'bun:test'
import type { BackgroundTask, CoderMessage } from '../src/contracts.ts'
import { AgentPage } from '../src/ui/pages/AgentPage.tsx'
import { fakeController } from './fake-controller.ts'
import { renderAt } from './term.tsx'

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms))
let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

const TASK: BackgroundTask = {
  id: 'agent-2',
  kind: 'agent',
  label: 'explore',
  status: 'running',
  startedAt: Date.now() - 10_000,
  tail: '',
  sessionId: 'c',
  agent: 'explore',
  name: 'agent-2',
}

const longRead = Array.from(
  { length: 60 },
  (_, i) =>
    `${String(i + 16).padStart(4)}\texport interface Option${i} { Model: '--model <id>', description: 'a very long description line that wraps' }`,
).join('\n')

const messages: CoderMessage[] = [
  {
    id: 'u',
    role: 'user',
    parts: [{ type: 'text', text: 'Research examples/coder' }],
  } as CoderMessage,
  {
    id: 'a',
    role: 'assistant',
    parts: [
      {
        type: 'tool-read_file',
        toolCallId: 'r1',
        state: 'output-available',
        input: { path: 'examples/coder/src/main.tsx' },
        output: longRead,
      },
      { type: 'text', text: 'done '.repeat(60) },
    ],
  } as CoderMessage,
]

describe('page layout', () => {
  test('agent page: collapsed read card, nothing outside the viewport, one counter', async () => {
    const rows = 24
    const columns = 70
    const fake = fakeController({ childMessages: { c: messages }, tasks: [TASK] })
    const app = renderAt(
      <AgentPage
        controller={fake.controller}
        target={{
          sessionId: 'c',
          name: 'agent-2',
          agent: 'explore',
          description: 'Research',
          taskId: 'agent-2',
          status: 'running',
        }}
        onClose={() => {}}
        size={{ rows, columns }}
        pollMs={20}
      />,
      columns,
      rows,
    )
    cleanup.push(() => app.unmount())
    await tick(300)
    const frame = app.lastFrame()
    const lines = frame.split('\n')
    expect(lines.length).toBeLessThanOrEqual(rows)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns)
    expect(lines[0]).toContain('agent-2')
    expect(frame).toContain('Message agent-2')
    expect(frame).toContain('esc close')
    expect(frame).not.toContain('export interface Option5 ')
    expect((frame.match(/\d+-\d+\/\d+/g) ?? []).length).toBeLessThanOrEqual(1)
    app.stdin.write('\x0f')
    await tick(200)
    const open = app.lastFrame()
    const ol = open.split('\n')
    expect(open).not.toContain('\t')
    expect(ol[ol.length - 1]).toMatch(/\d+-\d+\/\d+$/)
    expect(ol.length).toBeLessThanOrEqual(rows)
    for (const l of ol) expect(l.length).toBeLessThanOrEqual(columns)
    expect(ol[0]).toContain('agent-2')
    expect(open).toContain('Message agent-2')
    expect(open).toContain('esc close')
    expect((open.match(/\d+-\d+\/\d+/g) ?? []).length).toBe(1)
  })
})
