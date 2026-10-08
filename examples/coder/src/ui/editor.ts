/** Pure text buffer operations of the prompt input (cursor = index into `text`). */

/** A text buffer with a cursor. */
export interface Buffer {
  text: string
  cursor: number
}

/** An empty buffer. */
export const emptyBuffer: Buffer = { text: '', cursor: 0 }

/** Insert text at the cursor. */
export function insert(buf: Buffer, input: string): Buffer {
  return {
    text: buf.text.slice(0, buf.cursor) + input + buf.text.slice(buf.cursor),
    cursor: buf.cursor + input.length,
  }
}

/** Delete the character before the cursor. */
export function backspace(buf: Buffer): Buffer {
  if (buf.cursor === 0) return buf
  return {
    text: buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor),
    cursor: buf.cursor - 1,
  }
}

/** Delete the character under the cursor. */
export function deleteForward(buf: Buffer): Buffer {
  if (buf.cursor >= buf.text.length) return buf
  return {
    text: buf.text.slice(0, buf.cursor) + buf.text.slice(buf.cursor + 1),
    cursor: buf.cursor,
  }
}

/** Move the cursor by `delta` characters. */
export function move(buf: Buffer, delta: number): Buffer {
  return { ...buf, cursor: Math.max(0, Math.min(buf.text.length, buf.cursor + delta)) }
}

/** Start of the cursor's line. */
export function home(buf: Buffer): Buffer {
  return { ...buf, cursor: buf.text.lastIndexOf('\n', buf.cursor - 1) + 1 }
}

/** End of the cursor's line. */
export function end(buf: Buffer): Buffer {
  const next = buf.text.indexOf('\n', buf.cursor)
  return { ...buf, cursor: next === -1 ? buf.text.length : next }
}

/** Move the cursor one line up or down, keeping the column when possible. */
export function moveLine(buf: Buffer, dir: -1 | 1): Buffer {
  const start = buf.text.lastIndexOf('\n', buf.cursor - 1) + 1
  const column = buf.cursor - start
  if (dir === -1) {
    if (start === 0) return buf
    const prevStart = buf.text.lastIndexOf('\n', start - 2) + 1
    return { ...buf, cursor: Math.min(prevStart + column, start - 1) }
  }
  const nextBreak = buf.text.indexOf('\n', buf.cursor)
  if (nextBreak === -1) return buf
  const nextEnd = buf.text.indexOf('\n', nextBreak + 1)
  const lineEnd = nextEnd === -1 ? buf.text.length : nextEnd
  return { ...buf, cursor: Math.min(nextBreak + 1 + column, lineEnd) }
}

/** A buffer for the given text with the cursor at its end. */
export function bufferOf(text: string): Buffer {
  return { text, cursor: text.length }
}

/** One rendered line; the line holding the cursor has `cursorAt` set. */
export interface RenderedLine {
  text: string
  cursorAt?: number
}

/** Split the buffer into lines and mark the cursor. */
export function renderLines(buf: Buffer): RenderedLine[] {
  const lines = buf.text.split('\n')
  let offset = 0
  return lines.map((text) => {
    const at = buf.cursor - offset
    offset += text.length + 1
    return at >= 0 && at <= text.length ? { text, cursorAt: at } : { text }
  })
}

/**
 * Split a non-paste input chunk at its first Enter (`\r`, `\n` or `\r\n`). Terminals can deliver
 * `hi\r` as one chunk (tmux, ssh, scripted input), so Enter is not always its own key event.
 * `before` is text typed before the Enter, `rest` is whatever followed it (any further line breaks
 * in it become `\n` text). `enter` is false when the chunk has no line break.
 */
export function splitEnter(chunk: string): { before: string; enter: boolean; rest: string } {
  const at = chunk.search(/[\r\n]/)
  if (at === -1) return { before: chunk, enter: false, rest: '' }
  const after = chunk.slice(at).replace(/^\r\n|^[\r\n]/, '')
  return { before: chunk.slice(0, at), enter: true, rest: after.replace(/\r\n?/g, '\n') }
}

/** `\` + Enter: replace the backslash before the cursor with a newline, or `undefined` when there is none. */
export function backslashNewline(buf: Buffer): Buffer | undefined {
  if (buf.cursor === 0 || buf.text[buf.cursor - 1] !== '\\') return undefined
  return insert(
    {
      text: buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor),
      cursor: buf.cursor - 1,
    },
    '\n',
  )
}

// ---------------------------------------------------------------------------------------------
// Word motions, kill ring, undo
// ---------------------------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}_]/u
const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch)
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)

/** Index of the start of the word before `cursor` (word = letters, digits, `_`; punctuation is skipped). */
export function wordBackIndex(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && !isWord(text[i - 1])) i--
  while (i > 0 && isWord(text[i - 1])) i--
  return i
}

/** Index of the end of the word after `cursor`. */
export function wordForwardIndex(text: string, cursor: number): number {
  let i = cursor
  while (i < text.length && !isWord(text[i])) i++
  while (i < text.length && isWord(text[i])) i++
  return i
}

/** Index of the start of the whitespace-delimited word before `cursor` (Ctrl+W). */
export function spaceWordBackIndex(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && isSpace(text[i - 1])) i--
  while (i > 0 && !isSpace(text[i - 1])) i--
  return i
}

/** Alt+B. */
export function wordBack(buf: Buffer): Buffer {
  return { ...buf, cursor: wordBackIndex(buf.text, buf.cursor) }
}

/** Alt+F. */
export function wordForward(buf: Buffer): Buffer {
  return { ...buf, cursor: wordForwardIndex(buf.text, buf.cursor) }
}

/** The outcome of a kill: the new buffer, the removed text and which side of the cursor it was on. */
export interface Kill {
  buf: Buffer
  killed: string
  dir: 'forward' | 'back'
}

function cut(buf: Buffer, from: number, to: number, dir: Kill['dir']): Kill | undefined {
  const a = Math.max(0, from)
  const b = Math.min(buf.text.length, to)
  if (a >= b) return undefined
  return {
    buf: { text: buf.text.slice(0, a) + buf.text.slice(b), cursor: a },
    killed: buf.text.slice(a, b),
    dir,
  }
}

/** Ctrl+K: kill to the end of the line; at the end of a line it kills the line break. */
export function killToEnd(buf: Buffer): Kill | undefined {
  const next = buf.text.indexOf('\n', buf.cursor)
  const lineEnd = next === -1 ? buf.text.length : next
  return cut(buf, buf.cursor, lineEnd === buf.cursor ? lineEnd + 1 : lineEnd, 'forward')
}

/** Ctrl+U: kill to the start of the line; at the start of a line it kills the previous line break. */
export function killToLineStart(buf: Buffer): Kill | undefined {
  const start = buf.text.lastIndexOf('\n', buf.cursor - 1) + 1
  return cut(buf, start === buf.cursor ? start - 1 : start, buf.cursor, 'back')
}

/** Ctrl+W: kill back to the previous whitespace. */
export function killWordBackSpace(buf: Buffer): Kill | undefined {
  return cut(buf, spaceWordBackIndex(buf.text, buf.cursor), buf.cursor, 'back')
}

/** Alt+Backspace: kill the previous word. */
export function killWordBack(buf: Buffer): Kill | undefined {
  return cut(buf, wordBackIndex(buf.text, buf.cursor), buf.cursor, 'back')
}

/** Alt+D: kill the next word. */
export function killWordForward(buf: Buffer): Kill | undefined {
  return cut(buf, buf.cursor, wordForwardIndex(buf.text, buf.cursor), 'forward')
}

const RING_MAX = 10

/** Add a kill to the ring (newest first). `append` merges consecutive kills into one entry. */
export function pushKill(
  ring: readonly string[],
  killed: string,
  dir: Kill['dir'],
  append: boolean,
): string[] {
  if (append && ring.length > 0) {
    const [top = '', ...rest] = ring
    return [dir === 'forward' ? top + killed : killed + top, ...rest]
  }
  return [killed, ...ring].slice(0, RING_MAX)
}

/** The span of the text inserted by the last yank (so Alt+Y can replace it). */
export interface YankSpan {
  start: number
  end: number
  index: number
}

/** Ctrl+Y: insert the newest kill. */
export function yank(
  buf: Buffer,
  ring: readonly string[],
): { buf: Buffer; span: YankSpan } | undefined {
  const text = ring[0]
  if (text === undefined) return undefined
  return {
    buf: insert(buf, text),
    span: { start: buf.cursor, end: buf.cursor + text.length, index: 0 },
  }
}

/** Alt+Y right after a yank: replace the yanked text with the next ring entry. */
export function yankPop(
  buf: Buffer,
  ring: readonly string[],
  span: YankSpan,
): { buf: Buffer; span: YankSpan } | undefined {
  if (ring.length < 2) return undefined
  const index = (span.index + 1) % ring.length
  const text = ring[index] ?? ''
  const base = {
    text: buf.text.slice(0, span.start) + buf.text.slice(span.end),
    cursor: span.start,
  }
  return {
    buf: insert(base, text),
    span: { start: span.start, end: span.start + text.length, index },
  }
}

/** Why an undo snapshot was taken; `type` and `insert` bursts coalesce into one step. */
export type UndoKind = 'type' | 'edit' | 'insert'

/** Snapshot stack of the prompt (text + cursor). */
export interface UndoStack {
  past: Buffer[]
  lastKind?: UndoKind
  lastAt: number
}

/** An empty undo stack. */
export const emptyUndo: UndoStack = { past: [], lastAt: 0 }

const UNDO_MAX = 200
/** Typing pauses longer than this start a new undo step. */
export const UNDO_COALESCE_MS = 1000

/** Record `before` (the buffer prior to an edit). Consecutive typing bursts share one snapshot. */
export function pushUndo(stack: UndoStack, before: Buffer, kind: UndoKind, now: number): UndoStack {
  const coalesce =
    stack.lastKind === kind &&
    ((kind === 'type' && now - stack.lastAt < UNDO_COALESCE_MS) || kind === 'insert')
  if (coalesce) return { ...stack, lastAt: now }
  const top = stack.past[stack.past.length - 1]
  const same = top !== undefined && top.text === before.text
  const past = same ? stack.past : [...stack.past, before].slice(-UNDO_MAX)
  return { past, lastKind: kind, lastAt: now }
}

/** Force the next snapshot to start a new step. */
export function undoBreak(stack: UndoStack): UndoStack {
  return { ...stack, lastKind: undefined }
}

/** Treat following `insert` edits as part of the current step. */
export function undoJoinInsert(stack: UndoStack): UndoStack {
  return { ...stack, lastKind: 'insert' }
}

/** Ctrl+_: pop the newest snapshot. */
export function popUndo(stack: UndoStack): { buf: Buffer; stack: UndoStack } | undefined {
  const buf = stack.past[stack.past.length - 1]
  if (!buf) return undefined
  return { buf, stack: { past: stack.past.slice(0, -1), lastAt: 0 } }
}
