import { afterEach, describe, expect, test } from 'bun:test'
import type { CoderConfig, CoderMessage } from '../src/contracts.ts'
import { UserMessage } from '../src/ui/MessageView.tsx'
import { Markdown } from '../src/ui/markdown.tsx'
import { PromptInput, type PromptInputProps } from '../src/ui/PromptInput.tsx'
import { initialState, type ViewState } from '../src/ui/state.ts'
import { Transcript } from '../src/ui/Transcript.tsx'
import {
  cellWidth,
  cursorPlace,
  moveVisual,
  stringWidth,
  visualRows,
  wrapRanges,
  wrapRuns,
  wrapWords,
} from '../src/ui/wrap.ts'
import { renderAt } from './term.tsx'

const transcriptConfig = { root: '/tmp/p', model: 'm', mode: 'default' } as unknown as CoderConfig

const ENTER = '\r'
const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

const strip = (s: string): string =>
  s
    .split(`${ESC}[`)
    .map((p, i) => (i === 0 ? p : p.replace(/^[0-9;]*m/, '')))
    .join('')

describe('wrapWords', () => {
  test.each([
    ['ini contoh tulisan kedua', 20, ['ini contoh tulisan', 'kedua']],
    ['ini contoh tulisan kedua', 10, ['ini contoh', 'tulisan', 'kedua']],
    ['short', 20, ['short']],
    ['', 5, ['']],
    ['a\nb', 5, ['a', 'b']],
    ['one\n\ntwo', 5, ['one', '', 'two']],
  ])('%j at %i', (text, width, rows) => {
    expect(wrapWords(text, width)).toEqual(rows)
  })

  test('a word longer than the width is the only thing that is split', () => {
    expect(wrapWords('ab abcdefghij cd', 4)).toEqual(['ab', 'abcd', 'efgh', 'ij', 'cd'])
    expect(wrapWords('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  })

  test('trailing spaces are dropped at a wrap, leading indentation is kept', () => {
    expect(wrapWords('aaa   bbb', 5)).toEqual(['aaa', 'bbb'])
    expect(wrapWords('  ab cd', 5)).toEqual(['  ab', 'cd'])
    expect(wrapWords('ab  ', 10)).toEqual(['ab'])
  })

  test('wide (CJK, emoji) characters count two cells', () => {
    expect(cellWidth('a'.codePointAt(0) as number)).toBe(1)
    expect(cellWidth('字'.codePointAt(0) as number)).toBe(2)
    expect(cellWidth('😀'.codePointAt(0) as number)).toBe(2)
    expect(cellWidth(0x301)).toBe(0)
    expect(stringWidth('日本語')).toBe(6)
    expect(wrapWords('日本語の文章', 6)).toEqual(['日本語', 'の文章'])
    expect(wrapWords('a 😀😀😀 b', 5)).toEqual(['a', '😀😀', '😀 b'])
  })

  test('ranges tile the line exactly', () => {
    const line = 'ini contoh tulisan kedua'
    const ranges = wrapRanges(line, 20)
    expect(ranges.map((r) => line.slice(r.start, r.end)).join('')).toBe(line)
    expect(ranges).toHaveLength(2)
  })
})

describe('wrapRuns', () => {
  test('styled runs wrap as one text; a word split over two runs stays together', () => {
    const rows = wrapRuns(
      [{ text: 'ini contoh ' }, { text: 'tulis', bold: true }, { text: 'an kedua', bold: false }],
      20,
    )
    expect(rows.map((row) => row.map((r) => r.text).join(''))).toEqual([
      'ini contoh tulisan',
      'kedua',
    ])
    expect(rows[0]?.[1]).toEqual({ text: 'tulis', bold: true })
    expect(rows[0]?.[2]).toEqual({ text: 'an', bold: false })
  })
})

describe('visual rows', () => {
  const text = 'ini contoh tulisan kedua'

  test('cursor row and column, soft-wrap boundary belongs to the next row', () => {
    const rows = visualRows(text, 19)
    expect(rows).toHaveLength(2)
    expect(cursorPlace(text, rows, 0)).toEqual({ row: 0, col: 0 })
    expect(cursorPlace(text, rows, 19)).toEqual({ row: 1, col: 0 })
    expect(cursorPlace(text, rows, text.length)).toEqual({ row: 1, col: 5 })
  })

  test('moveVisual keeps the column, clamps, and reports the first / last row', () => {
    const rows = visualRows(text, 19)
    expect(moveVisual(text, rows, 21, -1)).toBe(2)
    expect(moveVisual(text, rows, 2, 1)).toBe(21)
    expect(moveVisual(text, rows, 2, -1)).toBeUndefined()
    expect(moveVisual(text, rows, text.length, 1)).toBeUndefined()
    // column 17 does not exist on "kedua": clamps to its end
    expect(moveVisual(text, rows, 17, 1)).toBe(text.length)
    // going up from the end of the last row lands on the same column of the soft row
    expect(moveVisual(text, rows, text.length, -1)).toBe(5)
  })

  test('hard newlines and empty lines are rows', () => {
    const rows = visualRows('ab\n\ncd', 10)
    expect(rows.map((r) => [r.start, r.end])).toEqual([
      [0, 2],
      [3, 3],
      [4, 6],
    ])
    expect(moveVisual('ab\n\ncd', rows, 5, -1)).toBe(3)
  })
})

describe('rendered at a fixed width', () => {
  function mount(tree: React.ReactElement, columns: number) {
    const app = renderAt(tree, columns)
    cleanup.push(app.unmount)
    return app
  }

  test('a prompt wraps at spaces and never inside a word', async () => {
    const app = mount(<PromptInput history={[]} onSubmit={() => {}} />, 26)
    await tick()
    app.stdin.write('ini contoh tulisan kedua')
    await tick()
    const rows = strip(app.lastFrame()).split('\n')
    expect(rows[1]).toContain('> ini contoh tulisan')
    expect(rows[2]).toContain('  kedua')
    expect(rows[1]).not.toContain('ked')
  })

  test('every cursor position keeps whole words on a row', async () => {
    const words = ['ini', 'contoh', 'tulisan', 'kedua']
    for (const columns of [22, 24, 26]) {
      const app = mount(<PromptInput history={[]} onSubmit={() => {}} />, columns)
      await tick()
      app.stdin.write('ini contoh tulisan kedua')
      await tick()
      for (let back = 0; back <= 24; back += 4) {
        const rows = strip(app.lastFrame())
          .split('\n')
          .slice(1, -1)
          .map((r) =>
            r
              .replace(/^│ [> ] /, '')
              .replace(/\s*│$/, '')
              .trim(),
          )
        for (const row of rows) {
          for (const word of row.split(' ').filter(Boolean)) expect(words).toContain(word)
        }
        for (let i = 0; i < 4; i++) app.stdin.write(LEFT)
        await tick()
      }
      app.unmount()
    }
  })

  test('user message with a hanging indent', async () => {
    const app = mount(<UserMessage text="ini contoh tulisan kedua" />, 22)
    await tick()
    expect(strip(app.lastFrame()).split('\n').filter(Boolean)).toEqual([
      '> ini contoh tulisan',
      '  kedua',
    ])
  })

  test('markdown with bold and code spans wraps as one text', async () => {
    const app = mount(<Markdown text="ini **contoh** tulisan `kedua` lagi dan lagi" />, 20)
    await tick()
    expect(strip(app.lastFrame()).split('\n').filter(Boolean)).toEqual([
      'ini contoh tulisan',
      'kedua lagi dan lagi',
    ])
  })

  test('a long word is hard-broken by the prompt, the rest stays whole', async () => {
    const app = mount(<PromptInput history={[]} onSubmit={() => {}} />, 16)
    await tick()
    app.stdin.write('ab abcdefghijklmnop cd')
    await tick()
    const text = strip(app.lastFrame())
    expect(text).toContain('abcdefghi')
    expect(text).toContain('cd')
  })
})

describe('prompt: visual row navigation, history, menus', () => {
  function mount(props: Partial<PromptInputProps> = {}, columns = 26) {
    const submitted: string[] = []
    const texts: string[] = []
    const app = renderAt(
      <PromptInput
        history={[]}
        onSubmit={(t) => submitted.push(t)}
        onTextChange={(t) => texts.push(t)}
        {...props}
      />,
      columns,
    )
    cleanup.push(app.unmount)
    const frame = (): string => strip(app.lastFrame())
    const type = async (text: string): Promise<void> => {
      app.stdin.write(text)
      await tick()
    }
    return { app, frame, type, submitted, texts }
  }

  test('Up / Down move between wrapped rows before touching history', async () => {
    const { frame, type } = mount({ history: ['older one', 'older two'] })
    await tick()
    await type('ini contoh tulisan kedua')
    // cursor on the second visual row: Up goes to the first row, not to history
    await type(UP)
    expect(frame()).toContain('ini contoh tulisan')
    expect(frame()).not.toContain('older two')
    // now on the first row: Up recalls the newest prompt
    await type(UP)
    expect(frame()).toContain('older two')
  })

  test('history: Up, Up, Down and the draft comes back past the newest entry', async () => {
    const { frame, type, texts } = mount({ history: ['first prompt', 'second prompt'] })
    await tick()
    await type('my draft')
    await type(UP)
    expect(frame()).toContain('second prompt')
    await type(UP)
    expect(frame()).toContain('first prompt')
    await type(DOWN)
    expect(frame()).toContain('second prompt')
    await type(DOWN)
    expect(frame()).toContain('my draft')
    expect(frame()).not.toContain('second prompt')
    // the integrator is told about every recalled text (an empty-prompt flag must not go stale)
    expect(texts).toContain('first prompt')
    expect(texts[texts.length - 1]).toBe('my draft')
  })

  test('a recalled slash command does not open the menu and keeps Up / Down on history', async () => {
    const { frame, type } = mount({ history: ['older prompt', '/help'] })
    await tick()
    await type(UP)
    expect(frame()).toContain('/help')
    expect(frame()).not.toContain('Show')
    await type(UP)
    expect(frame()).toContain('older prompt')
    await type(DOWN)
    expect(frame()).toContain('/help')
  })

  test('two Up presses in one chunk walk two entries (no stale closure)', async () => {
    const { frame, type } = mount({ history: ['one', 'two', 'three'] })
    await tick()
    await type(UP)
    await type(UP + UP)
    expect(frame()).toContain('> one')
  })

  test('Down on the last row at the newest entry asks for the footer', async () => {
    let focus = 0
    const { frame, type } = mount({ onFooterFocus: () => focus++, history: ['old'] })
    await tick()
    await type(DOWN)
    expect(focus).toBe(1)
    await type(UP)
    expect(frame()).toContain('old')
    await type(DOWN) // back to the (empty) draft: still browsing history, not the footer
    expect(focus).toBe(1)
    await type(DOWN)
    expect(focus).toBe(2)
  })

  test('slash menu: Down moves the highlight, Enter runs the highlighted command', async () => {
    const { frame, type, submitted } = mount({}, 80)
    await tick()
    await type('/')
    expect(frame()).toContain('/help')
    await type(DOWN)
    await type(ENTER)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatch(/^\/[\w-]+$/)
    expect(submitted[0]).not.toBe('/help')
  })

  test('slash menu: Enter on a command with a required argument fills it in instead', async () => {
    const { frame, type, submitted } = mount({}, 80)
    await tick()
    await type('/mem')
    await type(ENTER)
    expect(submitted).toEqual(['/memory']) // no required argument: runs
    await type('/renam')
    await type(ENTER)
    expect(submitted).toEqual(['/memory']) // `/rename <name>` needs one: typed into the prompt
    expect(frame()).toContain('> /rename ')
  })

  test('slash menu: Tab accepts into the input, Esc dismisses', async () => {
    const { frame, type, submitted } = mount({}, 80)
    await tick()
    await type('/he')
    await type('\t')
    expect(frame()).toContain('> /help ')
    await type('\x15') // ctrl+u
    await type('/he')
    await type(ESC)
    expect(frame()).not.toContain('Show')
    await type(ENTER)
    expect(submitted).toEqual(['/he'])
  })

  test('@ mention: Enter accepts the mention and does not submit', async () => {
    const listFiles = async (): Promise<string[]> => ['src/ui/a.ts', 'README.md']
    const { frame, type, submitted } = mount({ listFiles }, 80)
    await tick()
    await type('look at @READ')
    await tick(80)
    expect(frame()).toContain('@README.md')
    await type(ENTER)
    expect(submitted).toEqual([])
    expect(frame()).toContain('> look at @README.md')
    await type(ENTER)
    expect(submitted).toEqual(['look at @README.md'])
  })
})

describe('static transcript width', () => {
  // regression: <Static> lays items out without the terminal width, so `⏺ text` wrapped its text at
  // the full width plus the bullet column and the terminal hard-wrapped the overflow mid-word
  test('a finished assistant message never exceeds the terminal width', async () => {
    const text =
      'Saya coder, agen yang bekerja di proyek ini lewat terminal. Saya bisa membaca dan menjelaskan kode, memperbaiki bug, menambah fitur, refactor, menjalankan perintah (test, build, git), dan meninjau perubahan.'
    const message = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text, state: 'done' }],
    } as unknown as CoderMessage
    for (const columns of [120, 142, 143]) {
      const state = {
        ...initialState(),
        entries: [{ kind: 'message', id: 'm:a1', message }],
      } as unknown as ViewState
      const app = renderAt(<Transcript state={state} config={transcriptConfig} />, columns)
      await new Promise((r) => setTimeout(r, 20))
      const widths = app.frames
        .join('\n')
        .split('\n')
        .map((line) => stringWidth(line))
      expect(Math.max(...widths)).toBeLessThanOrEqual(columns)
      app.unmount()
    }
  })
})
