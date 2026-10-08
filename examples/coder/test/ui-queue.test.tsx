import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.tsx'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const UP = '\x1b[A'
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, label: string, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await tick(10)
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function mount(opts: Parameters<typeof fakeController>[0] = {}) {
  const fake = fakeController(opts)
  const app = render(<App controller={fake.controller} />)
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  return { ...fake, app, frame, type }
}

/** A turn with a tool call, then a slow final answer: the tool result lands mid-turn. */
const TOOL_TURN = [
  {
    toolCalls: [{ toolName: 'read_file', input: { path: '/a.ts' }, toolCallId: 'r1' }],
    delayMs: 400,
  },
  { text: 'final answer', delayMs: 500 },
]
const SLOW = [{ text: 'slow answer', delayMs: 400 }]

describe('message queue', () => {
  test('Enter while running queues the message in gray above the prompt, with a footer hint', async () => {
    const { frame, type, calls } = mount({ script: SLOW })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('two')
    await type(ENTER)
    await until(() => frame().includes('⧗ two'), 'queued')
    expect(frame()).toContain('1 queued · ↑ to edit')
    expect(calls.filter((c) => c.startsWith('run:'))).toHaveLength(1)
  })

  test('delivered on the first tool result via one steer call with the joined text', async () => {
    const { frame, type, calls } = mount({ script: TOOL_TURN })
    await type('go')
    await type(ENTER)
    await until(() => calls.includes('run:go'), 'run')
    await type('first')
    await type(ENTER)
    await type('second')
    await type(ENTER)
    await until(() => calls.includes('steer:first\n\nsecond'), 'steer')
    expect(calls.filter((c) => c.startsWith('steer:'))).toHaveLength(1)
    await until(() => !frame().includes('⧗'), 'queue emptied')
    await until(() => frame().includes('final answer'), 'finish')
    // nothing is sent as a second prompt: the steer delivered it
    await tick(100)
    expect(calls.filter((c) => c.startsWith('run:'))).toEqual(['run:go'])
  })

  test('a steer that finds no running turn runs as a turn of its own', async () => {
    const { frame, type, calls } = mount({
      script: [...TOOL_TURN, { text: 'own turn answer' }],
      steerAs: 'turn',
    })
    await type('go')
    await type(ENTER)
    await until(() => calls.includes('run:go'), 'run')
    await type('later')
    await type(ENTER)
    await until(() => calls.includes('steer:later'), 'steer')
    await until(() => frame().includes('> later'), 'user line')
  })

  test('messages left after the turn ends are sent as one combined prompt', async () => {
    const { type, calls, frame } = mount({ script: [{ text: 'a', delayMs: 300 }, { text: 'b' }] })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('two')
    await type(ENTER)
    await type('three')
    await type(ENTER)
    await until(() => calls.includes('run:two\n\nthree'), 'combined run')
    expect(calls.filter((c) => c.startsWith('steer:'))).toHaveLength(0)
    await until(() => !frame().includes('⧗'), 'queue emptied')
  })

  test('Up on an empty prompt takes the queued entries back, one per line', async () => {
    const { type, calls, frame } = mount({ script: SLOW })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('alpha')
    await type(ENTER)
    await type('beta')
    await type(ENTER)
    await until(() => frame().includes('2 queued'), 'queued')
    await type(UP)
    await until(() => !frame().includes('⧗'), 'queue cleared')
    expect(frame()).toContain('alpha')
    expect(frame()).toContain('beta')
    await until(() => frame().includes('slow answer'), 'turn end')
    await tick(100)
    expect(calls.filter((c) => c.startsWith('run:'))).toEqual(['run:one'])
  })

  test('slash and shell commands are held until the turn ends, then run in order', async () => {
    const { type, calls, frame, controller } = mount({ script: SLOW })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('!ls')
    await type(ENTER)
    await type('/todos')
    await type(ENTER)
    await tick(100)
    expect(controller.shellCalls).toEqual([])
    expect(frame()).toContain('⧗ !ls')
    expect(frame()).toContain('⧗ /todos')
    await until(() => controller.shellCalls.length === 1, 'shell')
    await until(() => frame().includes('No todos.'), 'slash ran')
    expect(frame()).not.toContain('⧗')
  })

  test('Esc interrupts the turn and then sends the queued messages right away', async () => {
    const { type, calls } = mount({ script: [{ text: 'slow', delayMs: 2000 }, { text: 'next' }] })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('queued msg')
    await type(ENTER)
    await tick(50)
    await type(ESC)
    await until(() => calls.includes('abort'), 'abort')
    await until(() => calls.includes('run:queued msg'), 'queued sent', 3000)
  })
})
