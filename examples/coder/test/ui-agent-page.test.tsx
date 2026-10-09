import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { BackgroundTask, CoderMessage } from '../src/contracts.ts'
import { AgentPage } from '../src/ui/pages/AgentPage.tsx'
import type { AgentViewTarget } from '../src/ui/pages/spec.ts'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const SIZE = { rows: 40, columns: 100 }
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, label: string, ms = 3000): Promise<void> {
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

const TASK: BackgroundTask = {
  id: 'agent-2',
  kind: 'agent',
  label: 'writer (general-purpose): Write the docs',
  status: 'running',
  startedAt: Date.now() - 12_000,
  tail: '',
  sessionId: 'child-2',
  agent: 'general-purpose',
  name: 'writer',
}

const TARGET: AgentViewTarget = {
  sessionId: 'child-2',
  name: 'writer',
  agent: 'general-purpose',
  description: 'Write the docs',
  taskId: 'agent-2',
  status: 'running',
}

const user = (text: string): CoderMessage =>
  ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }) as CoderMessage
const assistant = (id: string, parts: unknown[]): CoderMessage =>
  ({ id, role: 'assistant', parts }) as CoderMessage

const readCard = {
  type: 'tool-read_file',
  toolCallId: 'r1',
  state: 'output-available',
  input: { path: '/docs/guide.md' },
  output: 'line one of the guide',
}

function mount(
  opts: { messages?: CoderMessage[]; tasks?: BackgroundTask[]; target?: AgentViewTarget } = {},
) {
  const child: Record<string, CoderMessage[]> = { 'child-2': opts.messages ?? [] }
  const fake = fakeController({ childMessages: child, tasks: opts.tasks ?? [TASK] })
  let closed = 0
  const app = render(
    <AgentPage
      controller={fake.controller}
      target={opts.target ?? TARGET}
      onClose={() => closed++}
      size={SIZE}
      pollMs={20}
    />,
  )
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  return { fake, child, frame, type, closed: () => closed }
}

describe('AgentPage', () => {
  test('header and the child conversation: prompt, tool card and text', async () => {
    const m = mount({
      messages: [
        user('Write the docs for the guide'),
        assistant('a1', [
          { type: 'step-start' },
          readCard,
          { type: 'text', text: 'The guide is **ready**.' },
        ]),
      ],
    })
    await until(() => m.frame().includes('ready'), 'child text')
    const f = m.frame()
    expect(f).toContain('◆ writer · general-purpose · running')
    expect(f).toContain('agent-2')
    expect(f).toContain('Write the docs for the guide')
    expect(f).toContain('docs/guide.md')
    expect(f).toContain('Message writer')
  })

  test('follows the child while it runs', async () => {
    const m = mount({ messages: [user('go')] })
    await until(() => m.frame().includes('go'), 'first load')
    m.child['child-2'] = [
      user('go'),
      assistant('a1', [{ type: 'text', text: 'second step arrived' }]),
    ]
    await until(() => m.frame().includes('second step arrived'), 'live update')
  })

  test('typing and Enter message the agent', async () => {
    const m = mount({ messages: [user('go')] })
    await m.type('also check the tests')
    expect(m.frame()).toContain('also check the tests')
    await m.type(ENTER)
    await until(
      () => m.fake.calls.includes('sendAgentMessage:child-2:also check the tests'),
      'sendAgentMessage',
    )
    await until(() => m.frame().includes('Message delivered'), 'confirmation')
  })

  test('a refusal is shown', async () => {
    const m = mount({
      messages: [user('go')],
      tasks: [{ ...TASK, status: 'completed', endedAt: Date.now() }],
    })
    m.fake.controller.sendAgentMessage = async () => ({
      ok: false,
      error: 'ERROR: explore (explore) has finished and cannot be resumed (a one-shot agent).',
    })
    await m.type('more')
    await m.type(ENTER)
    await until(() => m.frame().includes('cannot be resumed'), 'refusal')
    expect(m.frame()).toContain('done')
  })

  test('q is typed into the prompt, Esc closes', async () => {
    const m = mount({ messages: [user('go')] })
    await m.type('q')
    expect(m.closed()).toBe(0)
    expect(m.frame()).toContain('q')
    const typed = mount({ messages: [user('go')] })
    await typed.type('hello q')
    expect(typed.closed()).toBe(0)
    expect(typed.frame()).toContain('hello q')
    const esc = mount({ messages: [user('go')] })
    await esc.type(ESC)
    await until(() => esc.closed() === 1, 'esc close')
  })

  test('a run of an earlier process shows its stored messages without a task', async () => {
    const m = mount({
      messages: [user('old task'), assistant('a1', [{ type: 'text', text: 'old result' }])],
      tasks: [],
      target: { sessionId: 'child-2', name: 'explore', description: 'old', status: 'done' },
    })
    await until(() => m.frame().includes('old result'), 'stored messages')
    expect(m.frame()).toContain('◆ explore · done')
  })

  test('a child waiting for approval is labelled', async () => {
    const m = mount({
      messages: [
        user('go'),
        assistant('a1', [
          {
            type: 'tool-bash',
            toolCallId: 'b1',
            state: 'approval-requested',
            input: { command: 'rm -rf x' },
            approval: { id: 'ap1' },
          },
        ]),
      ],
    })
    await until(() => m.frame().includes('waiting for approval: bash'), 'approval note')
  })
})
