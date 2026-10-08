import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { DiffFile, DiffResult } from '../src/contracts.ts'
import { DiffPage } from '../src/ui/pages/DiffPage.tsx'

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const ENTER = '\r'
const SIZE = { rows: 40, columns: 90 }

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

const PATCH = '@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n tail\n'
const file = (over: Partial<DiffFile>): DiffFile => ({
  path: 'src/a.ts',
  status: 'modified',
  added: 1,
  removed: 1,
  patch: PATCH,
  binary: false,
  editedByAgent: false,
  ...over,
})

function mount(result: DiffResult | (() => Promise<DiffResult>)) {
  let calls = 0
  const controller = {
    diff: () => {
      calls++
      return typeof result === 'function' ? result() : Promise.resolve(result)
    },
  }
  const app = render(<DiffPage controller={controller} onClose={() => {}} size={SIZE} />)
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  return { frame, type, calls: () => calls }
}

const FILES: DiffResult = {
  git: true,
  branch: 'main',
  files: [
    file({ path: 'src/a.ts', editedByAgent: true }),
    file({
      path: 'src/new.ts',
      status: 'untracked',
      added: 4,
      removed: 0,
      patch: '@@ -0,0 +1,1 @@\n+hello\n',
    }),
    file({ path: 'logo.png', binary: true, patch: '', added: 0, removed: 0 }),
  ],
}

describe('DiffPage', () => {
  test('loading, then header and list', async () => {
    const m = mount(() => new Promise((r) => setTimeout(() => r(FILES), 60)))
    expect(m.frame()).toContain('Loading')
    await tick(120)
    const frame = m.frame()
    expect(frame).toContain('Changes main · 3 files · +5 −1')
    expect(frame).toContain('M')
    expect(frame).toContain('src/a.ts')
    expect(frame).toContain('?')
    expect(frame).toContain('+4')
    expect(frame).toContain('⏺')
    console.log(frame)
  })

  test('select a file and show its patch, then go back', async () => {
    const m = mount(FILES)
    await tick()
    await m.type(ENTER)
    expect(m.frame()).toContain('new line')
    expect(m.frame()).toContain('old line')
    await m.type(LEFT)
    expect(m.frame()).not.toContain('new line')
    await m.type(DOWN)
    await m.type(RIGHT)
    expect(m.frame()).toContain('hello')
    expect(m.frame()).not.toContain('old line')
  })

  test('binary file', async () => {
    const m = mount(FILES)
    await tick()
    await m.type(DOWN)
    await m.type(DOWN)
    await m.type(ENTER)
    expect(m.frame()).toContain('Binary file')
  })

  test('a toggles agent-edited only', async () => {
    const m = mount(FILES)
    await tick()
    await m.type('a')
    expect(m.frame()).toContain('1 file ')
    expect(m.frame()).not.toContain('logo.png')
    await m.type('a')
    expect(m.frame()).toContain('logo.png')
  })

  test('r reloads', async () => {
    const m = mount(FILES)
    await tick()
    expect(m.calls()).toBe(1)
    await m.type('r')
    await tick()
    expect(m.calls()).toBe(2)
    expect(m.frame()).toContain('src/a.ts')
  })

  test('not a git repository', async () => {
    const m = mount({ git: false, files: [file({ editedByAgent: true })] })
    await tick()
    expect(m.frame()).toContain(
      'Not a git repository — showing files edited by the agent in this session.',
    )
    expect(m.frame()).toContain('src/a.ts')
  })

  test('empty', async () => {
    const m = mount({ git: true, branch: 'main', files: [] })
    await tick()
    expect(m.frame()).toContain('No changes.')
  })

  test('errors show the message', async () => {
    const m = mount(() => Promise.reject(new Error('git exploded')))
    await tick()
    expect(m.frame()).toContain('git exploded')
  })
})
