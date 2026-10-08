/**
 * The thinking indicator during a `respond()` continuation: the live message already holds text
 * and tool parts of earlier steps, but the agent is still working (regression: the indicator was
 * hidden as soon as the message had any text, so a dismissed question looked like a stopped agent).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { CoderConfig, CoderMessage } from '../src/contracts.ts'
import { initialState } from '../src/ui/state.ts'
import { Transcript } from '../src/ui/Transcript.tsx'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const config = { root: '/tmp/p', model: 'm', mode: 'default' } as unknown as CoderConfig

function frameOf(live: CoderMessage, running = true): string {
  const state = { ...initialState(), running, live }
  const view = render(<Transcript state={state} config={config} />)
  cleanups.push(view.unmount)
  return view.lastFrame() ?? ''
}

const earlier: CoderMessage['parts'] = [
  { type: 'step-start' },
  { type: 'reasoning', text: 'plan the questions', state: 'done' },
  { type: 'text', text: 'Let me ask you first.', state: 'done' },
  {
    type: 'tool-ask_user_question',
    toolCallId: 'c1',
    state: 'output-available',
    input: { questions: [] },
    output: 'The user dismissed the questions without answering.',
  } as unknown as CoderMessage['parts'][number],
]

describe('thinking indicator in a continuation', () => {
  test('shows while the next step has produced nothing yet', () => {
    const live = {
      id: 'a',
      role: 'assistant',
      parts: [...earlier, { type: 'step-start' }],
    } as CoderMessage
    expect(frameOf(live)).toContain('esc to interrupt')
  })

  test('shows while text of the current step streams', () => {
    const live = {
      id: 'a',
      role: 'assistant',
      parts: [
        ...earlier,
        { type: 'step-start' },
        { type: 'text', text: 'Going on', state: 'streaming' },
      ],
    } as CoderMessage
    expect(frameOf(live)).toContain('esc to interrupt')
  })

  test('is replaced by the reasoning line while reasoning of the current step streams', () => {
    const live = {
      id: 'a',
      role: 'assistant',
      parts: [
        ...earlier,
        { type: 'step-start' },
        { type: 'reasoning', text: 'hmm', state: 'streaming' },
      ],
    } as CoderMessage
    const frame = frameOf(live)
    expect(frame).toContain('Thinking')
    expect(frame).not.toContain('esc to interrupt')
  })

  test('is gone when the turn is not running', () => {
    const live = { id: 'a', role: 'assistant', parts: [...earlier] } as CoderMessage
    expect(frameOf(live, false)).not.toContain('esc to interrupt')
  })
})
