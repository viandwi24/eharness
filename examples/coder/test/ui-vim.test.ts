import { describe, expect, test } from 'bun:test'
import type { Buffer } from '../src/ui/editor.ts'
import { initialVimState, modeLabel, type VimState, vimFeed, visualRange } from '../src/ui/vim.ts'

/** Run keys from NORMAL mode on `text` with the cursor at `cursor` (default 0). */
function run(
  text: string,
  keys: string,
  cursor = 0,
  state: VimState = initialVimState('normal'),
): { text: string; cursor: number; state: VimState; undos: number; submits: number } {
  const r = vimFeed({ text, cursor }, state, keys)
  return {
    text: r.buf.text,
    cursor: r.buf.cursor,
    state: r.state,
    undos: r.undos,
    submits: r.submits,
  }
}
const ESC = '\x1b'

describe('modes', () => {
  test('labels and the initial mode', () => {
    expect(initialVimState().mode).toBe('insert')
    expect(modeLabel('insert')).toBe('-- INSERT --')
    expect(modeLabel('visual-line')).toBe('-- VISUAL LINE --')
  })
  test('Esc leaves INSERT, moving the cursor left; i / a / I / A / o / O enter it', () => {
    const r = vimFeed({ text: '', cursor: 0 }, initialVimState('insert'), `hello${ESC}`)
    expect(r.buf).toEqual({ text: 'hello', cursor: 4 })
    expect(r.state.mode).toBe('normal')
    expect(run('abc', 'i', 1).state.mode).toBe('insert')
    expect(run('abc', `aX${ESC}`, 0).text).toBe('aXbc')
    expect(run('  abc', `IX${ESC}`, 4).text).toBe('  Xabc')
    expect(run('abc', `AX${ESC}`).text).toBe('abcX')
    expect(run('a\nb', `ox${ESC}`).text).toBe('a\nx\nb')
    expect(run('a\nb', `Ox${ESC}`, 2).text).toBe('a\nx\nb')
  })
  test('insert Backspace deletes; Esc at column 0 keeps the cursor', () => {
    const r = vimFeed({ text: 'ab', cursor: 2 }, initialVimState('insert'), '\b')
    expect(r.buf.text).toBe('a')
    expect(vimFeed({ text: 'ab', cursor: 0 }, initialVimState('insert'), ESC).buf.cursor).toBe(0)
  })
  test('Enter in NORMAL submits; pending state swallows it', () => {
    expect(run('x', '\r').submits).toBe(1)
    expect(run('x', 'd\r').submits).toBe(0)
  })
})

describe('motions', () => {
  test('h l clamp to the line and the NORMAL cursor never rests past the end', () => {
    expect(run('abc', 'l', 0).cursor).toBe(1)
    expect(run('abc', 'lll', 0).cursor).toBe(2)
    expect(run('abc', 'hh', 1).cursor).toBe(0)
    expect(run('ab\ncd', 'l', 1).cursor).toBe(1)
  })
  test('j k keep the column', () => {
    expect(run('abcd\nab\nabcd', 'j', 3).cursor).toBe(6)
    expect(run('abcd\nab\nabcd', 'jj', 3).cursor).toBe(11)
    expect(run('abcd\nab\nabcd', 'jx', 3).cursor).toBe(5)
    expect(run('abcd\nab', 'k', 6).cursor).toBe(1)
    expect(run('abc', 'j', 1).cursor).toBe(1)
  })
  test('w e b', () => {
    const t = 'foo bar.baz  qux'
    expect(run(t, 'w').cursor).toBe(4)
    expect(run(t, 'ww').cursor).toBe(7)
    expect(run(t, 'www').cursor).toBe(8)
    expect(run(t, '3w').cursor).toBe(8)
    expect(run(t, 'e').cursor).toBe(2)
    expect(run(t, 'ee').cursor).toBe(6)
    expect(run(t, 'b', 8).cursor).toBe(7)
    expect(run(t, 'bb', 8).cursor).toBe(4)
    expect(run(t, 'b', 0).cursor).toBe(0)
    expect(run(t, 'w', 14).cursor).toBe(15)
  })
  test('0 ^ $ and gg G', () => {
    expect(run('  ab cd', '0', 5).cursor).toBe(0)
    expect(run('  ab cd', '^', 5).cursor).toBe(2)
    expect(run('ab cd', '$').cursor).toBe(4)
    const t = 'one\n  two\nthree'
    expect(run(t, 'G').cursor).toBe(10)
    expect(run(t, 'gg', 12).cursor).toBe(0)
    expect(run(t, '2G').cursor).toBe(6)
    expect(run(t, 'g', 0).state.pending).toBe('g')
  })
  test('f F t T ; ,', () => {
    expect(run('a,b,c', 'f,').cursor).toBe(1)
    expect(run('a,b,c', 'f,;').cursor).toBe(3)
    expect(run('a,b,c', '2f,').cursor).toBe(3)
    expect(run('a,b,c', 'f,;,').cursor).toBe(1)
    expect(run('a,b,c', 'F,', 4).cursor).toBe(3)
    expect(run('a,b,c', 't,').cursor).toBe(0)
    expect(run('a,b,c', 'tb').cursor).toBe(1)
    expect(run('a,b,c', 'T,', 4).cursor).toBe(4)
    expect(run('a,b,c', 'fz').cursor).toBe(0)
  })
})

describe('delete / change / yank', () => {
  test('x X and counts', () => {
    expect(run('abc', 'x').text).toBe('bc')
    expect(run('abcd', '2x').text).toBe('cd')
    expect(run('abc', 'x', 2).cursor).toBe(1)
    expect(run('abcd', 'X', 2).text).toBe('acd')
    expect(run('', 'x').text).toBe('')
  })
  test('dd removes lines and fills the register', () => {
    expect(run('a\nb\nc', 'dd', 4).text).toBe('a\nb')
    expect(run('a\nb\nc', 'dd', 4).cursor).toBe(2)
    expect(run('a\nb\nc', 'dd').text).toBe('b\nc')
    expect(run('a\nb\nc', '2dd').text).toBe('c')
    expect(run('a\nb\nc', 'd2d').text).toBe('c')
    expect(run('a', 'dd').text).toBe('')
    expect(run('a\nb', 'dd').state.register).toEqual({ text: 'a', linewise: true })
  })
  test('dw d$ D and dj', () => {
    expect(run('foo bar', 'dw').text).toBe('bar')
    expect(run('foo bar', 'wdw').text).toBe('foo ')
    expect(run('foo\nbar', 'dw').text).toBe('\nbar')
    expect(run('foo bar baz', 'd2w').text).toBe('baz')
    expect(run('foo bar', 'd$', 3).text).toBe('foo')
    expect(run('foo bar', 'D', 3).text).toBe('foo')
    expect(run('a\nb\nc', 'dj').text).toBe('c')
    expect(run('a\nb\nc', 'dG').text).toBe('')
    expect(run('a b c', 'df ').text).toBe('b c')
    expect(run('a b c', 'dt ').text).toBe(' b c')
    expect(run('abc def', 'db', 4).text).toBe('def')
    expect(run('abc def', 'de').text).toBe(' def')
  })
  test('cw cc C s S', () => {
    const r = run('foo bar', `cwX${ESC}`)
    expect(r.text).toBe('X bar')
    expect(r.state.mode).toBe('normal')
    expect(run('foo bar', 'cw').state.mode).toBe('insert')
    expect(run('a\nold\nc', `ccnew${ESC}`, 3).text).toBe('a\nnew\nc')
    expect(run('foo bar', `C!${ESC}`, 3).text).toBe('foo!')
    expect(run('abc', `sX${ESC}`).text).toBe('Xbc')
    expect(run('abc\ndef', `SX${ESC}`).text).toBe('X\ndef')
    expect(run('a b', `cwX${ESC}`, 1).text).toBe('aXb')
  })
  test('yy yw p P', () => {
    expect(run('a\nb', 'yyp').text).toBe('a\na\nb')
    expect(run('a\nb', 'yyP').text).toBe('a\na\nb')
    expect(run('a\nb', 'jyyP').text).toBe('a\nb\nb')
    expect(run('a\nb', 'yyjp').text).toBe('a\nb\na')
    expect(run('a\nb', '2yyp').text).toBe('a\na\nb\nb')
    expect(run('a\nb', 'yy').text).toBe('a\nb')
    expect(run('foo bar', 'ywP', 4).text).toBe('foo barbar')
    expect(run('abc', 'xp').text).toBe('bac')
    expect(run('abc', 'xP').text).toBe('abc')
    expect(run('abc', 'x2p').text).toBe('baac')
    expect(run('abc', 'p').text).toBe('abc')
  })
  test('yw keeps the cursor at the start; yb moves it', () => {
    expect(run('foo bar', 'yw', 0).cursor).toBe(0)
    expect(run('foo bar', 'yb', 4).cursor).toBe(0)
  })
  test('text objects iw aw', () => {
    expect(run('foo bar baz', 'diw', 5).text).toBe('foo  baz')
    expect(run('foo bar baz', 'daw', 5).text).toBe('foo baz')
    expect(run('foo bar baz', 'daw', 9).text).toBe('foo bar')
    expect(run('foo bar', `ciwX${ESC}`).text).toBe('X bar')
  })
})

describe('other commands', () => {
  test('r replaces and counts; fails past the line end', () => {
    expect(run('abc', 'rx').text).toBe('xbc')
    expect(run('abc', '2rx').text).toBe('xxc')
    expect(run('abc', '5rx').text).toBe('abc')
    expect(run('abc', '2rx').cursor).toBe(1)
  })
  test('J joins and ~ toggles', () => {
    expect(run('a\n  b', 'J').text).toBe('a b')
    expect(run('a', 'J').text).toBe('a')
    expect(run('aBc', '~~').text).toBe('Abc')
    expect(run('abc', '5~').text).toBe('ABC')
  })
  test('u reports an undo request', () => {
    expect(run('abc', 'xu').undos).toBe(1)
  })
  test('counts: 0 continues a count, a lone 0 is a motion', () => {
    expect(run('abcdefghijkl', '10l').cursor).toBe(10)
    expect(run('abc', '0', 2).cursor).toBe(0)
  })
  test('unknown keys cancel pending state and never insert text', () => {
    const r = run('abc', 'z')
    expect(r.text).toBe('abc')
    expect(run('abc', 'd', 0).state.op).toBe('d')
    expect(run('abc', `d${ESC}`, 0).state.op).toBeUndefined()
    expect(run('abc', 'dz').state.op).toBeUndefined()
    expect(run('abc', 'Q').text).toBe('abc')
  })
  test('multi-character chunks are processed key by key', () => {
    const r = vimFeed({ text: 'abc', cursor: 0 }, initialVimState('normal'), '')
    expect(r.buf.text).toBe('abc')
  })
})

describe('dot repeat', () => {
  test('repeats x, dw, dd and counted deletes', () => {
    expect(run('abcd', 'x.').text).toBe('cd')
    expect(run('a b c d', 'dw.').text).toBe('c d')
    expect(run('1\n2\n3\n4', 'dd.').text).toBe('3\n4')
    expect(run('abcdef', '2x.').text).toBe('ef')
    expect(run('abc', '.').text).toBe('abc')
  })
  test('repeats a change with its inserted text', () => {
    const r = run('foo bar baz', `cwX${ESC}w.`)
    expect(r.text).toBe('X X baz')
    expect(run('a b', `A!${ESC}.`).text).toBe('a b!!')
    expect(run('a\nb', `ox${ESC}.`).text).toBe('a\nx\nx\nb')
  })
  test('motions and yanks do not replace the last change', () => {
    expect(run('abcd', 'xlyy.').text).toBe('bd')
  })
  test('repeats p', () => {
    expect(run('abc', 'xp.').text).toBe('baac')
  })
})

describe('VISUAL', () => {
  test('v extends with motions; d / y / c act on the inclusive range', () => {
    expect(run('abcdef', 'vlld').text).toBe('def')
    expect(run('abcdef', 'vlly$p').text).toBe('abcdefabc')
    expect(run('abcdef', `vlcX${ESC}`).text).toBe('Xcdef')
    expect(run('abcdef', 'vx').text).toBe('bcdef')
    expect(run('abcdef', 'vlly').state.mode).toBe('normal')
  })
  test('V works on whole lines', () => {
    expect(run('a\nb\nc', 'Vjd').text).toBe('c')
    expect(run('a\nb\nc', 'jVy').state.register).toEqual({ text: 'b', linewise: true })
    expect(run('a\nb\nc', `VcX${ESC}`).text).toBe('X\nb\nc')
  })
  test('v and Esc leave VISUAL; o swaps the ends; visualRange', () => {
    expect(run('abc', 'vv').state.mode).toBe('normal')
    expect(run('abc', `v${ESC}`).state.mode).toBe('normal')
    expect(run('abc', 'V').state.mode).toBe('visual-line')
    const r = vimFeed({ text: 'abcdef', cursor: 1 }, initialVimState('normal'), 'vll')
    expect(visualRange(r.buf as Buffer, r.state)).toEqual({ start: 1, end: 4 })
    const swapped = vimFeed(r.buf, r.state, 'o')
    expect(swapped.buf.cursor).toBe(1)
    const lines = vimFeed({ text: 'ab\ncd\nef', cursor: 3 }, initialVimState('normal'), 'Vj')
    expect(visualRange(lines.buf, lines.state)).toEqual({ start: 3, end: 8 })
    expect(visualRange({ text: 'a', cursor: 0 }, initialVimState('normal'))).toBeUndefined()
  })
  test('Enter does not submit in VISUAL', () => {
    expect(run('abc', 'v\r').submits).toBe(0)
  })
})
