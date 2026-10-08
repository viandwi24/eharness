import { describe, expect, test } from 'bun:test'
import {
  backslashNewline,
  backspace,
  bufferOf,
  deleteForward,
  emptyBuffer,
  emptyUndo,
  end,
  home,
  insert,
  killToEnd,
  killToLineStart,
  killWordBack,
  killWordBackSpace,
  killWordForward,
  move,
  moveLine,
  popUndo,
  pushKill,
  pushUndo,
  renderLines,
  splitEnter,
  undoBreak,
  undoJoinInsert,
  wordBack,
  wordBackIndex,
  wordForward,
  yank,
  yankPop,
} from '../src/ui/editor.ts'

describe('editor', () => {
  test('insert at the cursor, also in the middle', () => {
    let b = insert(emptyBuffer, 'helo')
    b = insert(move(b, -1), 'l')
    expect(b).toEqual({ text: 'hello', cursor: 4 })
  })

  test('backspace and delete-forward respect the bounds', () => {
    expect(backspace(emptyBuffer)).toBe(emptyBuffer)
    expect(backspace(bufferOf('ab'))).toEqual({ text: 'a', cursor: 1 })
    expect(deleteForward(bufferOf('ab'))).toEqual({ text: 'ab', cursor: 2 })
    expect(deleteForward({ text: 'ab', cursor: 0 })).toEqual({ text: 'b', cursor: 0 })
  })

  test('move clamps', () => {
    expect(move(bufferOf('ab'), -5).cursor).toBe(0)
    expect(move(bufferOf('ab'), 5).cursor).toBe(2)
  })

  test('home / end operate on the cursor line (Ctrl+A / Ctrl+E)', () => {
    const b = { text: 'one\ntwo\nthree', cursor: 6 }
    expect(home(b).cursor).toBe(4)
    expect(end(b).cursor).toBe(7)
    expect(home({ text: 'abc', cursor: 2 }).cursor).toBe(0)
    expect(end({ text: 'abc', cursor: 1 }).cursor).toBe(3)
    // cursor at the very start of a later line
    expect(home({ text: 'a\nb', cursor: 2 }).cursor).toBe(2)
  })

  test('moveLine keeps the column and clamps to the shorter line', () => {
    const text = 'abcdef\nab\nabcd'
    expect(moveLine({ text, cursor: 5 }, 1).cursor).toBe(9) // end of "ab"
    expect(moveLine({ text, cursor: 9 }, 1).cursor).toBe(12) // col 2 of "abcd"
    expect(moveLine({ text, cursor: 12 }, -1).cursor).toBe(9)
    expect(moveLine({ text, cursor: 2 }, -1).cursor).toBe(2)
    expect(moveLine({ text, cursor: 13 }, 1).cursor).toBe(13)
  })

  test('renderLines marks the cursor line', () => {
    expect(renderLines({ text: 'ab\ncd', cursor: 4 })).toEqual([
      { text: 'ab' },
      { text: 'cd', cursorAt: 1 },
    ])
    expect(renderLines(emptyBuffer)).toEqual([{ text: '', cursorAt: 0 }])
    expect(renderLines({ text: 'ab\ncd', cursor: 2 })[0]).toEqual({ text: 'ab', cursorAt: 2 })
  })
})

describe('splitEnter', () => {
  test('splits at the first line break', () => {
    expect(splitEnter('hi')).toEqual({ before: 'hi', enter: false, rest: '' })
    expect(splitEnter('hi\r')).toEqual({ before: 'hi', enter: true, rest: '' })
    expect(splitEnter('hi\r\n')).toEqual({ before: 'hi', enter: true, rest: '' })
    expect(splitEnter('a\nb\rc')).toEqual({ before: 'a', enter: true, rest: 'b\nc' })
  })
  test('backslashNewline replaces a trailing backslash', () => {
    expect(backslashNewline(bufferOf('a\\'))).toEqual({ text: 'a\n', cursor: 2 })
    expect(backslashNewline(bufferOf('a'))).toBeUndefined()
  })
})

describe('word motions', () => {
  test('Alt+B / Alt+F skip punctuation and stop at word boundaries', () => {
    const text = 'foo, bar_baz  qux'
    expect(wordForward({ text, cursor: 0 }).cursor).toBe(3)
    expect(wordForward({ text, cursor: 3 }).cursor).toBe(12)
    expect(wordForward({ text, cursor: 17 }).cursor).toBe(17)
    expect(wordBack({ text, cursor: 17 }).cursor).toBe(14)
    expect(wordBack({ text, cursor: 14 }).cursor).toBe(5)
    expect(wordBack({ text, cursor: 0 }).cursor).toBe(0)
    expect(wordBackIndex('a.b', 2)).toBe(0)
  })
})

describe('kills', () => {
  test('Ctrl+K kills to the line end, then the line break', () => {
    const k1 = killToEnd({ text: 'ab cd\nef', cursor: 2 })
    expect(k1?.killed).toBe(' cd')
    expect(k1?.buf).toEqual({ text: 'ab\nef', cursor: 2 })
    const k2 = killToEnd(k1?.buf as { text: string; cursor: number })
    expect(k2?.killed).toBe('\n')
    expect(k2?.buf).toEqual({ text: 'abef', cursor: 2 })
    expect(killToEnd({ text: 'ab', cursor: 2 })).toBeUndefined()
  })
  test('Ctrl+U kills to the line start and repeats across lines', () => {
    let buf = { text: 'one\ntwo', cursor: 7 }
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      const k = killToLineStart(buf)
      if (!k) break
      seen.push(k.killed)
      buf = k.buf
    }
    expect(seen).toEqual(['two', '\n', 'one'])
    expect(buf).toEqual({ text: '', cursor: 0 })
  })
  test('Ctrl+W kills back to whitespace; Alt+Backspace kills a word', () => {
    expect(killWordBackSpace({ text: 'run a/b.ts', cursor: 10 })?.buf.text).toBe('run ')
    expect(killWordBack({ text: 'run a/b.ts', cursor: 10 })?.buf.text).toBe('run a/b.')
    expect(killWordBackSpace({ text: 'ab  ', cursor: 4 })?.killed).toBe('ab  ')
    expect(killWordBack(emptyBuffer)).toBeUndefined()
  })
  test('Alt+D kills the next word', () => {
    const k = killWordForward({ text: 'foo bar', cursor: 0 })
    expect(k?.killed).toBe('foo')
    expect(k?.buf).toEqual({ text: ' bar', cursor: 0 })
  })
})

describe('kill ring', () => {
  test('consecutive kills merge (forward appends, backward prepends)', () => {
    expect(pushKill(['a'], 'b', 'forward', true)).toEqual(['ab'])
    expect(pushKill(['a'], 'b', 'back', true)).toEqual(['ba'])
    expect(pushKill(['a'], 'b', 'back', false)).toEqual(['b', 'a'])
    expect(pushKill([], 'x', 'forward', true)).toEqual(['x'])
  })
  test('the ring keeps the newest 10 entries', () => {
    let ring: string[] = []
    for (let i = 0; i < 12; i++) ring = pushKill(ring, String(i), 'forward', false)
    expect(ring).toHaveLength(10)
    expect(ring[0]).toBe('11')
  })
  test('yank inserts the newest; yankPop cycles', () => {
    const ring = ['c', 'b', 'a']
    const y = yank({ text: '>', cursor: 1 }, ring)
    expect(y?.buf).toEqual({ text: '>c', cursor: 2 })
    const p1 = yankPop(y?.buf as { text: string; cursor: number }, ring, y?.span as never)
    expect(p1?.buf).toEqual({ text: '>b', cursor: 2 })
    const p2 = yankPop(p1?.buf as { text: string; cursor: number }, ring, p1?.span as never)
    expect(p2?.buf.text).toBe('>a')
    const p3 = yankPop(p2?.buf as { text: string; cursor: number }, ring, p2?.span as never)
    expect(p3?.buf.text).toBe('>c')
    expect(yank(emptyBuffer, [])).toBeUndefined()
    expect(yankPop(emptyBuffer, ['a'], { start: 0, end: 0, index: 0 })).toBeUndefined()
  })
})

describe('undo stack', () => {
  test('typing bursts coalesce; a pause starts a new step', () => {
    let st = emptyUndo
    st = pushUndo(st, bufferOf(''), 'type', 0)
    st = pushUndo(st, bufferOf('a'), 'type', 100)
    st = pushUndo(st, bufferOf('ab'), 'type', 200)
    expect(st.past).toHaveLength(1)
    st = pushUndo(st, bufferOf('abc'), 'type', 5000)
    expect(st.past).toHaveLength(2)
    const popped = popUndo(st)
    expect(popped?.buf.text).toBe('abc')
    expect(popUndo(popped?.stack as never)?.buf.text).toBe('')
    expect(popUndo(emptyUndo)).toBeUndefined()
  })
  test('other edits never coalesce, identical snapshots are skipped', () => {
    let st = pushUndo(emptyUndo, bufferOf('a'), 'edit', 0)
    st = pushUndo(st, bufferOf('b'), 'edit', 1)
    st = pushUndo(st, bufferOf('b'), 'edit', 2)
    expect(st.past.map((b) => b.text)).toEqual(['a', 'b'])
  })
  test('insert steps join regardless of time; breaks force a new step', () => {
    let st = pushUndo(emptyUndo, bufferOf('x'), 'edit', 0)
    st = undoJoinInsert(st)
    st = pushUndo(st, bufferOf('xa'), 'insert', 99999)
    expect(st.past).toHaveLength(1)
    st = undoBreak(st)
    st = pushUndo(st, bufferOf('xab'), 'insert', 99999)
    expect(st.past).toHaveLength(2)
  })
})
