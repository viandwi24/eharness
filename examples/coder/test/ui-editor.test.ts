import { describe, expect, test } from 'bun:test'
import {
  backslashNewline,
  backspace,
  bufferOf,
  deleteForward,
  emptyBuffer,
  end,
  home,
  insert,
  move,
  moveLine,
  renderLines,
  splitEnter,
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
