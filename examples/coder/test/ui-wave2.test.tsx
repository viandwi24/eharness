import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import type { BackgroundTask } from '../src/contracts.ts'
import { App } from '../src/ui/App.tsx'
import { runTurn } from '../src/ui/driver.ts'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const CTRL_D = '\x04'
const CTRL_T = '\x14'
const TAB = '\t'
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, label: string, ms = 4000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await tick(10)
  }
}

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanup) await c()
  cleanup = []
})

function mount(opts: Parameters<typeof fakeController>[0] = {}) {
  const fake = fakeController(opts)
  const notices: Array<{ text: string; mode: string }> = []
  const titles: string[] = []
  const copied: string[] = []
  const app = render(
    <App
      controller={fake.controller}
      io={{
        notify: (text, mode) => void notices.push({ text, mode }),
        setTitle: (t) => void titles.push(t),
        copy: async (t) => {
          copied.push(t)
          return 'pbcopy'
        },
      }}
    />,
  )
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  const run = async (line: string): Promise<void> => {
    await type(line)
    await type(ENTER)
  }
  return { ...fake, app, frame, type, run, notices, titles, copied }
}

const POINTS = [
  { messageId: 'u1', text: 'first prompt', at: Date.now() - 600_000, files: [] },
  { messageId: 'u2', text: 'second prompt', at: Date.now() - 60_000, files: ['a.ts', 'b.ts'] },
]

describe('rewind', () => {
  test('menu lists newest first, restores, reloads and puts the prompt back', async () => {
    const m = mount({ rewindPoints: POINTS })
    await m.run('/rewind')
    await until(() => m.frame().includes('Rewind to a previous prompt'), 'menu')
    expect(m.frame().indexOf('second prompt')).toBeLessThan(m.frame().indexOf('first prompt'))
    expect(m.frame()).toContain('2 files changed')
    await m.type(ENTER)
    await until(() => m.frame().includes('Restore code and conversation'), 'actions')
    expect(m.frame()).toContain('Restore conversation')
    expect(m.frame()).toContain('Cancel')
    await m.type(ENTER)
    await until(() => m.calls.includes('rewind:u2:both'), 'rewind')
    await until(() => m.frame().includes('Restored 2 files'), 'system line')
    await until(() => m.frame().includes('second prompt'), 'prompt back in the input')
    expect(m.frame()).not.toContain('Rewind to a previous prompt')
  })

  test('Esc closes the menu', async () => {
    const m = mount({ rewindPoints: POINTS })
    await m.run('/rewind')
    await until(() => m.frame().includes('Rewind to a previous prompt'), 'menu')
    await m.type(ESC)
    await until(() => !m.frame().includes('Rewind to a previous prompt'), 'closed')
    expect(m.calls.some((c) => c.startsWith('rewind:'))).toBe(false)
  })

  test('no points prints a line', async () => {
    const m = mount()
    await m.run('/rewind')
    await until(() => m.frame().includes('Nothing to rewind to yet.'), 'line')
  })
})

describe('session commands', () => {
  test('/branch, /rename, /recap, /compact, /add-dir', async () => {
    const m = mount()
    await m.run('/rename my work')
    await until(() => m.frame().includes('Session renamed to "my work"'), 'rename')
    await until(() => m.titles.includes('coder · my work'), 'title')
    await m.run('/branch fork')
    await until(() => m.frame().includes('Branched into session s-branch'), 'branch')
    await m.run('/recap')
    await until(() => m.frame().includes('You were fixing the parser.'), 'recap')
    await m.run('/compact keep the API notes')
    await until(() => m.calls.includes('compact:keep the API notes'), 'compact')
    await m.run('/add-dir ../shared')
    await until(() => m.frame().includes('/@dirs/shared/'), 'add-dir')
  })

  test('/copy copies the n-th assistant response', async () => {
    const m = mount()
    await m.run('/copy 2')
    await until(() => m.copied.length === 1, 'copy')
    expect(m.copied[0]).toBe('older answer')
    expect(m.frame()).toContain('pbcopy')
  })

  test('/export writes the conversation under the project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coder-export-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const fake = fakeController({ exportText: 'hello export' })
    ;(fake.controller.config as { root: string }).root = root
    const app = render(
      <App controller={fake.controller} io={{ setTitle: () => {}, notify: () => {} }} />,
    )
    cleanup.push(() => app.unmount())
    app.stdin.write('/export out.txt')
    await tick()
    app.stdin.write(ENTER)
    await until(() => (app.lastFrame() ?? '').includes('Exported the conversation'), 'exported')
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello export')
  })
})

describe('/btw', () => {
  test('streams the answer in a dim box that is not in the transcript, Esc closes', async () => {
    const m = mount({ sideChunks: ['part one ', 'part two'], sideDelayMs: 60 })
    await m.run('/btw what is this?')
    await until(() => m.frame().includes('part one'), 'first chunk')
    expect(m.frame()).toContain('esc to cancel')
    await until(() => m.frame().includes('part one part two'), 'whole answer')
    await m.type(ESC)
    await until(() => !m.frame().includes('part one'), 'closed')
    expect(m.calls).toContain('side:what is this?')
  })

  test('Esc while streaming aborts the request', async () => {
    const m = mount({ sideChunks: ['a', 'b', 'c', 'd'], sideDelayMs: 80 })
    await m.run('/btw q')
    await until(() => m.frame().includes('esc to cancel'), 'box')
    await m.type(ESC)
    await until(() => m.calls.includes('side:aborted'), 'aborted')
    expect(m.frame()).not.toContain('esc to cancel')
  })
})

describe('settings commands', () => {
  test('/theme, /vim, /sandbox, /output-style', async () => {
    const m = mount()
    await m.run('/theme light')
    await until(() => m.calls.includes('updateSetting:theme:"light":user'), 'theme')
    await m.run('/theme neon')
    await until(() => m.frame().includes('Unknown theme "neon"'), 'bad theme')
    await m.run('/vim')
    await until(() => m.calls.includes('updateSetting:editorMode:"vim":user'), 'vim')
    await until(() => m.frame().includes('INSERT'), 'vim label in footer')
    await m.run('/sandbox')
    await until(() => m.calls.includes('updateSetting:sandbox.enabled:true:local'), 'sandbox')
    await m.run('/output-style concise')
    await until(() => m.calls.includes('updateSetting:outputStyle:"concise":local'), 'style')
  })

  test('/output-style without a name opens the picker', async () => {
    const m = mount()
    await m.run('/output-style')
    await until(
      () => m.frame().includes('Output style') && m.frame().includes('learning'),
      'picker',
    )
    await m.type(DOWN)
    await m.type(ENTER)
    await until(() => m.calls.includes('updateSetting:outputStyle:"concise":local'), 'saved')
  })

  test('/focus and Ctrl+T', async () => {
    const m = mount()
    await m.run('/focus')
    await until(() => m.frame().includes('Focus view on.'), 'focus')
    await m.type(CTRL_T)
  })
})

describe('pages', () => {
  test('/config toggles a boolean and saves it with the default scope', async () => {
    const m = mount()
    await m.run('/config')
    await until(() => m.frame().includes('false [default]'), 'config page')
    await tick(60)
    await m.type(ENTER)
    await until(() => m.calls.includes('updateSetting:promptSuggestions:true:local'), 'toggle')
    await until(() => m.frame().includes('Saved promptSuggestions (local).'), 'note')
    await m.type(DOWN)
    await m.type('u')
    await m.type(' ')
    await until(() => m.calls.includes('updateSetting:theme:"light":user'), 'enum cycle')
  })

  test('/config edits a number inline', async () => {
    const m = mount()
    await m.run('/config')
    await until(() => m.frame().includes('0 [default]'), 'page')
    await tick(60)
    await m.type(DOWN)
    await m.type(DOWN)
    await m.type(ENTER)
    await m.type('q')
    await m.type('9')
    await m.type(ENTER)
    // `q` is typed into the field (not "close page"); not a number
    await until(() => m.frame().includes('Not a number.'), 'validation')
  })

  test('/tasks lists tasks, shows output, stops one, follows live updates', async () => {
    const task: BackgroundTask = {
      id: 'bash-1',
      kind: 'shell',
      label: 'sleep 100',
      status: 'running',
      startedAt: Date.now() - 5000,
      tail: 'tail line',
    }
    const m = mount({ tasks: [task] })
    await m.run('/tasks')
    await until(() => m.frame().includes('bash-1'), 'tasks page')
    await tick(60)
    await m.type(ENTER)
    await until(() => m.frame().includes('tail line'), 'output')
    await m.type('k')
    await until(() => m.calls.includes('stopTask:bash-1'), 'stop')
    await until(() => m.frame().includes('stopped'), 'status updates')
  })

  test('/doctor shows the marks', async () => {
    const m = mount()
    await m.run('/doctor')
    await until(() => m.frame().includes('OPENROUTER_API_KEY missing'), 'doctor')
    expect(m.frame()).toContain('✓')
    expect(m.frame()).toContain('!')
    expect(m.frame()).toContain('✗')
  })

  test('/memory lists files with scope and existence', async () => {
    const m = mount()
    await m.run('/memory')
    await until(() => m.frame().includes('AGENTS.md'), 'memory')
    expect(m.frame()).toContain('project · exists')
    expect(m.frame()).toContain('user · not created')
  })

  test('/help lists the new commands', async () => {
    const m = mount()
    await m.run('/help')
    await until(() => m.frame().includes('/rewind'), 'help')
    expect(m.frame()).toContain('/branch')
  })
})

describe('background tasks', () => {
  test('footer count and a system line when one finishes', async () => {
    const m = mount()
    const base: BackgroundTask = {
      id: 'bash-1',
      kind: 'shell',
      label: 'x',
      status: 'running',
      startedAt: Date.now(),
      tail: '',
    }
    m.setTasks([base])
    await until(() => m.frame().includes('1 background'), 'count')
    m.setTasks([{ ...base, status: 'completed', exitCode: 0, endedAt: Date.now() }])
    await until(() => m.frame().includes('Background task bash-1 finished (exit 0)'), 'line')
  })
})

describe('suggestions, notifications, exit', () => {
  test('a suggestion is the placeholder and Tab accepts it', async () => {
    const m = mount({ settingValues: { promptSuggestions: true }, suggestion: 'run the tests' })
    await m.run('hi')
    await until(() => m.calls.includes('suggestNext'), 'suggestNext')
    await until(() => m.frame().includes('run the tests'), 'placeholder')
    await m.type(TAB)
    await until(
      () => !m.frame().includes('Try "') && m.frame().includes('run the tests'),
      'accepted',
    )
    await m.type(ENTER)
    await until(() => m.calls.includes('run:run the tests'), 'submitted')
  })

  test('no suggestion call when the setting is off', async () => {
    const m = mount()
    await m.run('hi')
    await until(() => m.notices.length > 0, 'turn end')
    expect(m.calls).not.toContain('suggestNext')
  })

  test('notify on turn end with the configured mode, and the title follows the first prompt', async () => {
    const m = mount({ settingValues: { notifications: 'desktop' } })
    await m.run('write tests')
    await until(() => m.notices.some((n) => n.text === 'coder: turn finished'), 'notify')
    expect(m.notices.find((n) => n.text === 'coder: turn finished')?.mode).toBe('desktop')
    expect(m.titles).toContain('coder · write tests')
  })

  test('notify when a permission prompt appears', async () => {
    const m = mount()
    m.broker.push({ id: 'p1', toolName: 'bash', input: { command: 'ls' } } as never)
    await until(() => m.notices.some((n) => n.text === 'coder needs your input'), 'notify')
  })

  test('Ctrl+D twice within the window exits (aborting the turn)', async () => {
    const m = mount({ script: [{ text: 'slow', delayMs: 800 }] })
    await m.run('go')
    await until(() => m.calls.includes('run:go'), 'run')
    await m.type(CTRL_D)
    await until(() => m.frame().includes('press Ctrl+D again to exit'), 'hint')
    await m.type(CTRL_D)
    await until(() => m.calls.includes('abort'), 'exit')
  })

  test('a single Ctrl+D does not exit', async () => {
    const m = mount({ script: [{ text: 'slow', delayMs: 600 }] })
    await m.run('go')
    await until(() => m.calls.includes('run:go'), 'run')
    await m.type(CTRL_D)
    await tick(900)
    await m.type(CTRL_D)
    expect(m.calls).not.toContain('abort')
  })
})

describe('images', () => {
  test('files are passed to controller.run', async () => {
    const { controller, calls, runFiles } = fakeController()
    const file = {
      type: 'file' as const,
      mediaType: 'image/png',
      url: 'data:image/png;base64,AAAA',
    }
    await runTurn(controller, 'look', () => {}, {}, [file])
    expect(calls).toContain('run:look')
    expect(calls).toContain('files:1')
    expect(runFiles[0]).toEqual([file])
  })
})
