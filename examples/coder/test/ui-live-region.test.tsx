import { afterEach, describe, expect, test } from 'bun:test'
import { Box, Text } from 'ink'
import type { CoderConfig, CoderMessage } from '../src/contracts.ts'
import { subagentEventLine } from '../src/ui/MessageView.tsx'
import { initialState, reduce, type ViewState } from '../src/ui/state.ts'
import { Transcript } from '../src/ui/Transcript.tsx'
import { renderAt } from './term.tsx'

const config = { root: '/work', model: 'm' } as unknown as CoderConfig
const ROWS = 24
let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

const done = (i: number): unknown => ({
  type: 'tool-read_file',
  toolCallId: `c${i}`,
  state: 'output-available',
  input: { path: `/src/file-${i}.ts` },
  output: `content ${i}`,
})

function stateWith(parts: unknown[]): ViewState {
  let s = reduce(initialState(), { type: 'turn-started', now: 1 })
  s = reduce(s, {
    type: 'live',
    message: { id: 'm1', role: 'assistant', parts } as unknown as CoderMessage,
    now: 1,
  })
  return s
}

const Dialog = (): React.ReactElement => (
  <Box flexDirection="column">
    <Text>PERMISSION DIALOG</Text>
    <Text>allow once</Text>
  </Box>
)

describe('live region stays short', () => {
  test('many finished tool calls plus a pending approval: live frame fits, cards print once', async () => {
    const parts: unknown[] = [{ type: 'step-start' }]
    for (let i = 0; i < 30; i++) parts.push(done(i))
    parts.push({
      type: 'tool-bash',
      toolCallId: 'pending',
      state: 'approval-requested',
      input: { command: 'rm -rf build' },
      approval: { id: 'ap1' },
    })
    const state = stateWith(parts)
    expect(state.committed).toBe(31)
    // live area alone (static entries removed): well below the terminal height
    const liveOnly = renderAt(
      <Transcript state={{ ...state, entries: [] }} config={config} />,
      80,
      ROWS,
    )
    cleanup.push(liveOnly.unmount)
    await tick()
    const liveLines = liveOnly.lastFrame().split('\n').length
    expect(liveLines).toBeLessThanOrEqual(ROWS - 4)
    expect(liveOnly.lastFrame()).toContain('rm -rf build')
    expect(liveOnly.lastFrame()).not.toContain('file-3.ts')

    // whole transcript: each finished card appears exactly once, in order
    const app = renderAt(
      <>
        <Transcript state={state} config={config} />
        <Dialog />
      </>,
      80,
      ROWS,
    )
    cleanup.push(app.unmount)
    await tick()
    const out = app.lastFrame()
    for (const i of [0, 7, 29]) expect(out.split(`file-${i}.ts`).length - 1).toBe(1)
    expect(out.indexOf('file-0.ts')).toBeLessThan(out.indexOf('file-29.ts'))
    expect(out.indexOf('file-29.ts')).toBeLessThan(out.indexOf('rm -rf build'))
  })

  test('an oversized streaming tail is clipped to its last lines', async () => {
    const text = Array.from({ length: 80 }, (_, i) => `line-${i}`).join('\n\n')
    const state = stateWith([{ type: 'text', text, state: 'streaming' }])
    const app = renderAt(<Transcript state={{ ...state, entries: [] }} config={config} />, 80, ROWS)
    cleanup.push(app.unmount)
    await tick()
    const frame = app.lastFrame()
    expect(frame.split('\n').length).toBeLessThanOrEqual(ROWS)
    expect(frame).toContain('line-79')
    expect(frame).not.toContain('line-0\n')
  })
})

describe('subagent event rendering', () => {
  const text =
    'Background subagent agent-1 "writer" (general-purpose: Read src and write notes.md) finished.\n\nDone.\n**Files read** a, b\nmore'

  test('framed model text becomes one dim line with the task name', () => {
    const line = subagentEventLine(`<event name="subagent">${text}</event>`)
    expect(line?.head).toBe('⏺ writer finished · general-purpose · Done.')
    expect(line?.report).toHaveLength(3)
  })

  test('unnamed, resumed and failed; other events are not claimed', () => {
    expect(
      subagentEventLine('Resumed subagent agent-2 (explore: look) failed.\n\nboom')?.head,
    ).toBe('⏺ agent-2 failed (resumed) · explore · boom')
    expect(subagentEventLine('<event name="ci">CI red</event>')).toBeUndefined()
  })
})
