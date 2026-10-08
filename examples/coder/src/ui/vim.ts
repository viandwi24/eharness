/**
 * Vim editing mode of the prompt as a pure state machine: `vimKey(buffer, state, key)` returns the
 * next buffer and state. INSERT typing is delegated back to the caller except Esc / printable keys /
 * Backspace, which this module also handles so `.` can replay a whole change including its text.
 *
 * Supported (NORMAL): `i I a A o O`, motions `h j k l w e b 0 ^ $ gg G f F t T ; ,`, operators
 * `d c y` with motions, `dd cc yy`, `iw`/`aw`, `x X D C s S r J ~ p P Y u .`, counts (`3w`, `2dd`,
 * `d2w`), `v` / `V` (VISUAL with `d x y c`), Enter submits. Undo (`u`) is reported to the caller.
 */
import { type Buffer, bufferOf } from './editor.ts'

/** Editing mode. */
export type VimMode = 'insert' | 'normal' | 'visual' | 'visual-line'

/** A key as the state machine sees it. */
export interface VimKey {
  /** Printable text (a single character in practice; chunks are processed char by char). */
  input?: string
  escape?: boolean
  enter?: boolean
  backspace?: boolean
}

/** Unnamed register. */
export interface Register {
  text: string
  linewise: boolean
}

/** State of the vim engine (keep it in a ref next to the buffer). */
export interface VimState {
  mode: VimMode
  /** Digits typed before the next command. */
  count: string
  op?: 'd' | 'c' | 'y'
  /** Count typed before the operator. */
  opCount: number
  pending?: 'g' | 'f' | 'F' | 't' | 'T' | 'r' | 'i' | 'a'
  anchor: number
  /** Column kept across consecutive `j` / `k`. */
  want?: number
  register: Register
  lastFind?: { kind: 'f' | 'F' | 't' | 'T'; ch: string }
  /** Keys of the change in progress (for `.`). */
  rec: VimKey[]
  /** Keys of the last completed change. */
  lastChange: VimKey[]
  replaying: boolean
}

/** Result of one key. */
export interface VimResult {
  buf: Buffer
  state: VimState
  /** Enter in NORMAL mode. */
  submit?: boolean
  /** `u`: the caller pops its undo stack. */
  undo?: boolean
}

/** A new engine in INSERT mode (the prompt starts there). */
export function initialVimState(mode: VimMode = 'insert'): VimState {
  return {
    mode,
    count: '',
    opCount: 1,
    anchor: 0,
    register: { text: '', linewise: false },
    rec: [],
    lastChange: [],
    replaying: false,
  }
}

/** Footer label of a mode (`-- INSERT --`). */
export function modeLabel(mode: VimMode): string {
  return mode === 'visual-line' ? '-- VISUAL LINE --' : `-- ${mode.toUpperCase()} --`
}

// --- text helpers ---------------------------------------------------------------------------

const lineStartOf = (t: string, i: number): number => t.lastIndexOf('\n', i - 1) + 1
const lineEndOf = (t: string, i: number): number => {
  const n = t.indexOf('\n', i)
  return n === -1 ? t.length : n
}
const firstNonBlank = (t: string, ls: number): number => {
  const le = lineEndOf(t, ls)
  let i = ls
  while (i < le && (t[i] === ' ' || t[i] === '\t')) i++
  return i === le && le > ls ? le - 1 : i
}
const lineIndex = (t: string, i: number): number => {
  let n = 0
  for (let k = 0; k < i; k++) if (t[k] === '\n') n++
  return n
}
const lineOffset = (lines: string[], idx: number): number => {
  let o = 0
  for (let i = 0; i < idx; i++) o += (lines[i]?.length ?? 0) + 1
  return o
}

type CharClass = 'space' | 'word' | 'punct'
const classOf = (ch: string | undefined): CharClass => {
  if (ch === undefined || /\s/.test(ch)) return 'space'
  return /[\p{L}\p{N}_]/u.test(ch) ? 'word' : 'punct'
}

/** Cursor clamped to a character of its line (NORMAL mode cannot rest past the end). */
function clampNormal(buf: Buffer): Buffer {
  const ls = lineStartOf(buf.text, buf.cursor)
  const le = lineEndOf(buf.text, buf.cursor)
  const max = Math.max(ls, le - 1)
  return buf.cursor > max ? { ...buf, cursor: max } : buf
}

// --- motions --------------------------------------------------------------------------------

interface Motion {
  /** Column to keep for the next `j` / `k`. */
  want?: number
  to: number
  linewise?: boolean
  inclusive?: boolean
}

function wordForwardFrom(t: string, from: number): number {
  let i = from
  const cls = classOf(t[i])
  if (cls !== 'space') while (i < t.length && classOf(t[i]) === cls) i++
  while (i < t.length && classOf(t[i]) === 'space') {
    // an empty line is a word of its own
    if (t[i] === '\n' && t[i + 1] === '\n' && i > from) return i + 1
    i++
  }
  return i
}

function wordEndFrom(t: string, from: number): number {
  let i = from + 1
  while (i < t.length && classOf(t[i]) === 'space') i++
  const cls = classOf(t[i])
  while (i + 1 < t.length && classOf(t[i + 1]) === cls) i++
  return Math.min(i, Math.max(0, t.length - 1))
}

function wordBackFrom(t: string, from: number): number {
  let i = from - 1
  while (i > 0 && classOf(t[i]) === 'space') i--
  if (i <= 0) return 0
  const cls = classOf(t[i])
  while (i > 0 && classOf(t[i - 1]) === cls) i--
  return i
}

function findChar(
  t: string,
  cursor: number,
  kind: 'f' | 'F' | 't' | 'T',
  ch: string,
  n: number,
  repeat = false,
): number | undefined {
  const ls = lineStartOf(t, cursor)
  const le = lineEndOf(t, cursor)
  let pos = cursor
  for (let k = 0; k < n; k++) {
    if (kind === 'f' || kind === 't') {
      // `t` repeated from just before a match must not get stuck on it
      const from = pos + 1 + (repeat && kind === 't' && k === 0 && t[pos + 1] === ch ? 1 : 0)
      const at = t.indexOf(ch, from)
      if (at === -1 || at >= le) return undefined
      pos = at
    } else {
      const from = pos - 1 - (repeat && kind === 'T' && k === 0 && t[pos - 1] === ch ? 1 : 0)
      const at = from < ls ? -1 : t.lastIndexOf(ch, from)
      if (at === -1 || at < ls) return undefined
      pos = at
    }
  }
  return kind === 't' ? pos - 1 : kind === 'T' ? pos + 1 : pos
}

function computeMotion(
  buf: Buffer,
  ch: string,
  n: number,
  hasCount: boolean,
  opPending: boolean,
  want: number | undefined,
  arg?: { kind: 'f' | 'F' | 't' | 'T'; ch: string },
): Motion | undefined {
  const { text: t, cursor: c } = buf
  const ls = lineStartOf(t, c)
  const le = lineEndOf(t, c)
  switch (ch) {
    case 'h':
      return c > ls ? { to: Math.max(ls, c - n) } : undefined
    case 'l': {
      const limit = opPending ? le : Math.max(ls, le - 1)
      return c < limit ? { to: Math.min(limit, c + n) } : undefined
    }
    case 'j':
    case 'k': {
      const lines = t.split('\n')
      const idx = lineIndex(t, c)
      const target = Math.max(0, Math.min(lines.length - 1, idx + (ch === 'j' ? n : -n)))
      if (target === idx) return undefined
      const col = want ?? c - ls
      const len = lines[target]?.length ?? 0
      const max = opPending ? len : Math.max(0, len - 1)
      return { to: lineOffset(lines, target) + Math.min(col, max), linewise: true, want: col }
    }
    case 'w': {
      let to = c
      for (let k = 0; k < n; k++) to = wordForwardFrom(t, to)
      return { to: Math.min(to, t.length) }
    }
    case 'e': {
      let to = c
      for (let k = 0; k < n; k++) to = wordEndFrom(t, to)
      return { to, inclusive: true }
    }
    case 'b': {
      let to = c
      for (let k = 0; k < n; k++) to = wordBackFrom(t, to)
      return { to }
    }
    case '0':
      return { to: ls }
    case '^':
      return { to: firstNonBlank(t, ls) }
    case '$': {
      const lines = t.split('\n')
      const target = Math.min(lines.length - 1, lineIndex(t, c) + n - 1)
      const start = lineOffset(lines, target)
      const end = start + (lines[target]?.length ?? 0)
      return { to: Math.max(start, end - 1), inclusive: true }
    }
    case 'G':
    case 'gg': {
      const lines = t.split('\n')
      const target = hasCount
        ? Math.min(lines.length - 1, n - 1)
        : ch === 'G'
          ? lines.length - 1
          : 0
      return { to: firstNonBlank(t, lineOffset(lines, target)), linewise: true }
    }
    case 'f':
    case 'F':
    case 't':
    case 'T':
    case ';':
    case ',': {
      if (!arg) return undefined
      const to = findChar(t, c, arg.kind, arg.ch, n, ch === ';' || ch === ',')
      return to === undefined ? undefined : { to, inclusive: arg.kind === 'f' || arg.kind === 't' }
    }
    default:
      return undefined
  }
}

const MOTION_KEYS = new Set(['h', 'l', 'j', 'k', 'w', 'e', 'b', '0', '^', '$', 'G', ';', ','])

// --- editing primitives ---------------------------------------------------------------------

function removeRange(buf: Buffer, from: number, to: number): Buffer {
  return { text: buf.text.slice(0, from) + buf.text.slice(to), cursor: from }
}

/** Whole lines `l1..l2` of the buffer. */
function lineRange(buf: Buffer, l1: number, l2: number): { lines: string[]; removed: string[] } {
  const lines = buf.text.split('\n')
  return { lines, removed: lines.slice(l1, l2 + 1) }
}

function deleteLines(buf: Buffer, l1: number, l2: number): { buf: Buffer; reg: Register } {
  const { lines, removed } = lineRange(buf, l1, l2)
  const rest = [...lines.slice(0, l1), ...lines.slice(l2 + 1)]
  const text = rest.join('\n')
  const at = Math.min(l1, Math.max(0, rest.length - 1))
  const cursor = rest.length === 0 ? 0 : firstNonBlank(text, lineOffset(rest, at))
  return { buf: { text, cursor }, reg: { text: removed.join('\n'), linewise: true } }
}

function changeLines(buf: Buffer, l1: number, l2: number): { buf: Buffer; reg: Register } {
  const { lines, removed } = lineRange(buf, l1, l2)
  const rest = [...lines.slice(0, l1), '', ...lines.slice(l2 + 1)]
  return {
    buf: { text: rest.join('\n'), cursor: lineOffset(rest, l1) },
    reg: { text: removed.join('\n'), linewise: true },
  }
}

function linesOf(buf: Buffer, a: number, b: number): [number, number] {
  const x = lineIndex(buf.text, a)
  const y = lineIndex(buf.text, b)
  return x <= y ? [x, y] : [y, x]
}

function wordObject(buf: Buffer, around: boolean): { from: number; to: number } | undefined {
  const t = buf.text
  const c = buf.cursor
  if (c >= t.length || t[c] === '\n') return undefined
  const cls = classOf(t[c])
  let from = c
  let to = c + 1
  while (from > 0 && t[from - 1] !== '\n' && classOf(t[from - 1]) === cls) from--
  while (to < t.length && t[to] !== '\n' && classOf(t[to]) === cls) to++
  if (around && cls !== 'space') {
    const trailing = to
    while (to < t.length && (t[to] === ' ' || t[to] === '\t')) to++
    if (to === trailing) while (from > 0 && (t[from - 1] === ' ' || t[from - 1] === '\t')) from--
  }
  return { from, to }
}

function pasteRegister(buf: Buffer, reg: Register, n: number, after: boolean): Buffer {
  if (reg.text === '') return buf
  if (reg.linewise) {
    const lines = buf.text.split('\n')
    const idx = lineIndex(buf.text, buf.cursor)
    const at = after ? idx + 1 : idx
    const inserted = Array.from({ length: n }, () => reg.text.split('\n')).flat()
    const next = [...lines.slice(0, at), ...inserted, ...lines.slice(at)]
    const text = next.join('\n')
    return { text, cursor: firstNonBlank(text, lineOffset(next, at)) }
  }
  const le = lineEndOf(buf.text, buf.cursor)
  const at = after && buf.cursor < le ? buf.cursor + 1 : buf.cursor
  const body = reg.text.repeat(n)
  return {
    text: buf.text.slice(0, at) + body + buf.text.slice(at),
    cursor: at + Math.max(0, body.length - 1),
  }
}

const toggleCase = (s: string): string =>
  [...s].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('')

/** The selected span of a VISUAL mode (end exclusive), for highlighting. */
export function visualRange(buf: Buffer, st: VimState): { start: number; end: number } | undefined {
  if (st.mode === 'visual') {
    const a = Math.min(st.anchor, buf.cursor)
    const b = Math.max(st.anchor, buf.cursor)
    return { start: a, end: Math.min(buf.text.length, b + 1) }
  }
  if (st.mode === 'visual-line') {
    const [l1, l2] = linesOf(buf, st.anchor, buf.cursor)
    const lines = buf.text.split('\n')
    const start = lineOffset(lines, l1)
    return { start, end: lineOffset(lines, l2) + (lines[l2]?.length ?? 0) }
  }
  return undefined
}

// --- key handling ---------------------------------------------------------------------------

function idle(st: VimState, over: Partial<VimState> = {}): VimState {
  return {
    ...st,
    count: '',
    op: undefined,
    opCount: 1,
    pending: undefined,
    want: undefined,
    rec: [],
    ...over,
  }
}

function insertKey(buf: Buffer, st: VimState, key: VimKey): VimResult {
  if (key.escape) {
    const ls = lineStartOf(buf.text, buf.cursor)
    const cursor = buf.cursor > ls ? buf.cursor - 1 : buf.cursor
    const rec = [...st.rec, key]
    const lastChange = st.replaying || st.rec.length === 0 ? st.lastChange : rec
    return { buf: { ...buf, cursor }, state: idle(st, { mode: 'normal', lastChange }) }
  }
  const rec = st.replaying || st.rec.length === 0 ? st.rec : [...st.rec, key]
  if (key.backspace) {
    if (buf.cursor === 0) return { buf, state: { ...st, rec } }
    return { buf: removeRange(buf, buf.cursor - 1, buf.cursor), state: { ...st, rec } }
  }
  if (key.input) {
    const text = key.input.replace(/\r\n?/g, '\n')
    return {
      buf: {
        text: buf.text.slice(0, buf.cursor) + text + buf.text.slice(buf.cursor),
        cursor: buf.cursor + text.length,
      },
      state: { ...st, rec },
    }
  }
  return { buf, state: st }
}

/** Process one key. */
export function vimKey(buf: Buffer, st: VimState, key: VimKey): VimResult {
  if (st.mode === 'insert') return insertKey(buf, st, key)
  if (key.input && [...key.input].length > 1) {
    let r: VimResult = { buf, state: st }
    for (const c of [...key.input]) {
      r = vimKey(r.buf, r.state, { input: c })
      if (r.submit) break
    }
    return r
  }
  return commandKey(buf, st, key)
}

function commandKey(buf: Buffer, st0: VimState, key: VimKey): VimResult {
  const visual = st0.mode === 'visual' || st0.mode === 'visual-line'
  if (key.escape) {
    return { buf: clampNormal(buf), state: idle(st0, { mode: 'normal' }) }
  }
  if (key.enter) {
    if (visual || st0.op || st0.pending) return { buf, state: idle(st0) }
    return { buf, state: idle(st0), submit: true }
  }
  const ch = key.backspace ? 'h' : key.input
  if (!ch) return { buf, state: st0 }

  // record every key of a command (for `.`), unless replaying or in VISUAL
  let st: VimState = st0.replaying || visual ? st0 : { ...st0, rec: [...st0.rec, key] }
  const cancel = (): VimResult => ({ buf, state: idle(st) })
  const n = (): number => st.opCount * (st.count === '' ? 1 : Number(st.count))
  const hasCount = (): boolean => st.count !== '' || st.opCount !== 1
  const done = (
    next: Buffer,
    over: Partial<VimState> = {},
    opts: { change?: boolean } = {},
  ): VimResult => {
    const mode = over.mode ?? st.mode
    const finished = opts.change && mode !== 'insert' && !st.replaying && !visual
    const keepRec = mode === 'insert' && !st.replaying && !visual
    const lastChange = finished ? st.rec : st.lastChange
    const clamped = mode === 'normal' ? clampNormal(next) : next
    return {
      buf: clamped,
      state: idle(st, { ...over, lastChange, rec: keepRec ? st.rec : [] }),
    }
  }

  // pending second keys
  if (st.pending) {
    const p = st.pending
    st = { ...st, pending: undefined }
    if (p === 'r') {
      if (ch.length !== 1) return cancel()
      const cnt = n()
      const le = lineEndOf(buf.text, buf.cursor)
      if (buf.cursor + cnt > le) return cancel()
      const text = buf.text.slice(0, buf.cursor) + ch.repeat(cnt) + buf.text.slice(buf.cursor + cnt)
      return done({ text, cursor: buf.cursor + cnt - 1 }, {}, { change: true })
    }
    if (p === 'i' || p === 'a') {
      const obj = ch === 'w' ? wordObject(buf, p === 'a') : undefined
      if (!obj || !st.op) return cancel()
      return applyRange(buf, st, obj.from, obj.to, false, done)
    }
    let motion: Motion | undefined
    if (p === 'g') {
      if (ch !== 'g') return cancel()
      motion = computeMotion(buf, 'gg', n(), hasCount(), st.op !== undefined, st.want)
    } else {
      st = { ...st, lastFind: { kind: p, ch } }
      motion = computeMotion(buf, p, n(), hasCount(), st.op !== undefined, st.want, { kind: p, ch })
    }
    return applyMotion(buf, st, motion, done, cancel)
  }

  // counts
  if (/^[1-9]$/.test(ch) || (ch === '0' && st.count !== '')) {
    return { buf, state: { ...st, count: st.count + ch } }
  }

  // operator doubled: dd cc yy
  if (st.op && ch === st.op) {
    const lines = buf.text.split('\n')
    const idx = lineIndex(buf.text, buf.cursor)
    const l2 = Math.min(lines.length - 1, idx + n() - 1)
    return applyLines(buf, st, idx, l2, done)
  }

  // find / g / text-object prefixes
  if (ch === 'f' || ch === 'F' || ch === 't' || ch === 'T' || ch === 'g') {
    return { buf, state: { ...st, pending: ch } }
  }
  if ((ch === 'i' || ch === 'a') && st.op) return { buf, state: { ...st, pending: ch } }
  if (ch === ';' || ch === ',') {
    const lf = st.lastFind
    if (!lf) return cancel()
    const flip = { f: 'F', F: 'f', t: 'T', T: 't' } as const
    const kind = ch === ';' ? lf.kind : flip[lf.kind]
    const m = computeMotion(buf, ch, n(), hasCount(), st.op !== undefined, st.want, {
      kind,
      ch: lf.ch,
    })
    return applyMotion(buf, st, m, done, cancel)
  }

  // motions
  if (MOTION_KEYS.has(ch)) {
    let m: Motion | undefined
    if (ch === 'w' && st.op === 'c' && classOf(buf.text[buf.cursor]) !== 'space') {
      // `cw` changes to the end of the word, like `ce` (but a word's last char is changed alone)
      let to = buf.cursor
      while (
        classOf(buf.text[to + 1]) === classOf(buf.text[buf.cursor]) &&
        buf.text[to + 1] !== '\n'
      )
        to++
      for (let k = 1; k < n(); k++) to = wordEndFrom(buf.text, to)
      m = { to, inclusive: true }
    } else {
      m = computeMotion(buf, ch, n(), hasCount(), st.op !== undefined, st.want)
      if (m && ch === 'w' && st.op && n() === 1) {
        // `dw` on the last word of a line stops at the line end
        m = { ...m, to: Math.min(m.to, lineEndOf(buf.text, buf.cursor)) }
      }
    }
    return applyMotion(buf, st, m, done, cancel)
  }

  // operators
  if (ch === 'd' || ch === 'c' || ch === 'y') {
    if (visual) return visualOp(buf, st, ch, done)
    return { buf, state: { ...st, op: ch, opCount: n(), count: '' } }
  }

  if (visual) return visualKey(buf, st, ch, done, cancel)
  if (st.op) return cancel()

  const cnt = n()
  const ls = lineStartOf(buf.text, buf.cursor)
  const le = lineEndOf(buf.text, buf.cursor)
  switch (ch) {
    case 'i':
      return done(buf, { mode: 'insert' })
    case 'a':
      return done(
        { ...buf, cursor: buf.cursor < le ? buf.cursor + 1 : buf.cursor },
        { mode: 'insert' },
      )
    case 'I':
      return done({ ...buf, cursor: firstNonBlank(buf.text, ls) }, { mode: 'insert' })
    case 'A':
      return done({ ...buf, cursor: le }, { mode: 'insert' })
    case 'o':
    case 'O': {
      const at = ch === 'o' ? le : ls
      const text = `${buf.text.slice(0, at)}\n${buf.text.slice(at)}`
      return done({ text, cursor: ch === 'o' ? at + 1 : at }, { mode: 'insert' })
    }
    case 'x':
    case 'X': {
      const from = ch === 'x' ? buf.cursor : Math.max(ls, buf.cursor - cnt)
      const to = ch === 'x' ? Math.min(le, buf.cursor + cnt) : buf.cursor
      if (from >= to) return cancel()
      return done(
        removeRange(buf, from, to),
        { register: { text: buf.text.slice(from, to), linewise: false } },
        { change: true },
      )
    }
    case 's': {
      const to = Math.min(le, buf.cursor + cnt)
      const reg = { text: buf.text.slice(buf.cursor, to), linewise: false }
      return done(
        removeRange(buf, buf.cursor, to),
        { mode: 'insert', register: reg.text ? reg : st.register },
        { change: true },
      )
    }
    case 'S':
      return applyLines(
        buf,
        { ...st, op: 'c' },
        lineIndex(buf.text, buf.cursor),
        lineIndex(buf.text, buf.cursor),
        done,
      )
    case 'D':
    case 'C': {
      const reg = { text: buf.text.slice(buf.cursor, le), linewise: false }
      return done(
        removeRange(buf, buf.cursor, le),
        { mode: ch === 'C' ? 'insert' : 'normal', register: reg.text ? reg : st.register },
        { change: true },
      )
    }
    case 'Y': {
      const idx = lineIndex(buf.text, buf.cursor)
      return applyLines(
        buf,
        { ...st, op: 'y' },
        idx,
        Math.min(idx + cnt - 1, buf.text.split('\n').length - 1),
        done,
      )
    }
    case 'r':
      return { buf, state: { ...st, pending: 'r' } }
    case 'p':
    case 'P':
      return done(pasteRegister(buf, st.register, cnt, ch === 'p'), {}, { change: true })
    case 'J': {
      if (le >= buf.text.length) return cancel()
      const nextEnd = lineEndOf(buf.text, le + 1)
      const nextLine = buf.text.slice(le + 1, nextEnd).replace(/^\s+/, '')
      const sep = nextLine === '' || le === ls ? '' : ' '
      const text = buf.text.slice(0, le) + sep + nextLine + buf.text.slice(nextEnd)
      return done({ text, cursor: le }, {}, { change: true })
    }
    case '~': {
      const to = Math.min(le, buf.cursor + cnt)
      if (to <= buf.cursor) return cancel()
      const text =
        buf.text.slice(0, buf.cursor) +
        toggleCase(buf.text.slice(buf.cursor, to)) +
        buf.text.slice(to)
      return done({ text, cursor: to }, {}, { change: true })
    }
    case 'u':
      return { buf, state: idle(st), undo: true }
    case '.': {
      if (st.lastChange.length === 0) return cancel()
      let r: VimResult = { buf, state: { ...idle(st), replaying: true } }
      for (const k of st.lastChange) r = vimKey(r.buf, r.state, k)
      return {
        buf: r.buf,
        state: idle(st, { ...r.state, replaying: false, rec: [], lastChange: st.lastChange }),
      }
    }
    case 'v':
      return { buf, state: idle(st, { mode: 'visual', anchor: buf.cursor }) }
    case 'V':
      return { buf, state: idle(st, { mode: 'visual-line', anchor: buf.cursor }) }
    default:
      return cancel()
  }
}

type Done = (next: Buffer, over?: Partial<VimState>, opts?: { change?: boolean }) => VimResult

function applyMotion(
  buf: Buffer,
  st: VimState,
  m: Motion | undefined,
  done: Done,
  cancel: () => VimResult,
): VimResult {
  if (!m) return cancel()
  if (!st.op) {
    return {
      buf: clampNormal({ ...buf, cursor: m.to }),
      state: idle(st, { mode: st.mode, want: m.want }),
    }
  }
  if (m.linewise) {
    const [l1, l2] = linesOf(buf, buf.cursor, m.to)
    return applyLines(buf, st, l1, l2, done)
  }
  const back = m.to < buf.cursor
  const from = back ? m.to : buf.cursor
  const to = back ? buf.cursor : m.to + (m.inclusive ? 1 : 0)
  return applyRange(buf, st, from, to, false, done)
}

function applyRange(
  buf: Buffer,
  st: VimState,
  from: number,
  to: number,
  _linewise: boolean,
  done: Done,
): VimResult {
  const text = buf.text.slice(from, to)
  if (text === '') return { buf, state: idle(st) }
  const register = { text, linewise: false }
  if (st.op === 'y') return done({ ...buf, cursor: from }, { register })
  return done(
    removeRange(buf, from, to),
    { register, mode: st.op === 'c' ? 'insert' : 'normal' },
    { change: true },
  )
}

function applyLines(buf: Buffer, st: VimState, l1: number, l2: number, done: Done): VimResult {
  if (st.op === 'y') {
    const { removed } = lineRange(buf, l1, l2)
    return done(buf, { register: { text: removed.join('\n'), linewise: true } })
  }
  if (st.op === 'c') {
    const r = changeLines(buf, l1, l2)
    return done(r.buf, { register: r.reg, mode: 'insert' }, { change: true })
  }
  const r = deleteLines(buf, l1, l2)
  return done(r.buf, { register: r.reg }, { change: true })
}

function visualOp(buf: Buffer, st: VimState, ch: 'd' | 'c' | 'y', done: Done): VimResult {
  const range = visualRange(buf, st)
  if (!range) return { buf, state: idle(st, { mode: 'normal' }) }
  const op = { ...st, op: ch, mode: 'normal' as const }
  if (st.mode === 'visual-line') {
    const [l1, l2] = linesOf(buf, st.anchor, buf.cursor)
    return applyLines(buf, op, l1, l2, (b, over, opts) =>
      done(b, { ...over, mode: over?.mode ?? 'normal' }, { ...opts, change: false }),
    )
  }
  return applyRange(buf, op, range.start, range.end, false, (b, over, opts) =>
    done(b, { ...over, mode: over?.mode ?? 'normal' }, { ...opts, change: false }),
  )
}

function visualKey(
  buf: Buffer,
  st: VimState,
  ch: string,
  done: Done,
  cancel: () => VimResult,
): VimResult {
  switch (ch) {
    case 'x':
      return visualOp(buf, st, 'd', done)
    case 'v':
      return { buf, state: idle(st, { mode: st.mode === 'visual' ? 'normal' : 'visual' }) }
    case 'V':
      return {
        buf,
        state: idle(st, { mode: st.mode === 'visual-line' ? 'normal' : 'visual-line' }),
      }
    case 'o':
      return { buf: { ...buf, cursor: st.anchor }, state: idle(st, { anchor: buf.cursor }) }
    default:
      return cancel()
  }
}

/** Convenience for tests and callers: feed a string of plain keys (`\x1b` = Esc, `\r` = Enter). */
export function vimFeed(
  buf: Buffer,
  st: VimState,
  keys: string,
): VimResult & { undos: number; submits: number } {
  let r: VimResult = { buf, state: st }
  let undos = 0
  let submits = 0
  for (const c of keys) {
    const key: VimKey =
      c === '\x1b'
        ? { escape: true }
        : c === '\r'
          ? { enter: true }
          : c === '\b'
            ? { backspace: true }
            : { input: c }
    r = vimKey(r.buf, r.state, key)
    if (r.undo) undos++
    if (r.submit) submits++
  }
  return { ...r, undos, submits }
}

export { bufferOf }
