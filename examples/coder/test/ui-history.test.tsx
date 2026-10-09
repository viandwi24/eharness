import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.tsx'
import { searchMatches, splitMatch } from '../src/ui/history-search.tsx'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const CTRL_R = '\x12'
const CTRL_G = '\x07'
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

const HISTORY = ['fix the login bug', 'write docs', 'Fix the logout bug', 'run tests']

describe('history search helpers', () => {
  test('newest first, case-insensitive, deduplicated', () => {
    expect(searchMatches([...HISTORY, 'run tests'], 'FIX')).toEqual([
      'Fix the logout bug',
      'fix the login bug',
    ])
    expect(searchMatches(HISTORY, '')[0]).toBe('run tests')
    expect(searchMatches(HISTORY, 'zzz')).toEqual([])
  })

  test('splitMatch isolates the first match', () => {
    expect(splitMatch('Fix the bug', 'the')).toEqual({
      before: 'Fix ',
      match: 'the',
      after: ' bug',
    })
  })
})

describe('persistent history', () => {
  test('stored history feeds Up; submitted prompts are added', async () => {
    const { type, frame, calls } = mount({ history: ['older prompt'] })
    await until(() => calls.includes('history:project'), 'loaded')
    await tick(50)
    await type(UP)
    await until(() => frame().includes('older prompt'), 'recalled')
    await type('\x15') // ctrl+u clears
    await type('/todos')
    await type(ENTER)
    await until(() => calls.includes('addHistory:/todos'), 'added')
    await type('hello')
    await type(ENTER)
    await until(() => calls.includes('addHistory:hello'), 'added prompt')
  })
})

/** Text of the (last) prompt box line `│ > text │`. */
function promptLine(frame: string): string {
  const lines = frame.split('\n').filter((l) => /^│ [>!] /.test(l))
  return (lines[lines.length - 1] ?? '').replace(/^│ [>!] /, '').replace(/\s*│$/, '')
}

describe('Up / Down through the App', () => {
  test('two submitted prompts: Up, Up, Down walk them and the typed draft returns', async () => {
    const { type, frame, calls } = mount({
      script: [{ text: 'answer one' }, { text: 'answer two' }],
    })
    await type('first prompt')
    await type(ENTER)
    await until(() => frame().includes('answer one'), 'first turn')
    await type('second prompt')
    await type(ENTER)
    await until(() => frame().includes('answer two'), 'second turn')
    expect(calls).toContain('addHistory:second prompt')
    await type('half typed')
    await type(UP)
    expect(promptLine(frame())).toBe('second prompt')
    await type(UP)
    expect(promptLine(frame())).toBe('first prompt')
    await type(DOWN)
    expect(promptLine(frame())).toBe('second prompt')
    await type(DOWN)
    expect(promptLine(frame())).toBe('half typed')
  })

  test('a recalled slash command keeps Up / Down on history (no command menu)', async () => {
    const { type, frame } = mount({ history: ['older', '/todos'] })
    await tick(80)
    await type(UP)
    expect(promptLine(frame())).toBe('/todos')
    await type(UP)
    expect(promptLine(frame())).toBe('older')
  })
})

describe('Ctrl+R search', () => {
  test('filters, cycles to older matches and Enter accepts into the prompt without sending', async () => {
    const { type, frame, calls } = mount({ history: ['x'], allHistory: HISTORY })
    await type(CTRL_R)
    await until(() => frame().includes('(reverse-i-search)'), 'open')
    await until(() => frame().includes('run tests'), 'pool loaded')
    expect(calls).toContain('history:all')
    await type('fix')
    await until(() => frame().includes("'fix': Fix the logout bug"), 'newest match')
    await type(CTRL_R)
    await until(() => frame().includes("'fix': fix the login bug"), 'older match')
    await type(ENTER)
    await until(() => !frame().includes('reverse-i-search'), 'closed')
    expect(frame()).toContain('> fix the login bug')
    expect(calls.some((c) => c.startsWith('run:'))).toBe(false)
  })

  test('no match shows the failing prompt; Backspace widens; Esc and Ctrl+G cancel', async () => {
    const { type, frame } = mount({ allHistory: HISTORY })
    await type(CTRL_R)
    await type('qqq')
    await until(() => frame().includes('(failing reverse-i-search)'), 'failing')
    await type('\x7f\x7f\x7f')
    await until(() => frame().includes("'': run tests"), 'widened')
    await type(ESC)
    await until(() => !frame().includes('reverse-i-search'), 'esc closed')
    await type(CTRL_R)
    await type('docs')
    await until(() => frame().includes('write docs'), 'match')
    await type(CTRL_G)
    await until(() => !frame().includes('reverse-i-search'), 'ctrl+g closed')
    expect(frame()).not.toContain('> write docs')
  })

  test('Esc closing the search does not interrupt a running turn', async () => {
    const { type, calls, frame } = mount({
      script: [{ text: 'slow', delayMs: 500 }],
      allHistory: HISTORY,
    })
    await type('go')
    await type(ENTER)
    await until(() => calls.includes('run:go'), 'run')
    await type(CTRL_R)
    await until(() => frame().includes('reverse-i-search'), 'open')
    await type(ESC)
    await tick(50)
    expect(calls).not.toContain('abort')
  })
})
