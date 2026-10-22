/**
 * The shape of the library (docs/plans/P57-library-structure.md). The library is the source of
 * truth for facts; agent memory keeps short rules and an index that points into it.
 *
 *   /library/company/      profile, organization structure, people and roles, SOPs and rules
 *   /library/programs/<slug>/brief.md   the program's instructions (read at every run)
 *   /library/programs/<slug>/notes.md   agreements and notes of the program
 *   /library/knowledge/    topic knowledge
 *   /library/reports/      dated reports
 *   /library/data/         trackers, ledgers, sheets
 *   /library/archive/memory/<agent>/    memory files retired by a reorganization
 *   /memories/agents/<agent>/rules.md, index.md, HEARTBEAT.md   memory
 *
 * Pure: path conventions, the memory-file proposal (parse, deterministic checks, the plan with the
 * new rules.md and index.md) and the guard that keeps long reports out of memory.
 */
import { invalid } from './errors.ts'
import { LIBRARY_ROOT } from './library.ts'
import { MOVED_PATHS_RULE } from './library-moves.ts'
import { hasControlOrBackslash } from './text.ts'
import { journalProtocol, WORKS_ROOT_DEFAULT } from './works-journal.ts'

export const COMPANY_DIR = `${LIBRARY_ROOT}/company`
export const PROGRAMS_DIR = `${LIBRARY_ROOT}/programs`
export const KNOWLEDGE_DIR = `${LIBRARY_ROOT}/knowledge`
export const REPORTS_DIR = `${LIBRARY_ROOT}/reports`
export const DATA_DIR = `${LIBRARY_ROOT}/data`
export const ARCHIVE_MEMORY_DIR = `${LIBRARY_ROOT}/archive/memory`

/** The folders of the structure, as the library page and the instructions name them. */
export const LIBRARY_FOLDERS: ReadonlyArray<{ path: string; holds: string }> = [
  {
    path: `${COMPANY_DIR}/`,
    holds: 'profile, organization structure, people and roles, SOPs and rules',
  },
  { path: `${PROGRAMS_DIR}/<program>/`, holds: 'brief.md and notes.md of each program' },
  { path: `${KNOWLEDGE_DIR}/`, holds: 'topic knowledge' },
  { path: `${REPORTS_DIR}/`, holds: 'dated reports' },
  { path: `${DATA_DIR}/`, holds: 'trackers, ledgers, sheets' },
]

export const RULES_FILE = 'rules.md'
export const INDEX_FILE = 'index.md'
/** Memory files a reorganization never touches (the heartbeat reads and writes this one). */
export const HEARTBEAT_FILE = 'HEARTBEAT.md'

// --- program files -------------------------------------------------------------------------------

/** `Daily Report!` -> `daily-report`; never empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug === '' ? 'program' : slug
}

export const programBriefPath = (slug: string): string => `${PROGRAMS_DIR}/${slug}/brief.md`
export const programNotesPath = (slug: string): string => `${PROGRAMS_DIR}/${slug}/notes.md`

/** A program file path is a file under `/library/programs/`, nothing else (checked at save). */
export function checkProgramFilePath(path: string, what: 'brief' | 'notes'): string {
  const segments = path.split('/').slice(1)
  const ok =
    path.startsWith(`${PROGRAMS_DIR}/`) &&
    path.length <= 300 &&
    segments.length >= 3 &&
    segments.every((s) => s !== '' && s !== '.' && s !== '..' && !hasControlOrBackslash(s))
  if (!ok) {
    throw invalid(
      `${what}Path must be a file under ${PROGRAMS_DIR}/<program>/, for example ${programBriefPath('my-program')}`,
      'INVALID_PROGRAM',
    )
  }
  return path
}

/** Notes as a file: one `- ` bullet each, under a heading. */
export function notesToFile(name: string, notes: readonly string[]): string {
  const head = `# Agreements: ${name}\n\nAgreed with the client for this program. Every run follows them. They never grant authority or lift a gate.\n\n`
  return `${head}${notes.map((n) => `- ${n.replace(/\n+/g, ' ')}`).join('\n')}\n`
}

/** The notes of a file: bullet lines; a file without bullets is read as one note per paragraph. */
export function notesFromFile(text: string): string[] {
  const bullets = text
    .split('\n')
    .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined)
  if (bullets.length > 0) return [...new Set(bullets)]
  return [
    ...new Set(
      text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p !== '' && !p.startsWith('#')),
    ),
  ]
}

// --- memory reorganization -----------------------------------------------------------------------

export const REORG_ACTIONS = ['keep-as-rule', 'move', 'merge-into', 'archive'] as const
export type ReorgAction = (typeof REORG_ACTIONS)[number]

/** One memory file and what to do with it. `target` is a library path (move) or a source path (merge-into). */
export interface ReorgRow {
  /** Relative to the agent memory root, e.g. `notes/ads.md`. */
  source: string
  action: ReorgAction
  /** move: an absolute library path; merge-into: the relative path of another memory file; else null. */
  target: string | null
  reason: string
}

export interface ReorgSourceFile {
  path: string
  text: string | null
  version: string
  size: number
}

export interface ReorgIssue {
  source: string
  level: 'error' | 'note'
  message: string
}

export interface ReorgPlanRow extends ReorgRow {
  /** Where the content ends up: the library path, `rules.md`, or the archive path. */
  finalTarget: string
  /** Where the untouched original is kept for 30 days. */
  originalPath: string
}

export interface ReorgPlan {
  agentSlug: string
  rows: ReorgPlanRow[]
  issues: ReorgIssue[]
  /** True when no `error` issue remains: the plan can be applied. */
  ok: boolean
  /** Where the old rules.md and index.md are kept when they are rewritten. */
  originals: { rules: string; index: string }
  rules: { before: string; after: string }
  index: { before: string; after: string }
  /** Library files to create (path -> text), in write order. */
  writes: Array<{ path: string; text: string }>
}

export const originalsDir = (agentSlug: string): string =>
  `${ARCHIVE_MEMORY_DIR}/${agentSlug}/original`
export const archiveDir = (agentSlug: string): string => `${ARCHIVE_MEMORY_DIR}/${agentSlug}`

const DATED = /(?:^|[^0-9])(20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^0-9]|$)/
/** A file name that is a dated report (`2026-10-03-ads.md`, `ads_20261003.md`, `daily-report`). */
export const isDatedReportName = (relPath: string): boolean => {
  const name = relPath.split('/').pop() ?? relPath
  return DATED.test(name) || /^(daily|weekly|monthly)[-_ ]?(report|summary)/i.test(name)
}

const clean = (s: string): string =>
  [...s]
    .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .join('')
    .trim()

/** A library path inside the structure; the error says why not. */
export function checkLibraryTarget(
  raw: string,
): { ok: true; path: string } | { ok: false; why: string } {
  if (!raw.startsWith(`${LIBRARY_ROOT}/`))
    return { ok: false, why: `must be inside ${LIBRARY_ROOT}/` }
  const segments = raw.split('/').slice(1)
  if (segments.some((s) => s === '' || s === '.' || s === '..' || hasControlOrBackslash(s))) {
    return { ok: false, why: 'is not a clean path' }
  }
  if (raw.length > 400) return { ok: false, why: 'is too long' }
  if (raw.startsWith(`${ARCHIVE_MEMORY_DIR}/`)) {
    return { ok: false, why: 'is the archive: use the archive action instead' }
  }
  if (raw.startsWith(`${LIBRARY_ROOT}/.eharness/`)) {
    return { ok: false, why: 'is an internal folder' }
  }
  return { ok: true, path: raw }
}

/**
 * Read the model's proposal: a JSON array (possibly in a code fence, possibly under a `files` key)
 * of `{ file, action, target, reason }`. Files the model skipped, or rows it got wrong, fall back to
 * a safe move into `knowledge/` (nothing is dropped); unknown files in the answer are ignored.
 */
export function parseProposal(text: string, files: readonly string[]): ReorgRow[] {
  const found = new Map<string, ReorgRow>()
  let list: unknown[] = []
  const body = text.replace(/```(?:json)?/gi, '').trim()
  const opens = [body.indexOf('['), body.indexOf('{')].filter((i) => i >= 0)
  const start = opens.length === 0 ? -1 : Math.min(...opens)
  if (start >= 0) {
    const close = body[start] === '[' ? ']' : '}'
    for (let end = body.lastIndexOf(close); end > start; end = body.lastIndexOf(close, end - 1)) {
      try {
        const parsed: unknown = JSON.parse(body.slice(start, end + 1))
        const inner = Array.isArray(parsed)
          ? parsed
          : ((parsed as Record<string, unknown> | null)?.files ??
            (parsed as Record<string, unknown> | null)?.rows)
        if (Array.isArray(inner)) list = inner
        break
      } catch {
        // a shorter slice: the answer may have text after the JSON
      }
    }
  }
  const known = new Set(files)
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const source =
      typeof r.file === 'string' ? r.file : typeof r.source === 'string' ? r.source : ''
    const rel = source.replace(/^\/+/, '').replace(/^memories\/agents\/[^/]+\//, '')
    if (!known.has(rel) || found.has(rel)) continue
    const action = (REORG_ACTIONS as readonly string[]).includes(String(r.action))
      ? (r.action as ReorgAction)
      : undefined
    if (action === undefined) continue
    const target = typeof r.target === 'string' && r.target.trim() !== '' ? r.target.trim() : null
    found.set(rel, {
      source: rel,
      action,
      target: action === 'move' || action === 'merge-into' ? target : null,
      reason: clean(typeof r.reason === 'string' ? r.reason : '').slice(0, 200),
    })
  }
  return files.map(
    (f): ReorgRow =>
      found.get(f) ?? {
        source: f,
        action: 'move',
        target: `${KNOWLEDGE_DIR}/${f.split('/').pop()}`,
        reason: 'no proposal for this file: kept as knowledge, nothing is lost',
      },
  )
}

const withSuffix = (path: string, n: number): string => {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash ? `${path.slice(0, dot)}-${n}${path.slice(dot)}` : `${path}-${n}`
}

const section = (title: string, text: string): string => `\n\n## ${title}\n\n${text.trim()}\n`

/**
 * The deterministic checks and the plan. The rows come from the model or from the owner's edits;
 * nothing here trusts them:
 *  - a move target stays inside `/library` (and outside the archive and internal folders),
 *  - a move never overwrites an existing library file or another move (a numeric suffix is added),
 *  - a dated report goes to `/library/reports/`,
 *  - a merge-into names another file of this batch and never forms a loop,
 *  - `HEARTBEAT.md` is left alone; `rules.md` and `index.md` are rewritten, their old text kept
 *    in the plan (`rules.before`) and in the originals folder.
 * Every source ends up in the originals folder, so no byte is lost.
 */
export function buildReorgPlan(input: {
  agentSlug: string
  agentId: string
  files: readonly ReorgSourceFile[]
  rows: readonly ReorgRow[]
  /** Paths that exist in the library now (anything a move could overwrite). */
  libraryPaths: ReadonlySet<string>
}): ReorgPlan {
  const { agentSlug } = input
  const issues: ReorgIssue[] = []
  const issue = (source: string, level: ReorgIssue['level'], message: string): void => {
    issues.push({ source, level, message })
  }
  const byPath = new Map(input.files.map((f) => [f.path, f]))
  const rulesBefore = byPath.get(RULES_FILE)?.text ?? ''
  const indexBefore = byPath.get(INDEX_FILE)?.text ?? ''
  const taken = new Set(input.libraryPaths)
  const reserved = new Set<string>()
  const rows = new Map<string, ReorgRow>()
  for (const r of input.rows) if (byPath.has(r.source) && !rows.has(r.source)) rows.set(r.source, r)

  // 1. one row per movable file; the kept files stay out
  const work = input.files.filter(
    (f) => f.path !== HEARTBEAT_FILE && f.path !== RULES_FILE && f.path !== INDEX_FILE,
  )
  const resolved: ReorgPlanRow[] = []
  const finalOf = new Map<string, string>()

  const pickQuiet = (wanted: string): string => {
    let path = wanted
    for (let n = 2; taken.has(path) || reserved.has(path); n++) path = withSuffix(wanted, n)
    reserved.add(path)
    return path
  }
  const pick = (wanted: string, source: string): string => {
    const path = pickQuiet(wanted)
    if (path !== wanted)
      issue(source, 'note', `${wanted} exists: this one is written to ${path} instead`)
    return path
  }

  for (const f of work) {
    let row: ReorgRow = rows.get(f.path) ?? {
      source: f.path,
      action: 'move',
      target: `${KNOWLEDGE_DIR}/${f.path.split('/').pop()}`,
      reason: 'no row for this file: kept as knowledge, nothing is lost',
    }
    if (row.action === 'merge-into' && (row.target ?? '').replace(/^\/+/, '') === RULES_FILE) {
      row = { ...row, action: 'keep-as-rule', target: null }
    }
    if (f.text === null && row.action !== 'archive') {
      issue(f.path, 'note', 'this file is binary: it is archived, not moved')
      row = { ...row, action: 'archive', target: null }
    }
    // a file that is empty has nothing to move: archive it
    if (row.action === 'move' && isDatedReportName(f.path)) {
      const name = f.path.split('/').pop() as string
      const wantsReports = (row.target ?? '').startsWith(`${REPORTS_DIR}/`)
      if (!wantsReports) {
        issue(f.path, 'note', `a dated report goes to ${REPORTS_DIR}/`)
        row = { ...row, target: `${REPORTS_DIR}/${name}` }
      }
    }
    const original =
      row.action === 'archive' ? '' : pickQuiet(`${originalsDir(agentSlug)}/${f.path}`)
    if (row.action === 'keep-as-rule') {
      resolved.push({
        ...row,
        target: null,
        finalTarget: `memory:${RULES_FILE}`,
        originalPath: original,
      })
    } else if (row.action === 'archive') {
      const to = pick(`${archiveDir(agentSlug)}/${f.path}`, f.path)
      // the archived file is itself the kept original (no second copy)
      resolved.push({ ...row, target: null, finalTarget: to, originalPath: to })
    } else if (row.action === 'merge-into') {
      resolved.push({ ...row, finalTarget: '', originalPath: original })
    } else {
      const checked = checkLibraryTarget(row.target ?? '')
      if (!checked.ok) {
        issue(f.path, 'error', `target ${row.target ?? '(none)'} ${checked.why}`)
        resolved.push({ ...row, finalTarget: '', originalPath: original })
      } else {
        resolved.push({
          ...row,
          target: checked.path,
          finalTarget: pick(checked.path, f.path),
          originalPath: original,
        })
      }
    }
  }
  for (const r of resolved) if (r.finalTarget !== '') finalOf.set(r.source, r.finalTarget)

  // 2. merges follow their target to its final place; a chain is followed, a loop is an error
  for (const r of resolved) {
    if (r.action !== 'merge-into') continue
    const seen = new Set<string>([r.source])
    let next = (r.target ?? '').replace(/^\/+/, '')
    let ok = false
    while (next !== '') {
      if (seen.has(next)) {
        issue(r.source, 'error', 'the merge targets form a loop')
        break
      }
      seen.add(next)
      const hit = resolved.find((x) => x.source === next)
      if (hit === undefined) {
        issue(r.source, 'error', `merge target ${r.target ?? '(none)'} is not a file of this batch`)
        break
      }
      if (hit.action !== 'merge-into') {
        if (hit.action === 'archive' || hit.action === 'keep-as-rule') {
          issue(
            r.source,
            'error',
            `merge target ${next} is ${hit.action === 'archive' ? 'archived' : 'merged into rules.md'}: merge into a file that moves, or use keep-as-rule`,
          )
        } else if (hit.finalTarget === '')
          issue(r.source, 'error', `merge target ${next} has no valid place`)
        else {
          r.finalTarget = hit.finalTarget
          ok = true
        }
        break
      }
      next = (hit.target ?? '').replace(/^\/+/, '')
    }
    if (!ok) r.finalTarget = ''
  }

  // 3. contents: the library files, the new rules.md
  const text = (path: string): string => byPath.get(path)?.text ?? ''
  const written = new Map<string, string>()
  const mergedInto = new Map<string, ReorgPlanRow[]>()
  for (const r of resolved) {
    if (r.finalTarget === '' || r.finalTarget.startsWith('memory:')) continue
    if (r.action === 'move') written.set(r.finalTarget, text(r.source))
    else if (r.action === 'merge-into') {
      mergedInto.set(r.finalTarget, [...(mergedInto.get(r.finalTarget) ?? []), r])
    }
  }
  for (const [path, list] of mergedInto) {
    let body = written.get(path) ?? ''
    for (const r of list) body += section(`Merged from memory file ${r.source}`, text(r.source))
    written.set(path, body.replace(/^\n+/, ''))
  }
  let rulesAfter = rulesBefore.trimEnd()
  for (const r of resolved) {
    if (r.action === 'keep-as-rule')
      rulesAfter +=
        rulesAfter === ''
          ? `# Rules\n${section(`From ${r.source}`, text(r.source))}`
          : section(`From ${r.source}`, text(r.source))
  }
  rulesAfter = rulesAfter === '' ? '' : `${rulesAfter.trimEnd()}\n`
  const writes: Array<{ path: string; text: string }> = [...written].map(([path, body]) => ({
    path,
    text: body,
  }))

  const indexAfter = buildIndex(agentSlug, resolved, indexBefore)
  return {
    agentSlug,
    rows: resolved,
    issues,
    ok: !issues.some((i) => i.level === 'error'),
    originals: {
      rules: pickQuiet(`${originalsDir(agentSlug)}/${RULES_FILE}`),
      index: pickQuiet(`${originalsDir(agentSlug)}/${INDEX_FILE}`),
    },
    rules: { before: rulesBefore, after: rulesAfter === '' ? rulesBefore : rulesAfter },
    index: { before: indexBefore, after: indexAfter },
    writes,
  }
}

/** `index.md`: where things are in the library now; short, one line per place. */
function buildIndex(agentSlug: string, rows: readonly ReorgPlanRow[], before: string): string {
  const lines: string[] = [
    '# Index',
    '',
    'Memory keeps short rules (rules.md) and this index. Facts live in the library: read the file named here, do not guess.',
    '',
  ]
  const places = new Map<string, string[]>()
  for (const r of rows) {
    if (r.finalTarget === '' || r.finalTarget.startsWith('memory:')) continue
    const list = places.get(r.finalTarget) ?? []
    list.push(r.reason !== '' ? r.reason : r.source)
    places.set(r.finalTarget, list)
  }
  const area = (p: string): string =>
    p.startsWith(`${ARCHIVE_MEMORY_DIR}/`)
      ? 'Archived (stale, kept)'
      : p.startsWith(`${COMPANY_DIR}/`)
        ? 'Company'
        : p.startsWith(`${KNOWLEDGE_DIR}/`)
          ? 'Knowledge'
          : p.startsWith(`${REPORTS_DIR}/`)
            ? 'Reports'
            : p.startsWith(`${DATA_DIR}/`)
              ? 'Data'
              : p.startsWith(`${PROGRAMS_DIR}/`)
                ? 'Programs'
                : 'Library'
  const grouped = new Map<string, string[]>()
  for (const [path, reasons] of [...places].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const g = grouped.get(area(path)) ?? []
    g.push(`- ${path}: ${reasons.join('; ').slice(0, 160)}`)
    grouped.set(area(path), g)
  }
  for (const [name, items] of grouped) lines.push(`## ${name}`, ...items, '')
  const rules = rows.filter((r) => r.action === 'keep-as-rule')
  if (rules.length > 0) lines.push('## Rules', `- rules.md: ${rules.length} note(s) merged in.`, '')
  lines.push(
    `## Originals`,
    `- ${originalsDir(agentSlug)}/: the untouched memory files from this reorganization, kept for 30 days.`,
  )
  if (before.trim() !== '') lines.push('', '## Previous index', '', before.trim())
  return `${lines.join('\n')}\n`
}

// --- memory discipline ---------------------------------------------------------------------------

/** A memory write longer than this is a report, not a rule. */
export const MEMORY_WRITE_MAX_CHARS = 2_500

const MEMORY_FILES_EXEMPT: readonly string[] = [HEARTBEAT_FILE]

/**
 * A readable refusal when a memory write creates a dated file or writes a long text, else
 * undefined: reports, trackers and facts belong in the library (`/library/reports/`, `/library/data/`,
 * `/library/knowledge/`), memory keeps short rules and an index.
 */
export function memoryReportRefusal(toolName: string, input: unknown): string | undefined {
  if (!['memory_create', 'memory_str_replace', 'memory_insert', 'memory'].includes(toolName)) {
    return undefined
  }
  if (typeof input !== 'object' || input === null) return undefined
  const rec = input as Record<string, unknown>
  const command = typeof rec.command === 'string' ? rec.command : toolName.replace('memory_', '')
  if (!['create', 'str_replace', 'insert'].includes(command)) return undefined
  const path = typeof rec.path === 'string' ? rec.path : ''
  const name = path.split('/').pop() ?? ''
  if (MEMORY_FILES_EXEMPT.includes(name)) return undefined
  const text = ['file_text', 'new_str', 'insert_text', 'text', 'content']
    .map((f) => (typeof rec[f] === 'string' ? (rec[f] as string) : ''))
    .join('\n')
  const tail =
    'Memory keeps short rules (rules.md) and an index (index.md) only. Write the report to /library/reports/ (a dated file name is fine there), a tracker or ledger to /library/data/, a fact or topic note to /library/knowledge/ or /library/company/, and add one line to index.md saying where it is. Do not mention this refusal to the people in the chat.'
  if (command === 'create' && isDatedReportName(path)) {
    return `Not saved: ${name} is a dated file. ${tail}`
  }
  if (text.length > MEMORY_WRITE_MAX_CHARS) {
    return `Not saved: this note is ${text.length} characters, too long for memory. ${tail}`
  }
  return undefined
}

/**
 * The memory instruction every agent gets (the memory plugin's protocol): memory holds short rules
 * and an index only; facts are in the library. Static text (prompt-cache prefix).
 */
export const teamMemoryProtocol = (
  worksRoot: string,
): string => `You have a small persistent memory (the memory tools). It holds only two things: short standing rules in rules.md, and an index in index.md that says where things are in the library. It is not a notebook.
- Facts live in the library, which is the source of truth. Before you answer or act on a fact (the company, people and roles, procedures, a topic, a tracker), read the library file: ${COMPANY_DIR}/ (profile, organization, people and roles, SOPs and rules), ${KNOWLEDGE_DIR}/ (topics), ${DATA_DIR}/ (trackers, ledgers, sheets), ${PROGRAMS_DIR}/<program>/ (brief.md and notes.md of a program). Read index.md first to find the file.
- Write to memory only a short rule or preference that you must follow every time, and one line in index.md when you create or move a library file. Keep both small. Never write a report, a dated file, a table of data or a long note to memory: reports go to ${REPORTS_DIR}/, data to ${DATA_DIR}/, knowledge to ${KNOWLEDGE_DIR}/.
- Update or remove outdated lines instead of appending duplicates. Never store secrets or credentials in memory. Assume your context may be reset: a rule you did not write down can be lost, a fact you did not save in the library can be lost.
- ${MOVED_PATHS_RULE}
${journalProtocol(worksRoot)}`

/** The protocol with the default works folder (tests, and a server that was not given a setting). */
export const TEAM_MEMORY_PROTOCOL = teamMemoryProtocol(WORKS_ROOT_DEFAULT)
