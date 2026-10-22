#!/usr/bin/env bun
/**
 * Validates an unzipped workspace export after a reorganization (see REORGANIZE.md).
 *
 *   bun tools/reorganize/validate.ts <unzipped workspace folder>
 *
 * No dependencies. Errors make the exit code 1; warnings and notes never do. Checks:
 *  - manifest.json and settings.json are present, every JSON file parses
 *  - agents/<slug>/agent.json exists for each agent folder, each program has its .brief.md
 *  - migrations/moves.json is well formed; every `to` exists and no `from` still exists
 *  - every library path that programs, standing orders, memory and API agents point at resolves
 *    (a glob resolves when the folder of its static prefix exists or is declared by a move)
 *  - no secret in plain text, and secrets.enc.json parses
 *  - memory per agent stays small (rules.md, index.md, HEARTBEAT.md)
 *  - files outside the target structure are listed as warnings
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Level = 'error' | 'warning' | 'info'
export interface Finding {
  level: Level
  where: string
  message: string
}
export interface Report {
  findings: Finding[]
  errors: number
  warnings: number
  files: number
}

/** Limits of memory per agent (characters). HEARTBEAT.md is exempt: it holds the standing orders. */
export const MEMORY_LIMITS = { rules: 8_000, index: 8_000, otherFiles: 0 } as const
export const MEMORY_FILES = ['rules.md', 'index.md', 'HEARTBEAT.md'] as const
export const MOVES_FILE = 'migrations/moves.json'
/** Top level folders of a company folder in the target structure. */
export const COMPANY_PARTS = [
  'profile.md',
  'organization.md',
  'divisions',
  'kpi',
  'reports',
  'attendance',
  'knowledge',
  'works',
  'archive',
] as const

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/],
]
const SECRET_KEY = /secret|token|password|api[-_]?key|credential|authorization/i

// --- reading the folder --------------------------------------------------------------------------

function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path, base))
    else out.push(relative(base, path).split(sep).join('/'))
  }
  return out.sort()
}

const isText = (path: string): boolean => /\.(md|json|txt|csv|ya?ml|html?)$/i.test(path)

// --- paths ---------------------------------------------------------------------------------------

/** `/library/a/b` -> `library/a/b` (a zip entry), undefined for a path outside library and uploads. */
export function entryOf(path: string): string | undefined {
  const p = path.replace(/^\/+/, '')
  return p.startsWith('library/') || p.startsWith('uploads/') ? p : undefined
}

/** Library paths named in free text (a trailing punctuation mark is not part of the path). */
export function libraryPathsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.-])\/library\/[^\s)>\]"'`,;|]+/g)) {
    out.add(m[0].replace(/[.:!?]+$/, ''))
  }
  return [...out]
}

/** The static part of a glob or token path: up to the first wildcard, token or placeholder. */
export function staticPrefix(path: string): { prefix: string; dynamic: boolean } {
  const at = path.search(/[*?[{<]|YYYY|MM\b|DD\b|Www/)
  return at < 0 ? { prefix: path, dynamic: false } : { prefix: path.slice(0, at), dynamic: true }
}

// --- the validator -------------------------------------------------------------------------------

interface Move {
  from: string
  to: string
  note?: string
}

export function validateWorkspace(dir: string): Report {
  const findings: Finding[] = []
  const add = (level: Level, where: string, message: string): void => {
    findings.push({ level, where, message })
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    add('error', dir, 'not a folder')
    return summarize(findings, 0)
  }
  const files = walk(dir)
  const fileSet = new Set(files)
  const read = (path: string): string => readFileSync(join(dir, path), 'utf8')
  const json = (path: string): unknown => {
    try {
      return JSON.parse(read(path))
    } catch (error) {
      add('error', path, `invalid JSON: ${(error as Error).message}`)
      return undefined
    }
  }
  const obj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  // required files, JSON that parses
  for (const required of ['manifest.json', 'settings.json']) {
    if (!fileSet.has(required)) add('error', required, 'required file is missing')
  }
  const parsed = new Map<string, unknown>()
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    // a JSON file of the library is the owner's content: broken JSON there is a warning only
    if (f.startsWith('library/') || f.startsWith('uploads/') || f.startsWith('other/')) {
      try {
        JSON.parse(read(f))
      } catch {
        add('warning', f, 'library JSON file does not parse')
      }
      continue
    }
    parsed.set(f, json(f))
  }
  const manifest = obj(parsed.get('manifest.json'))
  if (fileSet.has('manifest.json') && manifest.format !== 'eharness-team-workspace') {
    add('error', 'manifest.json', 'format is not "eharness-team-workspace"')
  }
  if (fileSet.has('secrets.enc.json')) {
    if (obj(parsed.get('secrets.enc.json')).format !== 'eharness-team-secrets') {
      add(
        'error',
        'secrets.enc.json',
        'is not an eharness-team-secrets file (it must stay untouched)',
      )
    }
  }
  // the manifest lists files by hash: pack recomputes it, so a difference is only a note
  const listed = Array.isArray(manifest.files) ? (manifest.files as Array<{ path?: string }>) : []
  const listedPaths = new Set(listed.map((f) => f.path))
  const drift = files.filter((f) => f !== 'manifest.json' && !listedPaths.has(f)).length
  if (drift > 0 || listed.some((f) => typeof f.path === 'string' && !fileSet.has(f.path))) {
    add('info', 'manifest.json', 'file list differs from the folder: `pack.ts` recomputes it')
  }

  // agents, programs
  const slugs = new Set<string>()
  for (const f of files) {
    const m = /^agents\/([^/]+)\//.exec(f)
    if (m !== null) slugs.add(m[1] as string)
  }
  for (const slug of slugs) {
    if (!fileSet.has(`agents/${slug}/agent.json`)) {
      add('error', `agents/${slug}`, 'agent.json is missing')
    }
  }
  for (const f of files) {
    const m = /^agents\/([^/]+)\/programs\/([^/]+)\.json$/.exec(f)
    if (m !== null && !fileSet.has(`agents/${m[1]}/programs/${m[2]}.brief.md`)) {
      add('error', f, `${m[2]}.brief.md is missing next to the program`)
    }
  }

  // moves
  const moves: Move[] = []
  if (fileSet.has(MOVES_FILE)) {
    const raw = json(MOVES_FILE)
    if (!Array.isArray(raw)) add('error', MOVES_FILE, 'must be an array of { from, to, note? }')
    else {
      raw.forEach((m, i) => {
        const o = obj(m)
        const where = `${MOVES_FILE}[${i}]`
        if (typeof o.from !== 'string' || typeof o.to !== 'string') {
          add('error', where, 'needs string "from" and "to"')
          return
        }
        if (!o.from.startsWith('/library/') || !o.to.startsWith('/library/')) {
          add('error', where, '"from" and "to" must start with /library/')
          return
        }
        if (o.from.endsWith('/') !== o.to.endsWith('/')) {
          add('error', where, 'a folder move needs a trailing slash on both "from" and "to"')
          return
        }
        moves.push({
          from: o.from,
          to: o.to,
          ...(typeof o.note === 'string' ? { note: o.note } : {}),
        })
      })
    }
  } else {
    add('info', MOVES_FILE, 'no moves recorded (fine when nothing in library/ was moved)')
  }
  const hasPrefix = (prefix: string): boolean => files.some((f) => f.startsWith(prefix))
  const exists = (path: string): boolean => {
    const entry = entryOf(path)
    if (entry === undefined) return false
    return path.endsWith('/') ? hasPrefix(entry) : fileSet.has(entry) || hasPrefix(`${entry}/`)
  }
  for (const m of moves) {
    if (!exists(m.to)) add('error', MOVES_FILE, `"to" does not exist: ${m.to}`)
    if (exists(m.from))
      add('error', MOVES_FILE, `"from" still exists: ${m.from} (a move leaves nothing behind)`)
  }
  const movedTo = (path: string): string | undefined => {
    for (const m of moves) {
      if (m.from.endsWith('/') ? path.startsWith(m.from) : path === m.from) {
        return m.from.endsWith('/') ? m.to + path.slice(m.from.length) : m.to
      }
    }
    return undefined
  }
  const declared = [
    ...moves.filter((m) => m.to.endsWith('/')).map((m) => m.to),
    ...moves.map((m) => m.to.slice(0, m.to.lastIndexOf('/') + 1)),
  ]
  const settings = obj(obj(parsed.get('settings.json')).settings)
  const worksRoot =
    typeof settings.worksRoot === 'string'
      ? settings.worksRoot.replace(/\/+$/, '')
      : '/library/works'
  declared.push(`${worksRoot}/`, '/library/archive/')

  // references
  const resolves = (path: string): boolean => {
    const { prefix, dynamic } = staticPrefix(path)
    if (!prefix.startsWith('/library/') && !prefix.startsWith('/uploads/')) return true // not ours to check
    if (!dynamic) return exists(path) || exists(`${path}/`) || declared.includes(`${path}/`)
    const dirOf = prefix.slice(0, prefix.lastIndexOf('/') + 1)
    return exists(dirOf) || declared.some((d) => dirOf.startsWith(d) || d.startsWith(dirOf))
  }
  const checkRef = (path: string, where: string, level: Level = 'error'): void => {
    if (resolves(path)) return
    const moved = movedTo(path)
    add(
      level,
      where,
      moved === undefined
        ? `reference does not resolve: ${path}`
        : `reference points to a moved path: ${path} (moved to ${moved}; update it)`,
    )
  }
  for (const f of files) {
    const prog = /^agents\/[^/]+\/programs\/[^/]+\.json$/.exec(f)
    if (prog !== null) {
      const p = obj(parsed.get(f))
      const a = obj(p.authority)
      for (const g of [...strings(a.read), ...strings(a.write)]) checkRef(g, `${f} authority`)
      for (const d of Array.isArray(p.deliverables) ? p.deliverables : []) {
        const path = obj(d).path
        if (typeof path === 'string') checkRef(path, `${f} deliverables`)
      }
      for (const key of ['briefPath', 'notesPath'] as const) {
        const v = p[key]
        if (typeof v === 'string' && v !== '') {
          const entry = entryOf(v)
          if (entry === undefined || !fileSet.has(entry)) {
            add('error', `${f} ${key}`, `file does not exist: ${v}`)
          } else if (!v.startsWith('/library/programs/')) {
            add('error', `${f} ${key}`, `must stay under /library/programs/<program>/: ${v}`)
          }
        }
      }
      for (const text of [...strings(p.notes), typeof p.brief === 'string' ? p.brief : '']) {
        for (const path of libraryPathsIn(text)) checkRef(path, `${f} text`, 'warning')
      }
    }
    if (/^agents\/[^/]+\/agent\.json$/.test(f)) {
      const rules = obj(obj(parsed.get(f)).rules)
      for (const s of [...strings(rules.allow), ...strings(rules.ask), ...strings(rules.deny)]) {
        for (const path of libraryPathsIn(s)) checkRef(path, `${f} rules`)
      }
    }
    const rows = /^data\/api_agents\/\d+\.json$/.test(f) ? obj(parsed.get(f)).rows : undefined
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const r = obj(row)
        const read = r.readFolders ?? r.read_folders
        const write = r.writeFolder ?? r.write_folder
        const who = String(r.slug ?? r.name ?? r.id ?? '?')
        for (const folder of [...strings(read), ...(typeof write === 'string' ? [write] : [])]) {
          checkRef(folder, `${f} API agent ${who}`)
        }
      }
    }
    // memory text and standing orders
    const mem = /^(?:agents\/[^/]+\/)?memory\/(.+)$/.exec(f)
    if (mem !== null && isText(f)) {
      const strict = MEMORY_FILES.includes((mem[1] ?? '') as (typeof MEMORY_FILES)[number])
      for (const raw of read(f).split('\n')) {
        let line = raw
        try {
          line = decodeURIComponent(raw)
        } catch {}
        for (const path of libraryPathsIn(line)) checkRef(path, f, strict ? 'error' : 'warning')
      }
    }
  }

  // memory per agent
  const memoryOf = new Map<string, string[]>()
  for (const f of files) {
    const m = /^agents\/([^/]+)\/memory\/(.+)$/.exec(f)
    if (m !== null)
      memoryOf.set(m[1] as string, [...(memoryOf.get(m[1] as string) ?? []), m[2] as string])
  }
  for (const [slug, names] of memoryOf) {
    for (const name of names) {
      const where = `agents/${slug}/memory/${name}`
      if (!(MEMORY_FILES as readonly string[]).includes(name)) {
        add(
          'warning',
          where,
          'memory keeps rules.md, index.md and HEARTBEAT.md only: move this into the library',
        )
        continue
      }
      const len = read(where).length
      const limit =
        name === 'rules.md'
          ? MEMORY_LIMITS.rules
          : name === 'index.md'
            ? MEMORY_LIMITS.index
            : Infinity
      if (len > limit) add('error', where, `${len} characters, over the limit of ${limit}`)
    }
  }

  // secrets in plain text
  for (const f of files) {
    if (f === 'secrets.enc.json' || !isText(f)) continue
    const text = read(f)
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(text)) add('error', f, `looks like ${name} in plain text`)
    }
    if (f.startsWith('connections/') || f === 'settings.json') {
      const scan = (v: unknown, path: string): void => {
        for (const [k, x] of Object.entries(obj(v))) {
          if (
            typeof x === 'string' &&
            x !== '' &&
            SECRET_KEY.test(k) &&
            !/^secrets not exported/.test(x)
          ) {
            add('error', f, `field ${path}${k} holds a value that looks like a secret`)
          } else if (x !== null && typeof x === 'object') scan(x, `${path}${k}.`)
        }
      }
      scan(parsed.get(f), '')
    }
  }

  // outside the template
  const companyFolders = new Set<string>()
  for (const f of files) {
    const m = /^library\/([^/]+)\/(profile|organization)\.md$/.exec(f)
    if (m !== null) companyFolders.add(m[1] as string)
  }
  const worksEntry = entryOf(`${worksRoot}/`) ?? 'library/works/'
  for (const f of files) {
    if (!f.startsWith('library/')) continue
    const parts = f.split('/')
    if (f.startsWith('library/programs/') || f.startsWith('library/archive/')) continue
    if (f.startsWith('library/notes/heartbeat/') || f.startsWith(worksEntry)) continue
    const top = parts[1] as string
    if (parts.length === 2) {
      add('warning', f, 'a file at the root of the library is outside the template')
    } else if (companyFolders.has(top)) {
      if (!(COMPANY_PARTS as readonly string[]).includes(parts[2] as string)) {
        add('warning', f, `not part of the company template (${COMPANY_PARTS.join(', ')})`)
      }
    } else {
      add('warning', f, 'outside the template: move it under the company folder, or archive it')
    }
  }
  if (companyFolders.size === 0 && files.some((f) => f.startsWith('library/'))) {
    add('warning', 'library/', 'no company folder with profile.md or organization.md found')
  }
  return summarize(findings, files.length)
}

function summarize(findings: Finding[], files: number): Report {
  return {
    findings,
    errors: findings.filter((f) => f.level === 'error').length,
    warnings: findings.filter((f) => f.level === 'warning').length,
    files,
  }
}

export function formatReport(report: Report): string {
  const order: Level[] = ['error', 'warning', 'info']
  const lines: string[] = []
  for (const level of order) {
    const list = report.findings.filter((f) => f.level === level)
    if (list.length === 0) continue
    lines.push(`${level.toUpperCase()} (${list.length})`)
    for (const f of list) lines.push(`  ${f.where}: ${f.message}`)
    lines.push('')
  }
  lines.push(
    `${report.files} files checked: ${report.errors} error(s), ${report.warnings} warning(s). ${
      report.errors === 0 ? 'OK: run pack.ts next.' : 'Fix the errors and run validate again.'
    }`,
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (dir === undefined) {
    console.error('usage: bun tools/reorganize/validate.ts <unzipped workspace folder>')
    process.exit(2)
  }
  const report = validateWorkspace(dir)
  console.log(formatReport(report))
  process.exit(report.errors > 0 ? 1 : 0)
}
