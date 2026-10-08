import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.tsx'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const SHIFT_TAB = '\x1b[Z'
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

describe('render', () => {
  test('splash header and status bar', async () => {
    const { frame } = mount()
    await until(() => frame().includes('provider-default'), 'stats')
    expect(frame()).toContain('coder')
    expect(frame()).toContain('/work/project')
    expect(frame()).toContain('test/model')
    expect(frame()).toContain('/help for help')
    expect(frame()).toContain('? for shortcuts')
    expect(frame()).toContain('model · thinking provider-default')
  })

  test('typing, then a prompt and streamed assistant text', async () => {
    const { frame, type, calls } = mount({ script: [{ text: 'Hello from the model' }] })
    await type('hi there')
    expect(frame()).toContain('hi there')
    await type(ENTER)
    await until(() => frame().includes('Hello from the model'), 'assistant text')
    expect(calls).toContain('run:hi there')
    expect(frame()).toContain('> hi there')
  })

  test('tool cards: read_file and an edit with (+N −M)', async () => {
    const { frame, type } = mount({
      script: [
        {
          toolCalls: [
            { toolName: 'read_file', input: { path: '/src/app.ts' }, toolCallId: 'r1' },
            {
              toolName: 'edit_file',
              toolCallId: 'e1',
              input: { path: '/src/app.ts', old_string: 'a\nb\n', new_string: 'a\nB\nC\n' },
            },
          ],
        },
        { text: 'done editing' },
      ],
    })
    await type('go')
    await type(ENTER)
    await until(() => frame().includes('done editing'), 'finish')
    expect(frame()).toContain('Read(src/app.ts)')
    expect(frame()).toContain('Updated src/app.ts with 2 additions and 1 removal')
  })

  test('unknown slash command prints an error', async () => {
    const { frame, type } = mount()
    await type('/bogus')
    await type(ENTER)
    await until(() => frame().includes('Unknown command /bogus'), 'error')
  })

  test('Shift+Tab cycles the mode and the status bar follows', async () => {
    const { frame, type, calls } = mount()
    await until(() => frame().includes('default'), 'status')
    await type(SHIFT_TAB)
    await until(() => frame().includes('accept edits on'), 'acceptEdits')
    expect(calls).toContain('cycleMode')
    await type(SHIFT_TAB)
    await until(() => frame().includes('plan mode on'), 'plan')
  })

  test('Esc while running calls abort', async () => {
    const { type, calls } = mount({ script: [{ text: 'slow', delayMs: 300 }] })
    await type('go')
    await type(ENTER)
    await until(() => calls.includes('run:go'), 'run')
    await tick(50)
    await type(ESC)
    await until(() => calls.includes('abort'), 'abort')
  })

  test('Esc when idle does not abort', async () => {
    const { type, calls } = mount()
    await type(ESC)
    await tick(100)
    expect(calls).not.toContain('abort')
  })

  test('Enter while a turn runs shows the hint and does not start a second run', async () => {
    const { frame, type, calls } = mount({ script: [{ text: 'slow', delayMs: 300 }] })
    await type('one')
    await type(ENTER)
    await until(() => calls.includes('run:one'), 'run')
    await type('two')
    await type(ENTER)
    await until(() => frame().includes('A turn is running'), 'hint')
    expect(calls.filter((c) => c.startsWith('run:'))).toHaveLength(1)
  })

  test('shell mode runs the command without the model', async () => {
    const { frame, type, controller, calls } = mount()
    await type('!echo hi')
    expect(frame()).toContain('shell mode')
    await type(ENTER)
    await until(() => frame().includes('shell out'), 'shell output')
    expect(controller.shellCalls).toEqual(['echo hi'])
    expect(calls.some((c) => c.startsWith('run:'))).toBe(false)
  })

  test('backslash + Enter inserts a newline instead of submitting', async () => {
    const { type, calls, frame } = mount()
    await type('line1\\')
    await type(ENTER)
    await type('line2')
    expect(calls.some((c) => c.startsWith('run:'))).toBe(false)
    expect(frame()).toContain('line1')
    expect(frame()).toContain('line2')
  })

  test('@ mention shows file completions and Tab completes', async () => {
    const { type, frame } = mount()
    await type('see @READ')
    await until(() => frame().includes('@README.md'), 'completion')
    await type('\t')
    await until(() => frame().includes('see @README.md'), 'completed')
  })
})

describe('permission prompt', () => {
  const request = {
    id: 'ap1',
    toolName: 'bash',
    input: { command: 'bun test' },
    title: 'Bash: bun test',
    suggestedRule: 'Bash(bun test *)',
  }

  test('appears for a pending request with its options', async () => {
    const { frame, broker } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    expect(frame()).toContain('1. Yes')
    expect(frame()).toContain('No, and tell coder')
  })

  test('key 1 answers approved', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('1')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({ id: 'ap1', answer: { approved: true } })
    await until(() => !frame().includes('Bash command'), 'prompt gone')
  })

  test('key 2 remembers for the session', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('2')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]?.answer).toEqual({ approved: true, remember: 'session' })
  })

  test('key 4 then feedback + Enter denies with the feedback', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('4')
    await until(() => frame().includes('Tell coder what to do differently'), 'feedback')
    await type('use bun run')
    await type(ENTER)
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({
      id: 'ap1',
      answer: { approved: false, feedback: 'use bun run' },
    })
  })

  test('Esc denies; without a rule option 2 is the feedback entry', async () => {
    const { frame, broker, type } = mount()
    broker.push({ ...request, id: 'ap2', suggestedRule: undefined })
    await until(() => frame().includes('Bash command'), 'prompt')
    expect(frame()).not.toContain('3.')
    await type('2')
    await until(() => frame().includes('Tell coder'), 'feedback')
    await type(ESC)
    await until(() => !frame().includes('Tell coder'), 'feedback closed')
    await type(ESC)
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({ id: 'ap2', answer: { approved: false } })
  })

  test('typing into the prompt input is blocked while a request is pending', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('x')
    expect(broker.answers).toHaveLength(0)
  })
})

describe('session picker', () => {
  test('config.resume === true opens the picker; Enter resumes the selection', async () => {
    const { frame, type, calls } = mount({
      resume: true,
      sessions: [
        { id: 'sess-1', updatedAt: Date.UTC(2026, 0, 2, 3, 4), firstPrompt: 'first session' },
        { id: 'sess-2', updatedAt: Date.UTC(2026, 0, 1, 3, 4), firstPrompt: 'second session' },
      ],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    expect(frame()).toContain('2026-01-02 03:04')
    expect(frame()).toContain('first session')
    await type('\x1b[B')
    await type(ENTER)
    await until(() => calls.includes('resume:sess-2'), 'resume')
    await until(() => frame().includes('Resumed session sess-2.'), 'note')
    expect(frame()).not.toContain('Resume a session')
  })

  test('no stored sessions: the picker closes itself', async () => {
    const { frame } = mount({ resume: true, sessions: [] })
    await tick(100)
    expect(frame()).not.toContain('Resume a session')
  })

  test('Esc cancels the picker', async () => {
    const { frame, type } = mount({
      resume: true,
      sessions: [{ id: 'a', updatedAt: 0, firstPrompt: 'x' }],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    await type(ESC)
    await until(() => !frame().includes('Resume a session'), 'closed')
  })
})

describe('review fixes', () => {
  const request = {
    id: 'ap1',
    toolName: 'bash',
    input: {},
    title: 'Bash: bun test',
    suggestedRule: 'Bash(bun test *)',
  }

  test('Shift+Tab is ignored while a permission prompt is open', async () => {
    const { frame, broker, type, calls } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type(SHIFT_TAB)
    await tick(50)
    expect(calls).not.toContain('cycleMode')
    expect(frame()).toContain('❯ 1. Yes')
    await type('1')
    await until(() => broker.answers.length === 1, 'answer')
    await type(SHIFT_TAB)
    await until(() => calls.includes('cycleMode'), 'cycle after prompt')
  })

  test('Shift+Tab is ignored while the session picker is open', async () => {
    const { frame, type, calls } = mount({
      resume: true,
      sessions: [{ id: 'a', updatedAt: 0, firstPrompt: 'x' }],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    await type(SHIFT_TAB)
    await tick(50)
    expect(calls).not.toContain('cycleMode')
  })

  test('control characters are stripped from title and detail', async () => {
    const { frame, broker } = mount()
    broker.push({
      ...request,
      title: 'Bash: \x1b[31mred\x1b[0m\x07 cmd',
      detail: 'line \x1b]0;pwned\x07one\x1b[2J\r\ntwo',
    })
    await until(() => frame().includes('line one'), 'prompt')
    expect(frame()).toContain('two')
    expect(frame()).not.toContain('pwned')
    expect(frame()).not.toContain('\x07')
  })

  test('detail shows 20 lines and a "more lines" note', async () => {
    const { frame, broker } = mount()
    broker.push({
      ...request,
      detail: Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n'),
    })
    await until(() => frame().includes('row19'), 'detail')
    expect(frame()).not.toContain('row20')
    expect(frame()).toContain('… 10 more lines')
  })

  test('untrusted project settings show one notice at start', async () => {
    const { frame } = mount({ untrusted: ['allow', 'mcpServers'] })
    await until(() => frame().includes('Project settings ignored until trusted'), 'notice')
    expect(frame()).toContain('allow, mcpServers')
    expect(frame()).toContain('--trust-project')
  })

  test('no notice when trusted', async () => {
    const { frame } = mount()
    await until(() => frame().includes('provider-default'), 'stats')
    expect(frame()).not.toContain('Project settings ignored')
  })

  test('/permissions allow edits rules and /permissions lists them', async () => {
    const { frame, type, calls } = mount()
    await type('/permissions allow Bash(ls) --project')
    await type(ENTER)
    await until(() => frame().includes('Added allow rule Bash(ls)'), 'added')
    expect(calls).toContain('addRule:allow:Bash(ls):project')
    await type('/permissions')
    await type(ENTER)
    await until(() => frame().includes('Permissions'), 'page')
    await until(() => frame().includes('Bash(ls)') && frame().includes('allow (1)'), 'list')
  })

  test('/permissions mode refuses bypassPermissions without --yes', async () => {
    const { frame, type, calls } = mount()
    await type('/permissions mode bypassPermissions')
    await type(ENTER)
    await until(() => frame().includes('Confirm with'), 'refused')
    expect(calls).not.toContain('setMode:bypassPermissions')
  })

  test('/resume unknown shows the controller error', async () => {
    const { frame, type } = mount()
    await type('/resume unknown')
    await type(ENTER)
    await until(() => frame().includes('unknown session'), 'error')
    expect(frame()).not.toContain('Resumed session')
  })

  test('/agents with no runs lists nothing to open', async () => {
    const { frame, type } = mount()
    await type('/agents 1')
    await type(ENTER)
    await until(() => frame().includes('No subagent runs'), 'no runs')
  })
})
