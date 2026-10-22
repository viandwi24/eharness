/**
 * Moves and references of an import (a library or memory reorganization made offline):
 *
 *  - `planMoves`: the moves the zip carries. Stated ones come from `migrations/moves.json` (a file or a
 *    folder prefix); the others are found by content: a file here that is missing from the zip, whose
 *    bytes equal a file of the zip that is new here, was moved. A move keeps the file (its history
 *    follows it) instead of deleting one and adding another.
 *  - the reference check: every library or memory path that programs (authority globs, deliverables,
 *    brief and notes files), standing orders (refs, ledger), memory notes, reminders and API agent
 *    folder grants name, before and after the planned changes, and the rewrite that points the
 *    dangling ones to where the moves put them.
 */
import {
  isUnderPrefix,
  livePathOfMove,
  MOVES_FILE,
  type MoveRule,
  mapRef,
  type PathIndex,
  parseMovesFile,
  refExists,
  rewriteRef,
  scanPathTokens,
} from '../domain/library-moves.ts'
import {
  classify,
  fileOfEntry,
  type RefIssue,
  TOOL_MEDIA_PREFIX,
  textOf,
} from '../domain/workspace-export.ts'

export interface PlannedMove {
  /** `move:<from>`: the key of the preview item. */
  key: string
  rule: MoveRule
  source: 'moves.json' | 'detected'
  note?: string
  /** The files it moves, in library paths (a folder: every file below it). */
  files: Array<{ from: string; to: string }>
  section: 'library' | 'memory'
}

export interface MovePlan {
  moves: PlannedMove[]
  /** Library path of a moved file now -> where it goes. */
  fileMap: Map<string, string>
  /** Where a moved file goes -> where it is now. */
  targetMap: Map<string, string>
  /** What was wrong with entries of `moves.json`, and moves that could not be planned. */
  problems: string[]
}

export interface PlanMovesInput {
  /** The entries of the zip. */
  zip: ReadonlyMap<string, Uint8Array>
  /** The live files by library path (tool media left out). */
  live: ReadonlyMap<string, { size: number }>
  readLive(path: string): Promise<Uint8Array | undefined>
  idBySlug: ReadonlyMap<string, string>
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The sha256 of some bytes, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

const sectionOfPath = (path: string): 'library' | 'memory' =>
  path.startsWith('/memories/') ? 'memory' : 'library'

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export async function planMoves(input: PlanMovesInput): Promise<MovePlan> {
  const { zip, live, idBySlug } = input
  const problems: string[] = []
  const moves: PlannedMove[] = []
  const fileMap = new Map<string, string>()
  const targetMap = new Map<string, string>()

  // the live path of every file of the zip
  const zipPaths = new Map<string, string>()
  for (const entry of zip.keys()) {
    if (classify(entry)?.kind !== 'file') continue
    const path = fileOfEntry(entry, idBySlug)
    if (path === undefined || path.startsWith(`${TOOL_MEDIA_PREFIX}/`)) continue
    zipPaths.set(path, entry)
  }
  const knownIds = new Set(idBySlug.values())

  const claim = (from: string, to: string): string | undefined => {
    if (live.has(to) || targetMap.has(to)) return `${to} is taken (a file is there)`
    if (fileMap.has(from)) return `${from} is already moved by another entry`
    return undefined
  }

  // 1. the moves the owner stated
  const movesFile = zip.get(MOVES_FILE)
  if (movesFile !== undefined) {
    const parsed = parseMovesFile(textOf(movesFile))
    problems.push(...parsed.problems)
    for (const raw of parsed.moves) {
      const from = livePathOfMove(raw.from, idBySlug, knownIds)
      const to = livePathOfMove(raw.to, idBySlug, knownIds)
      if ('error' in from || 'error' in to) {
        problems.push(
          `move ${raw.from} → ${raw.to}: ${'error' in from ? from.error : (to as { error: string }).error}`,
        )
        continue
      }
      if (from.path.endsWith('/') !== to.path.endsWith('/')) {
        problems.push(
          `move ${raw.from} → ${raw.to}: both ends must be a folder (end with /) or both a file`,
        )
        continue
      }
      if (from.path === to.path) continue
      const folder = from.path.endsWith('/')
      if (folder && to.path.startsWith(from.path)) {
        problems.push(`move ${raw.from} → ${raw.to}: a folder cannot move into itself`)
        continue
      }
      const files: Array<{ from: string; to: string }> = []
      if (!folder) {
        if (!live.has(from.path)) {
          problems.push(`move ${raw.from}: no such file here: skipped`)
          continue
        }
        if (zipPaths.has(from.path)) {
          problems.push(`move ${raw.from}: the file is still in the zip, so it is not moved`)
          continue
        }
        const why = claim(from.path, to.path)
        if (why !== undefined) {
          problems.push(`move ${raw.from} → ${raw.to}: ${why}`)
          continue
        }
        files.push({ from: from.path, to: to.path })
      } else {
        for (const path of [...live.keys()].sort()) {
          if (!isUnderPrefix(path, from.path) || zipPaths.has(path)) continue
          const target = to.path + path.slice(from.path.length)
          const why = claim(path, target)
          if (why !== undefined) {
            problems.push(`move ${path} → ${target}: ${why}`)
            continue
          }
          fileMap.set(path, target)
          targetMap.set(target, path)
          files.push({ from: path, to: target })
        }
        if (files.length === 0) {
          problems.push(`move ${raw.from}: no file of this folder is here: skipped`)
          continue
        }
      }
      for (const f of files) {
        fileMap.set(f.from, f.to)
        targetMap.set(f.to, f.from)
      }
      moves.push({
        key: `move:${from.path}`,
        rule: { from: from.path, to: to.path, kind: folder ? 'prefix' : 'file' },
        source: 'moves.json',
        ...(raw.note === undefined ? {} : { note: raw.note }),
        files,
        section: sectionOfPath(from.path),
      })
    }
  }

  // 2. moves found by content: a file here that the zip no longer has, and the same bytes in a new file
  const liveOnly = [...live.entries()].filter(
    ([path, meta]) => !zipPaths.has(path) && !fileMap.has(path) && meta.size > 0,
  )
  const zipNew = [...zipPaths.entries()].filter(
    ([path]) =>
      !live.has(path) &&
      !targetMap.has(path) &&
      (zip.get(zipPaths.get(path) as string)?.byteLength ?? 0) > 0,
  )
  if (liveOnly.length > 0 && zipNew.length > 0) {
    const bySize = new Map<number, string[]>()
    for (const [path, meta] of liveOnly) {
      bySize.set(meta.size, [...(bySize.get(meta.size) ?? []), path])
    }
    const candidates = zipNew.filter(([, entry]) =>
      bySize.has((zip.get(entry) as Uint8Array).byteLength),
    )
    const liveByHash = new Map<string, string[]>()
    const zipByHash = new Map<string, string[]>()
    const wantedSizes = new Set(
      candidates.map(([, entry]) => (zip.get(entry) as Uint8Array).byteLength),
    )
    for (const size of wantedSizes) {
      for (const path of bySize.get(size) ?? []) {
        const bytes = await input.readLive(path)
        if (bytes === undefined) continue
        const h = await sha256Hex(bytes)
        liveByHash.set(h, [...(liveByHash.get(h) ?? []), path])
      }
    }
    for (const [path, entry] of candidates) {
      const h = await sha256Hex(zip.get(entry) as Uint8Array)
      if (liveByHash.has(h)) zipByHash.set(h, [...(zipByHash.get(h) ?? []), path])
    }
    for (const [h, targets] of [...zipByHash.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const sources = [...(liveByHash.get(h) ?? [])].sort()
      const left = [...targets].sort()
      // the same bytes under the same file name first, then in path order
      for (const to of [...left]) {
        const i = sources.findIndex((s) => baseName(s) === baseName(to))
        if (i < 0) continue
        const from = sources.splice(i, 1)[0] as string
        left.splice(left.indexOf(to), 1)
        pairDetected(from, to)
      }
      // several equal files: only a one-to-one rest is certain enough to call a move
      if (sources.length === 1 && left.length === 1) {
        pairDetected(sources[0] as string, left[0] as string)
      }
    }
  }
  function pairDetected(from: string, to: string): void {
    if (fileMap.has(from) || targetMap.has(to)) return
    fileMap.set(from, to)
    targetMap.set(to, from)
    moves.push({
      key: `move:${from}`,
      rule: { from, to, kind: 'file' },
      source: 'detected',
      files: [{ from, to }],
      section: sectionOfPath(from),
    })
  }

  return { moves, fileMap, targetMap, problems }
}

// --- references --------------------------------------------------------------------------------------

export interface RefSource {
  owner: string
  where: string
  ref: string
  kind: RefIssue['kind']
}

/** The library paths a program names: authority globs, deliverables and the files of its brief and notes. */
export function programRefs(
  owner: string,
  p: {
    authority: { read: readonly string[]; write: readonly string[] }
    deliverables: ReadonlyArray<{ path?: unknown }>
    briefPath: string | null | undefined
    notesPath: string | null | undefined
  },
): RefSource[] {
  const out: RefSource[] = []
  const add = (where: string, ref: unknown): void => {
    if (typeof ref === 'string' && ref.startsWith('/'))
      out.push({ owner, where, ref, kind: 'program' })
  }
  for (const r of p.authority.read) add('authority.read', r)
  for (const w of p.authority.write) add('authority.write', w)
  for (const d of p.deliverables) add('deliverable', d.path)
  add('brief file', p.briefPath)
  add('notes file', p.notesPath)
  return out
}

/** The library paths a text names (a memory note, a standing order of HEARTBEAT.md, a reminder). */
export function textRefs(
  owner: string,
  kind: RefIssue['kind'],
  where: string,
  text: string,
): RefSource[] {
  const seen = new Set<string>()
  const out: RefSource[] = []
  for (const t of scanPathTokens(text)) {
    if (seen.has(t.path)) continue
    seen.add(t.path)
    out.push({ owner, where, ref: t.path, kind })
  }
  return out
}

export interface RefCheck {
  checked: number
  dangling: RefIssue[]
  atRisk: RefIssue[]
  rewritable: number
}

/**
 * What the planned changes break. A reference is dangling when it points to nothing after them but
 * did before (or a move names it); at risk when only a file that "remove what is not in the zip"
 * would delete keeps it alive.
 */
export function checkRefs(
  refs: readonly RefSource[],
  indexes: { before: PathIndex; after: PathIndex; afterRemoved: PathIndex },
  rules: readonly MoveRule[],
): RefCheck {
  const dangling: RefIssue[] = []
  const atRisk: RefIssue[] = []
  let rewritable = 0
  const seen = new Set<string>()
  for (const r of refs) {
    const id = `${r.owner}\u0000${r.where}\u0000${r.ref}`
    if (seen.has(id)) continue
    seen.add(id)
    if (!refExists(r.ref, indexes.after)) {
      if (refExists(r.ref, indexes.before) || mapRef(r.ref, rules) !== undefined) {
        const suggestion = rewriteRef(r.ref, rules, indexes.after) ?? null
        dangling.push({ ...r, suggestion })
        if (suggestion !== null && r.kind !== 'reminder') rewritable++
      }
    } else if (!refExists(r.ref, indexes.afterRemoved)) {
      atRisk.push({ ...r, suggestion: null })
    }
  }
  return { checked: seen.size, dangling, atRisk, rewritable }
}
