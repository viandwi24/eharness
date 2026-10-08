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
