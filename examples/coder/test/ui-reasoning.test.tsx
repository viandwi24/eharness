import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { CoderMessage } from '../src/contracts.ts'
import { MessageView } from '../src/ui/MessageView.tsx'
import { Reasoning, thoughtDuration } from '../src/ui/Reasoning.tsx'

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})
function mount(node: React.ReactElement) {
  const app = render(node)
  cleanup.push(() => app.unmount())
  return app
}

const msg = (parts: unknown[]): CoderMessage =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as CoderMessage

describe('Reasoning', () => {
  test('thoughtDuration', () => {
    expect(thoughtDuration(12_000)).toBe('12s')
    expect(thoughtDuration(100)).toBe('1s')
    expect(thoughtDuration(65_000)).toBe('1m 05s')
  })

  test('collapsed: duration and first line', () => {
    const app = mount(
      <Reasoning
        text={'first idea\nsecond idea'}
        state="done"
        expanded={false}
        durationMs={12_000}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('∴ Thought for 12s')
    expect(frame).toContain('⎿')
    expect(frame).toContain('first idea')
    expect(frame).not.toContain('second idea')
  })

  test('expanded: the full text', () => {
    const app = mount(
      <Reasoning text={'first idea\nsecond idea'} state="done" expanded durationMs={12_000} />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('first idea')
    expect(frame).toContain('second idea')
  })

  test('streaming shows Thinking… and no text; measures the duration afterwards', async () => {
    const app = mount(<Reasoning text="partial" state="streaming" expanded={false} />)
    expect(app.lastFrame()).toContain('Thinking…')
    expect(app.lastFrame()).not.toContain('partial')
    await tick(1100)
    app.rerender(<Reasoning text="partial done" state="done" expanded={false} />)
    expect(app.lastFrame()).toContain('∴ Thought for 1s')
  })

  test('without any timing there is no duration', () => {
    const app = mount(<Reasoning text="idea" state="done" expanded={false} />)
    expect(app.lastFrame()).toContain('∴ Thought')
    expect(app.lastFrame()).not.toContain('Thought for')
  })

  test('redacted or empty reasoning shows Thinking only', () => {
    const app = mount(<Reasoning text="" state="done" expanded durationMs={5000} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('∴ Thinking')
    expect(frame).not.toContain('⎿')
    expect(frame).not.toContain('Thought for')
  })

  test('MessageView keeps part order: reasoning before text', () => {
    const app = mount(
      <MessageView
        message={msg([
          {
            type: 'reasoning',
            text: 'plan it',
            state: 'done',
            providerMetadata: { eharness: { durationMs: 3000 } },
          },
          { type: 'text', text: 'Answer' },
        ])}
        expanded={false}
        bash={{}}
        timing={{}}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Thought for 3s')
    expect(frame.indexOf('Thought')).toBeLessThan(frame.indexOf('Answer'))
    console.log(frame)
  })
})
