import { afterEach, describe, expect, test } from 'bun:test'
import type { FileUIPart } from 'ai'
import { render } from 'ink-testing-library'
import { type ClipboardImage, macScript, readClipboardImage } from '../src/ui/clipboard.ts'
import { bufferOf } from '../src/ui/editor.ts'
import {
  editInExternalEditor,
  resolveEditor,
  type SpawnEditor,
  splitCommand,
} from '../src/ui/external-editor.ts'
import { PromptInput, type PromptInputProps } from '../src/ui/PromptInput.tsx'
import {
  backspaceChip,
  deleteChip,
  expandPastes,
  findChips,
  imagesInOrder,
  insertPaste,
  moveChip,
  PasteStore,
  shouldChip,
} from '../src/ui/paste.ts'
import type { VimMode } from '../src/ui/vim.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g
const plain = (frame: string | undefined): string => (frame ?? '').replace(ANSI, '')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

const ESC = '\x1b'
const CTRL = (c: string): string => String.fromCharCode(c.charCodeAt(0) - 96)

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('paste chips', () => {
  test('thresholds: over 800 chars or over 10 lines', () => {
    expect(shouldChip('x'.repeat(800))).toBe(false)
    expect(shouldChip('x'.repeat(801))).toBe(true)
    expect(shouldChip(Array.from({ length: 10 }, () => 'a').join('\n'))).toBe(false)
    expect(shouldChip(Array.from({ length: 11 }, () => 'a').join('\n'))).toBe(true)
  })
  test('insertPaste adds a chip, expandPastes restores the content', () => {
    const store = new PasteStore()
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const buf = insertPaste(bufferOf('see '), big, store)
    expect(buf.text).toBe('see [Pasted text #1 +12 lines]')
    expect(expandPastes(buf.text, store)).toBe(`see ${big}`)
    expect(insertPaste(bufferOf(''), 'small', store).text).toBe('small')
  })
  test('lookalike chips that are not in the store stay plain text', () => {
    const store = new PasteStore()
    expect(findChips('[Pasted text #7 +20 lines]', store)).toEqual([])
    expect(expandPastes('[Pasted text #7 +20 lines]', store)).toBe('[Pasted text #7 +20 lines]')
  })
  test('chips are atomic for backspace, delete and arrows', () => {
    const store = new PasteStore()
    const chip = store.addText('a\n'.repeat(20))
    const text = `x ${chip} y`
    const end = 2 + chip.length
    expect(backspaceChip({ text, cursor: end }, store)).toEqual({ text: 'x  y', cursor: 2 })
    expect(backspaceChip({ text, cursor: end - 3 }, store)?.text).toBe('x  y')
    expect(backspaceChip({ text, cursor: 1 }, store)).toBeUndefined()
    expect(deleteChip({ text, cursor: 2 }, store)?.text).toBe('x  y')
    expect(deleteChip({ text, cursor: end }, store)).toBeUndefined()
    expect(moveChip({ text, cursor: end }, -1, store)?.cursor).toBe(2)
    expect(moveChip({ text, cursor: 2 }, 1, store)?.cursor).toBe(end)
    expect(moveChip({ text, cursor: 0 }, 1, store)).toBeUndefined()
  })
  test('images come out in chip order, not insertion order', () => {
    const store = new PasteStore()
    const f = (n: string): FileUIPart => ({ type: 'file', mediaType: 'image/png', url: n })
    const c1 = store.addImage(f('one'))
    const c2 = store.addImage(f('two'))
    expect(imagesInOrder(`${c2} ${c1}`, store).map((x) => x.url)).toEqual(['two', 'one'])
    expect(imagesInOrder(c1, store)).toHaveLength(1)
    store.clear()
    expect(imagesInOrder(c1, store)).toEqual([])
  })
})

describe('readClipboardImage', () => {
  const temp = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => ({
    path: '/tmp/clip.png',
    cleanup: async () => {},
  })
  test('macOS: osascript writes the PNG to a temp file which is read back', async () => {
    const calls: Array<[string, string[]]> = []
    const res = await readClipboardImage({
      platform: 'darwin',
      tempFile: temp,
      now: () => 7,
      run: async (cmd, args) => {
        calls.push([cmd, args])
        return { code: 0, stdout: new TextEncoder().encode('ok\n') }
      },
      readFile: async (p) => {
        expect(p).toBe('/tmp/clip.png')
        return PNG
      },
    })
    expect(res.ok && res.file.mediaType).toBe('image/png')
    expect(res.ok && res.file.url.startsWith('data:image/png;base64,iVBORw0K')).toBe(true)
    expect(res.ok && res.file.filename).toBe('clipboard-7.png')
    expect(calls[0]?.[0]).toBe('osascript')
    expect(calls[0]?.[1].join(' ')).toContain('«class PNGf»')
    expect(macScript('/a"b').join('\n')).toContain('/a\\"b')
  })
  test('macOS: no image in the clipboard', async () => {
    const res = await readClipboardImage({
      platform: 'darwin',
      tempFile: temp,
      run: async () => ({ code: 0, stdout: new TextEncoder().encode('none') }),
    })
    expect(res).toEqual({ ok: false, reason: 'none' })
  })
  test('Linux: wl-paste first, then xclip; non-PNG output counts as no image', async () => {
    const seen: string[] = []
    const res = await readClipboardImage({
      platform: 'linux',
      run: async (cmd) => {
        seen.push(cmd)
        return cmd === 'wl-paste' ? { code: 1, stdout: new Uint8Array() } : { code: 0, stdout: PNG }
      },
    })
    expect(res.ok).toBe(true)
    expect(seen).toEqual(['wl-paste', 'xclip'])
    const text = await readClipboardImage({
      platform: 'linux',
      run: async () => ({ code: 0, stdout: new TextEncoder().encode('just text, not a png') }),
    })
    expect(text).toEqual({ ok: false, reason: 'none' })
  })
  test('size cap, unsupported platforms and thrown errors', async () => {
    const big = new Uint8Array(20)
    big.set(PNG)
    expect(
      await readClipboardImage({
        platform: 'linux',
        maxBytes: 10,
        run: async () => ({ code: 0, stdout: big }),
      }),
    ).toEqual({ ok: false, reason: 'too-large' })
    expect(await readClipboardImage({ platform: 'win32' })).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    expect(
      await readClipboardImage({
        platform: 'darwin',
        tempFile: async () => {
          throw new Error('boom')
        },
      }),
    ).toEqual({ ok: false, reason: 'error' })
  })
})

describe('external editor', () => {
  test('resolves $VISUAL, then $EDITOR, then vi; quotes are respected', () => {
    expect(resolveEditor({ VISUAL: 'code -w', EDITOR: 'nano' })).toEqual(['code', '-w'])
    expect(resolveEditor({ EDITOR: 'nano' })).toEqual(['nano'])
    expect(resolveEditor({ VISUAL: ' ' })).toEqual(['vi'])
    expect(splitCommand('"my editor" --flag \'a b\'')).toEqual(['my editor', '--flag', 'a b'])
  })
  test('writes the draft, runs the editor through suspend, reads the result back', async () => {
    const order: string[] = []
    let editedFile = ''
    const spawn: SpawnEditor = async (cmd, args) => {
      order.push(`spawn ${cmd}`)
      editedFile = args[args.length - 1] ?? ''
      const fs = await import('node:fs/promises')
      expect(await fs.readFile(editedFile, 'utf8')).toBe('draft')
      await fs.writeFile(editedFile, 'edited text\n')
      return 0
    }
    const res = await editInExternalEditor('draft', {
      env: { EDITOR: 'ed -x' },
      spawn,
      suspend: async (run) => {
        order.push('suspend')
        await run()
        order.push('resume')
      },
    })
    expect(res).toEqual({ ok: true, text: 'edited text' })
    expect(order).toEqual(['suspend', 'spawn ed', 'resume'])
    const fs = await import('node:fs/promises')
    expect(await fs.stat(editedFile).catch(() => null)).toBeNull()
  })
  test('a failing editor or a spawn error is reported, never thrown', async () => {
    expect(await editInExternalEditor('x', { env: {}, spawn: async () => 2 })).toEqual({
      ok: false,
      error: 'Editor exited with code 2',
    })
    const err = await editInExternalEditor('x', {
      env: {},
      spawn: async () => {
        throw new Error('spawn vi ENOENT')
      },
    })
    expect(err).toEqual({ ok: false, error: 'spawn vi ENOENT' })
  })
})

// ---------------------------------------------------------------------------------------------

type Harness = ReturnType<typeof render> & {
  text(): string
  sent: string[]
  detailed: Array<{ text: string; files: FileUIPart[] }>
  hints: string[]
  press(keys: string, wait?: number): Promise<void>
}

function mount(over: Partial<PromptInputProps> = {}): Harness {
  const sent: string[] = []
  const detailed: Array<{ text: string; files: FileUIPart[] }> = []
  const hints: string[] = []
  const app = render(
    <PromptInput
      history={[]}
      onSubmit={(t) => sent.push(t)}
      onHint={(h) => hints.push(h)}
      {...over}
    />,
  )
  cleanup.push(() => app.unmount())
  return Object.assign(app, {
    text: () => plain(app.lastFrame()),
    sent,
    detailed,
    hints,
    press: async (keys: string, wait = 30) => {
      app.stdin.write(keys)
      await tick(wait)
    },
  })
}

describe('PromptInput: kill ring, undo, words', () => {
  test('Ctrl+K kills to the end, Ctrl+Y yanks it back', async () => {
    const h = mount()
    await h.press('hello world')
    await h.press('\x1b[D'.repeat(6))
    await h.press(CTRL('k'))
    expect(h.text()).toContain('> hello')
    expect(h.text()).not.toContain('world')
    await h.press(CTRL('y'))
    expect(h.text()).toContain('hello world')
  })
  test('Ctrl+U then Ctrl+W then Alt+Backspace', async () => {
    const h = mount()
    await h.press('one two three')
    await h.press(`${ESC}\x7f`)
    expect(h.text()).toContain('one two ')
    expect(h.text()).not.toContain('three')
    await h.press(CTRL('w'))
    expect(h.text()).not.toContain('two')
    await h.press(CTRL('u'))
    expect(h.text()).not.toContain('one')
  })
  test('Alt+Y cycles the kill ring after a yank', async () => {
    const h = mount()
    await h.press('aaa')
    await h.press(CTRL('u'))
    await h.press('bbb')
    await h.press(CTRL('u'))
    await h.press(CTRL('y'))
    expect(h.text()).toContain('bbb')
    await h.press(`${ESC}y`)
    expect(h.text()).toContain('aaa')
    expect(h.text()).not.toContain('bbb')
  })
  test('Alt+B / Alt+F / Alt+D move and delete by word', async () => {
    const h = mount()
    await h.press('foo bar baz')
    await h.press(`${ESC}b${ESC}b`)
    await h.press(`${ESC}d`)
    expect(h.text()).toContain('foo  baz')
    await h.press(`${ESC}f`)
    await h.press('!')
    expect(h.text()).toContain('foo  baz!')
  })
  test('macOS Option characters work as Alt', async () => {
    const h = mount()
    await h.press('foo bar')
    await h.press('∫')
    await h.press('X')
    expect(h.text()).toContain('foo Xbar')
  })
  test('Ctrl+_ undoes; a typing burst is one step', async () => {
    const h = mount()
    await h.press('abc')
    await h.press(' def')
    await h.press('\x1f')
    expect(h.text()).not.toContain('abc')
    expect(h.text()).toContain('Try "explain')
  })
  test('Ctrl+D deletes forward with text and fires onCtrlDEmpty when empty', async () => {
    let empty = 0
    const h = mount({ onCtrlDEmpty: () => empty++ })
    await h.press(CTRL('d'))
    expect(empty).toBe(1)
    await h.press('abc')
    await h.press('\x1b[D\x1b[D')
    await h.press(CTRL('d'))
    expect(h.text()).toContain('> ac')
    expect(empty).toBe(1)
  })
})

describe('PromptInput: stash', () => {
  test('Ctrl+S stashes a draft, Ctrl+S on an empty prompt restores it', async () => {
    const h = mount()
    await h.press('my draft')
    await h.press(CTRL('s'))
    expect(h.text()).not.toContain('my draft')
    expect(h.hints).toEqual(['stashed'])
    await h.press('other')
    await h.press('\r')
    expect(h.sent).toEqual(['other'])
    await h.press(CTRL('s'))
    expect(h.text()).toContain('my draft')
    expect(h.hints[1]).toBe('stash restored')
  })
})

describe('PromptInput: paste chips', () => {
  test('a large bracketed paste becomes a chip and submits expanded', async () => {
    const h = mount()
    const big = Array.from({ length: 15 }, (_, i) => `row ${i}`).join('\n')
    await h.press(`\x1b[200~${big}\x1b[201~`, 60)
    expect(h.text()).toContain('[Pasted text #1 +15 lines]')
    expect(h.text()).not.toContain('row 3')
    await h.press('\r')
    expect(h.sent).toEqual([big])
  })
  test('backspace removes the whole chip', async () => {
    const h = mount()
    await h.press(`\x1b[200~${'z'.repeat(900)}\x1b[201~`, 60)
    expect(h.text()).toContain('[Pasted text #1')
    await h.press('\x7f')
    expect(h.text()).not.toContain('Pasted')
    expect(h.text()).toContain('Try "explain')
  })
  test('onSubmitDetailed replaces onSubmit and carries the expanded text', async () => {
    const got: Array<{ text: string; files: FileUIPart[] }> = []
    const h = mount({ onSubmitDetailed: (s) => got.push(s) })
    await h.press(`\x1b[200~${'q'.repeat(900)}\x1b[201~`, 60)
    await h.press('\r')
    expect(got).toEqual([{ text: 'q'.repeat(900), files: [] }])
    expect(h.sent).toEqual([])
  })
})

describe('PromptInput: image paste', () => {
  const image = (): Promise<ClipboardImage> =>
    Promise.resolve({
      ok: true,
      file: {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,AAAA',
        filename: 'a.png',
      },
    })
  test('Ctrl+V inserts an image chip; the file is submitted in chip order', async () => {
    const got: Array<{ text: string; files: FileUIPart[] }> = []
    const h = mount({ readImage: image, onSubmitDetailed: (s) => got.push(s) })
    await h.press('look ')
    await h.press(CTRL('v'), 60)
    expect(h.text()).toContain('[Image #1]')
    await h.press('\r')
    expect(got).toHaveLength(1)
    expect(got[0]?.text).toBe('look [Image #1]')
    expect(got[0]?.files.map((f) => f.filename)).toEqual(['a.png'])
  })
  test('Alt+V works too; no image gives a hint', async () => {
    const h = mount({ readImage: async () => ({ ok: false, reason: 'none' }) })
    await h.press(`${ESC}v`, 60)
    expect(h.hints).toEqual(['No image in the clipboard'])
    const h2 = mount({ readImage: image })
    await h2.press(`${ESC}v`, 60)
    expect(h2.text()).toContain('[Image #1]')
  })
  test('a rejected read never throws into Ink', async () => {
    const h = mount({
      readImage: () => Promise.reject(new Error('x')),
    })
    await h.press(CTRL('v'), 60)
    expect(h.hints).toEqual(['Could not read the clipboard'])
  })
})

describe('PromptInput: external editor', () => {
  test('Ctrl+G replaces the draft and toggles onExternalEditor', async () => {
    const states: boolean[] = []
    const seen: string[] = []
    const h = mount({
      onExternalEditor: (r) => states.push(r),
      externalEditor: async (t) => {
        seen.push(t)
        return { ok: true, text: 'from editor' }
      },
    })
    await h.press('draft')
    await h.press(CTRL('g'), 60)
    expect(seen).toEqual(['draft'])
    expect(states).toEqual([true, false])
    expect(h.text()).toContain('from editor')
  })
  test('a failure leaves the draft and shows a hint', async () => {
    const h = mount({ externalEditor: async () => ({ ok: false, error: 'no editor' }) })
    await h.press('keep')
    await h.press(CTRL('g'), 60)
    expect(h.text()).toContain('keep')
    expect(h.hints).toEqual(['no editor'])
  })
})

describe('PromptInput: double Esc', () => {
  test('with text: saves the draft and clears it', async () => {
    const saved: string[] = []
    const h = mount({ onSaveDraft: (t) => saved.push(t) })
    await h.press('draft')
    await h.press(ESC, 20)
    expect(saved).toEqual([])
    expect(h.text()).toContain('draft')
    await h.press(ESC, 60)
    expect(saved).toEqual(['draft'])
    expect(h.text()).not.toContain('draft')
  })
  test('empty prompt: opens the rewind menu', async () => {
    let rewind = 0
    const h = mount({ onRewindMenu: () => rewind++ })
    await h.press(ESC, 20)
    expect(rewind).toBe(0)
    await h.press(ESC, 60)
    expect(rewind).toBe(1)
  })
  test('presses further apart than 500 ms do not count', async () => {
    let rewind = 0
    const h = mount({ onRewindMenu: () => rewind++ })
    await h.press(ESC, 560)
    await h.press(ESC, 30)
    expect(rewind).toBe(0)
  })
})

describe('PromptInput: vim mode', () => {
  test('Esc to NORMAL, edit, i to insert, Enter submits from NORMAL', async () => {
    const modes: VimMode[] = []
    const h = mount({ editorMode: 'vim', onVimMode: (m) => modes.push(m) })
    await h.press('hello world')
    await h.press(ESC, 60)
    await h.press('0')
    await h.press('dw')
    expect(h.text()).toContain('> world')
    await h.press('x')
    expect(h.text()).toContain('> orld')
    await h.press('A!')
    expect(h.text()).toContain('orld!')
    await h.press(ESC, 60)
    await h.press('\r')
    expect(h.sent).toEqual(['orld!'])
    expect(modes[0]).toBe('insert')
    expect(modes).toContain('normal')
  })
  test('NORMAL keys never insert text; u undoes; Esc does not double-clear', async () => {
    const saved: string[] = []
    const h = mount({ editorMode: 'vim', onSaveDraft: (t) => saved.push(t) })
    await h.press('abc')
    await h.press(ESC, 60)
    await h.press(ESC, 60)
    expect(saved).toEqual([])
    await h.press('zq')
    expect(h.text()).toContain('> abc')
    await h.press('x')
    expect(h.text()).toContain('> ab')
    await h.press('u', 60)
    expect(h.text()).toContain('> abc')
  })
  test('VISUAL mode reports itself and deletes the selection', async () => {
    const modes: VimMode[] = []
    const h = mount({ editorMode: 'vim', onVimMode: (m) => modes.push(m) })
    await h.press('abcdef')
    await h.press(ESC, 60)
    await h.press('0')
    await h.press('v')
    await h.press('l')
    expect(modes).toContain('visual')
    await h.press('d')
    expect(h.text()).toContain('> cdef')
  })
})

describe('PromptInput: @ folders and agents', () => {
  const listFiles = async (): Promise<string[]> => ['src/ui/a.ts', 'src/b.ts', 'README.md']
  test('suggests folders with a kind label; Tab completes without a space', async () => {
    const h = mount({ listFiles })
    await h.press('see @src/ui', 80)
    const out = h.text()
    expect(out).toContain('@src/ui/')
    expect(out).toContain('folder')
    expect(out).toContain('@src/ui/a.ts')
    await h.press('\t')
    expect(h.text()).toContain('> see @src/ui/')
    await h.press('b')
    expect(h.text()).toContain('@src/ui/b')
  })
  test('suggests agents as @agent-<name>', async () => {
    const h = mount({ listFiles, agents: ['reviewer', 'tester'] })
    await h.press('@agent-rev', 80)
    expect(h.text()).toContain('@agent-reviewer')
    expect(h.text()).toContain('agent')
    await h.press('\t')
    expect(h.text()).toContain('> @agent-reviewer')
    await h.press('\r')
    expect(h.sent).toEqual(['@agent-reviewer'])
  })
})
