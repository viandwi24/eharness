import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { BackgroundTask } from '../src/contracts.ts'
import { MODE_CYCLE, TOOL } from '../src/contracts.ts'
import { App } from '../src/ui/App.tsx'
import { FooterTasks, taskRowText } from '../src/ui/FooterTasks.tsx'
import { effortLevels, effortLine } from '../src/ui/pickers/ModelPicker.tsx'
import { moveIndex, selectAction } from '../src/ui/select.ts'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const SHIFT_TAB = '\x1b[Z'
const CTRL_C = '\x03'
const ALT_P = '\x1bp'
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

const TASKS: BackgroundTask[] = [
  {
    id: 'bash-1',
    kind: 'shell',
    label: 'npm test',
    status: 'running',
    startedAt: Date.now() - 12_000,
    tail: 'tests running',
  },
  {
    id: 'agent-1',
    kind: 'agent',
    label: 'explore: Find auth code',
    status: 'running',
    startedAt: Date.now() - 3_000,
    tail: '',
  },
]

describe('mode indicator', () => {
  test('every Shift+Tab press shows the new mode, manual included', async () => {
    const m = mount()
    expect(m.frame()).toContain('⏸ manual mode on (shift+tab to cycle) · ? for shortcuts')
    const seen: string[] = []
    for (let i = 0; i < MODE_CYCLE.length; i++) {
      await m.type(SHIFT_TAB)
      seen.push(m.frame())
    }
    const labels = ['accept edits on', 'plan mode on', 'manual mode on']
    for (const label of labels) {
      expect(seen.some((f) => f.includes(label))).toBe(true)
    }
    for (const f of seen) expect(f).toContain('(shift+tab to cycle)')
  })

  test('optional modes join the cycle after plan: bypass first, auto last, then manual again', async () => {
    const m = mount({ autoInCycle: true, bypassInCycle: true })
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      await m.type(SHIFT_TAB)
      seen.push(m.frame())
    }
    const order = [
      'accept edits on',
      'plan mode on',
      'bypass permissions on',
      'auto mode on',
      'manual mode on',
    ]
    for (const [i, label] of order.entries()) expect(seen[i]).toContain(label)
  })

  test('auto mode: indicator and a transient notice per block', async () => {
    const m = mount({ mode: 'auto' })
    expect(m.frame()).toContain('⏵⏵ auto mode on (shift+tab to cycle)')
    m.emitAuto({
      type: 'blocked',
      toolName: 'bash',
      reason: 'downloads and runs code',
      state: { paused: false, consecutive: 1, total: 1 },
    })
    await until(
      () => m.frame().includes('auto mode blocked bash: downloads and runs code'),
      'notice',
    )
  })

  test('auto mode pause is shown in the footer and the transcript, a resume clears it', async () => {
    const m = mount({ mode: 'auto' })
    m.emitAuto({
      type: 'paused',
      cause: 'consecutive',
      state: { paused: true, consecutive: 3, total: 3 },
    })
    await until(() => m.frame().includes('auto mode paused · approve to resume'), 'paused footer')
    expect(m.frame()).toContain('Auto mode paused after 3 blocked')
    m.emitAuto({ type: 'resumed', state: { paused: false, consecutive: 0, total: 3 } })
    await until(() => m.frame().includes('auto mode resumed'), 'resumed notice')
  })

  test('? for shortcuts goes away once something is typed', async () => {
    const m = mount()
    await m.type('hi')
    expect(m.frame()).toContain('manual mode on')
    expect(m.frame()).not.toContain('? for shortcuts')
  })
})

describe('footer tasks', () => {
  test('row text', () => {
    const now = Date.now()
    expect(taskRowText({ ...(TASKS[0] as BackgroundTask), startedAt: now - 12_000 }, now)).toBe(
      '⧉ bash-1 · npm test · running 12s',
    )
    expect(taskRowText({ ...(TASKS[1] as BackgroundTask), startedAt: now - 3_000 }, now)).toBe(
      '◆ explore · Find auth code · running 3s',
    )
  })

  test('rows render, the selected one is marked', () => {
    const app = render(<FooterTasks tasks={TASKS} selected={1} />)
    cleanup.push(() => app.unmount())
    const out = app.lastFrame() ?? ''
    expect(out).toContain('  ⧉ bash-1')
    expect(out).toContain('❯ ◆ explore')
    expect(out).toContain('x stop')
  })

  test('Down enters the footer, Right/Left move, x stops, Esc leaves', async () => {
    const m = mount({ tasks: TASKS })
    await until(() => m.frame().includes('⧉ bash-1'), 'rows')
    expect(m.frame()).not.toContain('❯ ⧉')
    await m.type(DOWN)
    await until(() => m.frame().includes('❯ ⧉ bash-1'), 'first selected')
    await m.type(RIGHT)
    await until(() => m.frame().includes('❯ ◆ explore'), 'second selected')
    await m.type(LEFT)
    await until(() => m.frame().includes('❯ ⧉ bash-1'), 'back to first')
    await m.type('x')
    await until(() => m.calls.includes('stopTask:bash-1'), 'stop')
    await m.type(ESC)
    await until(() => !m.frame().includes('❯ ⧉') && !m.frame().includes('❯ ◆'), 'cleared')
  })

  test('Up at the top deselects; Shift+Tab still cycles the mode', async () => {
    const m = mount({ tasks: TASKS })
    await m.type(DOWN)
    await until(() => m.frame().includes('❯ ⧉ bash-1'), 'selected')
    await m.type(SHIFT_TAB)
    await until(() => m.frame().includes('accept edits on'), 'mode cycled')
    await m.type(UP)
    await until(() => !m.frame().includes('❯ ⧉'), 'deselected')
  })

  test('Enter opens the task page with its output', async () => {
    const m = mount({ tasks: TASKS })
    await m.type(DOWN)
    await until(() => m.frame().includes('❯ ⧉ bash-1'), 'selected')
    await m.type(ENTER)
    await until(() => m.frame().includes('Output of bash-1'), 'page')
    expect(m.frame()).toContain('tests running')
  })

  test('typed text is not entered while a row is selected', async () => {
    const m = mount({ tasks: TASKS })
    await m.type(DOWN)
    await until(() => m.frame().includes('❯ ⧉ bash-1'), 'selected')
    await m.type('z')
    await m.type(ESC)
    await m.type('ok')
    expect(m.frame()).not.toContain('zok')
  })
})

describe('model picker effort', () => {
  test('slider text', () => {
    expect(effortLine(effortLevels('medium'), 'medium')).toContain('○ none ○ low ● medium ○ high')
  })

  test('Left/Right change the effort and Enter applies model and effort', async () => {
    const m = mount({ thinking: 'medium' })
    await m.type(ALT_P)
    await until(() => m.frame().includes('GPT-5'), 'rows')
    expect(m.frame()).toContain('● medium')
    await m.type(RIGHT)
    await until(() => m.frame().includes('● high'), 'high')
    await m.type('gpt')
    await m.type(ENTER)
    await until(() => m.calls.includes('setModel:openai/gpt-5'), 'setModel')
    expect(m.calls).toContain('setThinking:high')
  })

  test('a model without reasoning shows no slider', async () => {
    const m = mount({ thinking: 'medium' })
    await m.type(ALT_P)
    await until(() => m.frame().includes('Llama 3 8B'), 'rows')
    await m.type('llama')
    await until(() => m.frame().includes('not supported by this model'), 'no slider')
  })

  test('s applies for this session only', async () => {
    const m = mount({ thinking: 'medium' })
    await m.type(ALT_P)
    await until(() => m.frame().includes('GPT-5'), 'rows')
    await m.type(DOWN)
    await m.type('s')
    await until(() => m.calls.some((c) => c.endsWith(':session')), 'session only')
    expect(m.calls.some((c) => c.startsWith('setModel:') && c.endsWith(':session'))).toBe(true)
  })
})

describe('select keys', () => {
  test('actions and movement', () => {
    const key = (over: Record<string, boolean>): never =>
      ({
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageUp: false,
        pageDown: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        meta: false,
        shift: false,
        tab: false,
        ...over,
      }) as never
    expect(selectAction('j', key({}))).toBe('next')
    expect(selectAction('j', key({}), { letters: false })).toBeNull()
    expect(selectAction('n', key({ ctrl: true }))).toBe('next')
    expect(selectAction('p', key({ ctrl: true }))).toBe('previous')
    expect(selectAction('', key({ pageDown: true }))).toBe('pageDown')
    expect(selectAction('', key({ end: true }))).toBe('last')
    expect(moveIndex(0, 20, 'pageDown', 8)).toBe(8)
    expect(moveIndex(3, 20, 'first')).toBe(0)
    expect(moveIndex(3, 20, 'last')).toBe(19)
    expect(moveIndex(0, 3, 'previous')).toBe(0)
  })

  test('the session picker takes j/k and End', async () => {
    const sessions = [1, 2, 3].map((n) => ({
      id: `s${n}`,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      firstPrompt: `prompt ${n}`,
      messageCount: 1,
    }))
    const m = mount({ sessions: sessions as never, resume: true })
    await until(() => m.frame().includes('prompt 3'), 'picker')
    await m.type('j')
    await m.type('\x1b[F')
    await m.type(ENTER)
    await until(() => m.calls.includes('resume:s3'), 'resume last')
  })
})

describe('dialogs and Ctrl+C', () => {
  test('Ctrl+C twice closes a picker instead of exiting', async () => {
    const m = mount()
    await m.type(ALT_P)
    await until(() => m.frame().includes('Select model'), 'picker')
    await m.type(CTRL_C)
    await until(() => m.frame().includes('press Ctrl+C again to close'), 'hint')
    expect(m.frame()).toContain('Select model')
    await m.type(CTRL_C)
    await until(() => !m.frame().includes('Select model'), 'closed')
  })

  test('Shift+Tab on a file prompt highlights the session option; Enter answers it', async () => {
    const m = mount()
    m.broker.push({
      id: 'p1',
      toolName: TOOL.edit,
      input: { path: '/work/a.ts' },
      title: 'Edit a.ts',
      suggestedRule: 'Edit(/work/**)',
    })
    await until(() => m.frame().includes('Do you want to make this edit'), 'prompt')
    await m.type(SHIFT_TAB)
    await until(() => m.frame().includes("❯ 2. Yes, and don't ask again"), 'highlight')
    await m.type(ENTER)
    await until(() => m.broker.answers.length === 1, 'answered')
    expect(m.broker.answers[0]?.answer).toMatchObject({ approved: true, remember: 'session' })
  })

  test('Ctrl+C twice declines a pending permission prompt', async () => {
    const m = mount()
    m.broker.push({ id: 'p1', toolName: TOOL.bash, input: { command: 'ls' }, title: 'Bash: ls' })
    await until(() => m.frame().includes('Bash command'), 'prompt')
    await m.type(CTRL_C)
    await m.type(CTRL_C)
    await until(() => m.broker.answers.length === 1, 'declined')
    expect(m.broker.answers[0]?.answer).toMatchObject({ approved: false })
  })
})
