/**
 * Moves of library and memory files (a reorganization the owner made offline in the workspace zip,
 * or any rename that must not strand an agent). Pure rules:
 *
 *  - `migrations/moves.json` of a zip: the moves the owner states (`from`, `to`, optional `note`).
 *    A path ending with `/` moves a folder prefix.
 *  - mapping a path through moves, following a chain (a file moved twice), for the redirects of the
 *    file system the agents use and for rewriting references;
 *  - finding the paths a text refers to (plain `/library/x.md`, or percent-encoded inside the tail
 *    of a standing order of HEARTBEAT.md) and rewriting the ones that point to nothing now;
 *  - the sentences agents read when a path they used moved.
 */

export type MoveKind = 'file' | 'prefix'

/** One move, in library paths (`/library/a.md`, `/memories/agents/<id>/x.md`). A prefix ends with `/`. */
export interface MoveRule {
  from: string
  to: string
  kind: MoveKind
  /** When it was applied (ms); newer rules win a tie. */
  at?: number
}

/** A move as stored in `library_moves`. */
export interface LibraryMove extends MoveRule {
  id: string
  at: number
  /** The restore point of the import that made it (undo = that restore point). */
  restorePointId: string | null
  note: string | null
}

export const MOVES_FILE = 'migrations/moves.json'
export const MAX_MOVES = 5_000

/** What the owner wrote in `migrations/moves.json`. */
export interface RawMove {
  from: string
  to: string
  note?: string
}

/** The moves of the file, and what was wrong with the entries that were left out. */
export function parseMovesFile(text: string): { moves: RawMove[]; problems: string[] } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { moves: [], problems: [`${MOVES_FILE} is not valid JSON: it is ignored`] }
  }
  if (!Array.isArray(value)) {
    return { moves: [], problems: [`${MOVES_FILE} must be a list of { from, to }: it is ignored`] }
  }
  const moves: RawMove[] = []
  const problems: string[] = []
  value.slice(0, MAX_MOVES).forEach((entry, i) => {
    const o = entry as Record<string, unknown> | null
    if (
      o === null ||
      typeof o !== 'object' ||
      typeof o.from !== 'string' ||
      typeof o.to !== 'string' ||
      o.from.trim() === '' ||
      o.to.trim() === ''
    ) {
      problems.push(`move #${i + 1} needs a "from" and a "to" (text): left out`)
      return
    }
    moves.push({
      from: o.from.trim(),
      to: o.to.trim(),
      ...(typeof o.note === 'string' && o.note.trim() !== '' ? { note: o.note.trim() } : {}),
    })
  })
  if (value.length > MAX_MOVES) problems.push(`only the first ${MAX_MOVES} moves are read`)
  return { moves, problems }
}

/**
 * The library path a path of `moves.json` means, or why it is not usable. Accepted forms: the
 * library path (`/library/a.md`, `/uploads/...`, `/memories/workspace/...`, `/memories/agents/<id or
 * slug>/...`) and the zip names of the export (`library/a.md`, `memory/x.md`,
 * `agents/<slug>/memory/x.md`). A trailing `/` (a folder) is kept.
 */
export function livePathOfMove(
  raw: string,
  idBySlug: ReadonlyMap<string, string>,
  knownIds: ReadonlySet<string>,
): { path: string } | { error: string } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return { error: `bad path: ${raw}` }
  const folder = raw.endsWith('/')
  const parts = raw.split('/').filter((p) => p !== '')
  if (parts.some((p) => p === '.' || p === '..')) return { error: `bad path: ${raw}` }
  const join = (head: string[]): string => `/${head.join('/')}${folder ? '/' : ''}`
  const [top, second, third] = parts
  if (top === 'library' || top === 'uploads') return finish(join(parts), raw)
  if (top === 'memory' && parts.length > 1)
    return finish(join(['memories', 'workspace', ...parts.slice(1)]), raw)
  if (top === 'agents' && third === 'memory' && parts.length > 3) {
    const id = idBySlug.get(second ?? '')
    if (id === undefined) return { error: `unknown agent in ${raw}` }
    return finish(join(['memories', 'agents', id, ...parts.slice(3)]), raw)
  }
  if (top === 'memories') {
    if (second === 'agents' && parts.length > 3) {
      const id = knownIds.has(third ?? '') ? (third as string) : idBySlug.get(third ?? '')
      if (id === undefined) return { error: `unknown agent in ${raw}` }
      return finish(join(['memories', 'agents', id, ...parts.slice(3)]), raw)
    }
    return finish(join(parts), raw)
  }
  if (top === 'other' && parts.length > 1) return finish(join(parts.slice(1)), raw)
  return { error: `not a library or memory path: ${raw}` }
}

function finish(path: string, raw: string): { path: string } | { error: string } {
  if (path === '/' || path.length > 600) return { error: `bad path: ${raw}` }
  return { path }
}

/** Whether `path` is `prefix` (a folder form, ending with `/`) or below it. */
export const isUnderPrefix = (path: string, prefix: string): boolean => path.startsWith(prefix)

/** The rule that moves `path`: an exact file rule first, else the longest folder rule; newer wins a tie. */
function bestRule(path: string, rules: readonly MoveRule[]): MoveRule | undefined {
  let best: MoveRule | undefined
  for (const r of rules) {
    if (r.kind === 'file') {
      if (r.from !== path) continue
      if (best === undefined || best.kind !== 'file' || (r.at ?? 0) >= (best.at ?? 0)) best = r
    } else if (path.startsWith(r.from)) {
      if (best?.kind === 'file') continue
      if (
        best === undefined ||
        r.from.length > best.from.length ||
        (r.from.length === best.from.length && (r.at ?? 0) >= (best.at ?? 0))
      ) {
        best = r
      }
    }
  }
  return best
}

/** Where one move sends `path`, or undefined. One hop. */
export function mapPath(path: string, rules: readonly MoveRule[]): string | undefined {
  const rule = bestRule(path, rules)
  if (rule === undefined) return undefined
  const mapped = rule.kind === 'file' ? rule.to : rule.to + path.slice(rule.from.length)
  return mapped === path ? undefined : mapped
}

const MAX_HOPS = 8

/**
 * The path a missing `path` moved to: follows a chain of moves (a file moved twice) and stops at
 * the first path that `exists`. Undefined when no move applies.
 */
export function resolveMoved(
  path: string,
  rules: readonly MoveRule[],
  exists: (path: string) => boolean,
): string | undefined {
  let current = path
  const seen = new Set([path])
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = mapPath(current, rules)
    if (next === undefined || seen.has(next)) break
    current = next
    seen.add(next)
    if (exists(current)) break
  }
  return current === path ? undefined : current
}

/**
 * The folder a missing folder `dir` (ends with `/`) moved to: through a folder rule, or because every
 * moved file that was below it went to the same relative place. Undefined when it did not move.
 */
export function movedFolder(dir: string, rules: readonly MoveRule[]): string | undefined {
  const viaPrefix = mapPath(dir, rules)
  if (viaPrefix !== undefined) return viaPrefix
  let base: string | undefined
  for (const r of rules) {
    if (r.kind !== 'file' || !r.from.startsWith(dir)) continue
    const rest = r.from.slice(dir.length)
    if (!r.to.endsWith(rest)) return undefined
    const target = r.to.slice(0, r.to.length - rest.length)
    if (base !== undefined && base !== target) return undefined
    base = target
  }
  return base
}

// --- what agents read ----------------------------------------------------------------------------

/** The first line of a read through an old path. */
export const movedNote = (from: string, to: string): string =>
  `Moved: ${from} → ${to}. Use the new path.`

/** The first line of a write through an old path. */
export const writtenNote = (from: string, to: string): string =>
  `Written to ${to} (moved from ${from}). Use the new path.`

/** What a listing of an old folder says. */
export const folderMovedNote = (from: string, to: string): string =>
  `This folder moved to ${to}. Use the new path (${from} is empty now).`

/** The line of the memory instructions about moves. Static text (prompt-cache prefix). */
export const MOVED_PATHS_RULE =
  'If a tool result says "Moved: <old> → <new>", "Written to <new> (moved from <old>)" or "This folder moved to <new>", the library was reorganized: use the new path from now on, and update your memory (rules.md, index.md) where it still names the old path.'

// --- paths a text refers to ----------------------------------------------------------------------

export interface PathToken {
  start: number
  end: number
  /** The path as written, decoded when it was percent-encoded. */
  path: string
  /** Written percent-encoded (`%2Flibrary%2Fa.md`, inside the tail of a standing order). */
  encoded: boolean
}

const PLAIN = /(?<![A-Za-z0-9_.~%/-])\/(?:library|memories|uploads)\/[^\s"'`<>()[\]{}|,;]*/g
const ENCODED = /%2F(?:library|memories|uploads)%2F[^\s"'<>,]*/gi

/** Every library or memory path in a text (plain, or encoded in a standing order tail). */
export function scanPathTokens(text: string): PathToken[] {
  const out: PathToken[] = []
  for (const m of text.matchAll(PLAIN)) {
    let raw = m[0]
    // a path that ends a sentence or a bold span
    raw = raw.replace(/[.:!?]+$/, '')
    if (raw.length < 4) continue
    out.push({ start: m.index, end: m.index + raw.length, path: raw, encoded: false })
  }
  for (const m of text.matchAll(ENCODED)) {
    const raw = m[0]
    let path: string
    try {
      path = decodeURIComponent(raw)
    } catch {
      continue
    }
    out.push({ start: m.index, end: m.index + raw.length, path, encoded: true })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The sorted paths of the files, for exact and prefix questions. */
export class PathIndex {
  private readonly sorted: string[]
  constructor(paths: Iterable<string>) {
    this.sorted = [...new Set(paths)].sort()
  }

  get size(): number {
    return this.sorted.length
  }

  private lower(prefix: string): number {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.sorted[mid] as string) < prefix) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  has(path: string): boolean {
    const i = this.lower(path)
    return this.sorted[i] === path
  }

  hasPrefix(prefix: string): boolean {
    const i = this.lower(prefix)
    return i < this.sorted.length && (this.sorted[i] as string).startsWith(prefix)
  }
}

const GLOB_START = /[*{?[]/

/**
 * Whether a reference (a file, a folder, or a glob / token pattern such as `/library/r/**` or
 * `/library/r/{date}.md`) points to something in `index`: a file, a folder with files, or a pattern
 * whose literal head does.
 */
export function refExists(ref: string, index: PathIndex): boolean {
  const g = ref.search(GLOB_START)
  if (g >= 0) {
    const head = ref.slice(0, g)
    return head === '' || index.hasPrefix(head)
  }
  if (ref.endsWith('/')) return index.hasPrefix(ref)
  return index.has(ref) || index.hasPrefix(`${ref}/`)
}

/** Where the moves send a reference (file, folder or pattern), or undefined. */
export function mapRef(ref: string, rules: readonly MoveRule[]): string | undefined {
  const g = ref.search(GLOB_START)
  if (g >= 0) {
    const head = ref.slice(0, g)
    const tail = ref.slice(g)
    const folderHead = head.endsWith('/') ? head : head.slice(0, head.lastIndexOf('/') + 1)
    const rest = head.slice(folderHead.length)
    const mapped = mapPath(folderHead, rules)
    return mapped === undefined ? undefined : `${mapped}${rest}${tail}`
  }
  if (!ref.endsWith('/')) {
    const file = mapPath(ref, rules)
    if (file !== undefined) return file
    const folder = mapPath(`${ref}/`, rules)
    return folder === undefined ? undefined : folder.replace(/\/$/, '')
  }
  return mapPath(ref, rules)
}

/**
 * The reference rewritten to where the moves put it, but only when it points to nothing now and its
 * new place does exist: a reference that is fine is never touched (so a rule that nests a folder
 * into itself cannot be applied twice).
 */
export function rewriteRef(
  ref: string,
  rules: readonly MoveRule[],
  after: PathIndex,
): string | undefined {
  if (refExists(ref, after)) return undefined
  const mapped = mapRef(ref, rules)
  return mapped !== undefined && refExists(mapped, after) ? mapped : undefined
}

/** A text with its dangling paths rewritten; `changes` lists what was replaced (old to new). */
export function rewriteText(
  text: string,
  rules: readonly MoveRule[],
  after: PathIndex,
): { text: string; changes: Array<{ from: string; to: string }> } {
  const tokens = scanPathTokens(text)
  const changes: Array<{ from: string; to: string }> = []
  let out = ''
  let at = 0
  for (const t of tokens) {
    if (t.start < at) continue
    const next = rewriteRef(t.path, rules, after)
    if (next === undefined) continue
    out += text.slice(at, t.start) + (t.encoded ? encodeURIComponent(next) : next)
    at = t.end
    changes.push({ from: t.path, to: next })
  }
  return { text: out + text.slice(at), changes }
}
