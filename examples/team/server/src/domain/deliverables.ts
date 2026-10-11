/**
 * Deliverables (docs/plans/P40-team-autonomous-operations.md, phase H). Pure.
 *
 * A program (or a one-off proposal) may list what a run must leave in the library: a path pattern,
 * a kind (`markdown`, `json`, `any`) and the structure the file must have. The server checks the
 * files deterministically at the end of a run, gives the agent one fix-up turn with the exact
 * failures (the real *Verify* step), and marks the run `partial` and opens a decision when they
 * still fail. Style and quality stay in skills: only structure is enforced here.
 *
 * Path tokens (resolved per run): `{date}` (UTC `YYYY-MM-DD` of the run), `{slug}` (the program
 * name, or the task title for a work item, lower-cased with dashes), `{runId}` (the run's
 * timestamp in milliseconds) and `{program}` (the program id).
 *
 * JSON schemas are validated by the installed `SchemaValidator` (`infra/json-schema.ts`, zod's
 * `z.fromJSONSchema` in zod 4; the domain stays free of packages): the common subset (type, properties,
 * required, items, enum, const, min/max, pattern, additionalProperties, anyOf/oneOf/allOf, local
 * `$ref`) is validated; keywords zod does not know are ignored, never rejected.
 */
import { invalid } from './errors.ts'

export const DELIVERABLE_KINDS = ['markdown', 'json', 'any'] as const
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

export interface Deliverable {
  /** Library path with tokens (`/library/reports/{slug}/{date}.md`). */
  path: string
  kind: DeliverableKind
  /** Markdown: headings the file must have (any level, case-insensitive). */
  requiredSections?: string[] | undefined
  /** JSON: a JSON Schema the parsed file must match. */
  schema?: Record<string, unknown> | undefined
  /** Minimum length of the file in characters. */
  minChars?: number | undefined
}

/** One checked deliverable. */
export interface DeliverableCheck {
  /** The pattern as written. */
  pattern: string
  /** The path after the tokens were resolved. */
  path: string
  ok: boolean
  /** What is wrong, one line each; empty when ok. */
  problems: string[]
}

/** The result of the checks of one run, stored on the task. */
export interface DeliverableResult {
  /** `pass`, or `fail` (the run is partial and a decision is open or was open). */
  status: 'pass' | 'fail'
  /** 1: checked once. 2: checked again after the fix-up turn. */
  attempts: number
  checkedAt: number
  checks: DeliverableCheck[]
}

export const MAX_DELIVERABLES = 20
export const MAX_SECTIONS = 30
export const MAX_SCHEMA_CHARS = 20_000
export const TOKENS = ['date', 'slug', 'runId', 'program'] as const

const TOKEN = /\{([A-Za-z]+)\}/g

/** Lower-case, dashes, no accents; never empty. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug === '' ? 'untitled' : slug
}

export interface TokenContext {
  /** Program name, or the title of the work item. */
  title: string
  programId: string
  /** The run's timestamp (the `<runAt>` of its session id). */
  runAt: number
}

export function resolvePath(pattern: string, ctx: TokenContext): string {
  const values: Record<string, string> = {
    date: new Date(ctx.runAt).toISOString().slice(0, 10),
    slug: slugify(ctx.title),
    runId: String(ctx.runAt),
    program: ctx.programId,
  }
  return pattern.replace(TOKEN, (whole, name: string) => values[name] ?? whole)
}

/**
 * Checks JSON against a JSON Schema. `compile` returns why a schema cannot be used (undefined:
 * usable); `validate` returns one line per violation (empty: valid).
 */
export interface SchemaValidator {
  compile(schema: Record<string, unknown>): string | undefined
  validate(schema: Record<string, unknown>, value: unknown): string[]
}

let validator: SchemaValidator | undefined

/** The composition root installs the implementation once (see `infra/json-schema.ts`). */
export function installSchemaValidator(v: SchemaValidator | undefined): void {
  validator = v
}

// --- validation ---------------------------------------------------------------------------------

/** Checks a list from untrusted JSON (`INVALID_PROGRAM`). */
export function checkDeliverables(list: readonly Deliverable[] | undefined): void {
  if (list === undefined) return
  if (list.length > MAX_DELIVERABLES) {
    throw invalid(`deliverables has at most ${MAX_DELIVERABLES} entries`, 'INVALID_PROGRAM')
  }
  for (const d of list) {
    const path = typeof d.path === 'string' ? d.path.trim() : ''
    if (!path.startsWith('/') || path.length > 500 || path.includes('..') || path.endsWith('/')) {
      throw invalid(
        `deliverable path "${d.path}" must be a library file path starting with / (no .., no trailing /)`,
        'INVALID_PROGRAM',
      )
    }
    for (const m of path.matchAll(TOKEN)) {
      if (!(TOKENS as readonly string[]).includes(m[1] as string)) {
        throw invalid(
          `deliverable path "${d.path}": unknown token {${m[1]}} (use ${TOKENS.map((t) => `{${t}}`).join(', ')})`,
          'INVALID_PROGRAM',
        )
      }
    }
    if (/[{}]/.test(path.replace(TOKEN, ''))) {
      throw invalid(`deliverable path "${d.path}": unbalanced braces`, 'INVALID_PROGRAM')
    }
    if (!(DELIVERABLE_KINDS as readonly string[]).includes(d.kind)) {
      throw invalid(
        `deliverable kind must be one of ${DELIVERABLE_KINDS.join(', ')}`,
        'INVALID_PROGRAM',
      )
    }
    if (d.requiredSections !== undefined) {
      if (d.kind !== 'markdown') {
        throw invalid('requiredSections applies to markdown deliverables only', 'INVALID_PROGRAM')
      }
      if (
        d.requiredSections.length > MAX_SECTIONS ||
        d.requiredSections.some((s) => typeof s !== 'string' || s.trim() === '' || s.length > 200)
      ) {
        throw invalid(
          `requiredSections: at most ${MAX_SECTIONS} headings of 1-200 characters`,
          'INVALID_PROGRAM',
        )
      }
    }
    if (d.schema !== undefined) {
      if (d.kind !== 'json') {
        throw invalid('schema applies to json deliverables only', 'INVALID_PROGRAM')
      }
      if (
        typeof d.schema !== 'object' ||
        d.schema === null ||
        Array.isArray(d.schema) ||
        JSON.stringify(d.schema).length > MAX_SCHEMA_CHARS
      ) {
        throw invalid(
          `schema must be a JSON Schema object of at most ${MAX_SCHEMA_CHARS} characters`,
          'INVALID_PROGRAM',
        )
      }
      const why = validator?.compile(d.schema)
      if (why !== undefined) {
        throw invalid(`deliverable "${d.path}": schema not usable: ${why}`, 'INVALID_PROGRAM')
      }
    }
    if (
      d.minChars !== undefined &&
      (!Number.isInteger(d.minChars) || d.minChars < 1 || d.minChars > 10_000_000)
    ) {
      throw invalid('minChars must be a positive integer', 'INVALID_PROGRAM')
    }
  }
}

/** Trimmed copy without empty optional fields. */
export function normalizeDeliverables(list: readonly Deliverable[] | undefined): Deliverable[] {
  return (list ?? []).map((d) => ({
    path: d.path.trim(),
    kind: d.kind,
    ...(d.requiredSections === undefined || d.requiredSections.length === 0
      ? {}
      : { requiredSections: [...new Set(d.requiredSections.map((s) => s.trim()))] }),
    ...(d.schema === undefined ? {} : { schema: d.schema }),
    ...(d.minChars === undefined ? {} : { minChars: d.minChars }),
  }))
}

// --- checking -----------------------------------------------------------------------------------

/** Headings of a markdown text (outside code fences), normalized for comparison. */
export function markdownHeadings(text: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line)
    if (f !== null) {
      const mark = (f[1] as string)[0] as string
      if (fence === null) fence = mark
      else if (fence === mark) fence = null
      continue
    }
    if (fence !== null) continue
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (h !== null) out.push(normalizeHeading(h[1] as string))
  }
  return out
}

/** Case, emphasis marks and trailing colons do not matter when comparing a heading. */
export function normalizeHeading(text: string): string {
  return text
    .replace(/[*_`]/g, '')
    .replace(/[:.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Problems of one file's text against its deliverable (the file exists). */
export function checkContent(d: Deliverable, text: string): string[] {
  const problems: string[] = []
  if (d.minChars !== undefined && text.trim().length < d.minChars) {
    problems.push(`too short: ${text.trim().length} characters, at least ${d.minChars} required`)
  }
  if (d.kind === 'markdown' && d.requiredSections !== undefined) {
    const have = new Set(markdownHeadings(text))
    const missing = d.requiredSections.filter((s) => !have.has(normalizeHeading(s)))
    if (missing.length > 0) {
      problems.push(
        `missing sections (markdown headings): ${missing.map((s) => `"${s}"`).join(', ')}`,
      )
    }
  }
  if (d.kind === 'json') {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      problems.push(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return problems
    }
    if (d.schema !== undefined) {
      if (validator === undefined) {
        problems.push('no JSON Schema validator is installed')
      } else {
        const found = validator.validate(d.schema, value)
        problems.push(...found.slice(0, 10))
        if (found.length > 10) problems.push(`... and ${found.length - 10} more schema errors`)
      }
    }
  }
  return problems
}

/** Reads a library file: its text (null for a binary file), or undefined when it does not exist. */
export type ReadFile = (path: string) => Promise<{ text: string | null } | undefined>

/** Checks every deliverable of a run (tokens resolved) against the files. */
export async function evaluateDeliverables(
  list: readonly Deliverable[],
  ctx: TokenContext,
  read: ReadFile,
): Promise<DeliverableCheck[]> {
  const checks: DeliverableCheck[] = []
  for (const d of list) {
    const path = resolvePath(d.path, ctx)
    let file: Awaited<ReturnType<ReadFile>>
    try {
      file = await read(path)
    } catch (error) {
      checks.push({
        pattern: d.path,
        path,
        ok: false,
        problems: [`could not be read: ${error instanceof Error ? error.message : String(error)}`],
      })
      continue
    }
    const problems: string[] =
      file === undefined
        ? ['the file does not exist']
        : file.text === null
          ? d.kind === 'any'
            ? []
            : [`the file is binary, expected ${d.kind}`]
          : checkContent(d, file.text)
    checks.push({ pattern: d.path, path, ok: problems.length === 0, problems })
  }
  return checks
}

export const allPass = (checks: readonly DeliverableCheck[]): boolean => checks.every((c) => c.ok)

export const failures = (checks: readonly DeliverableCheck[]): DeliverableCheck[] =>
  checks.filter((c) => !c.ok)

// --- text ---------------------------------------------------------------------------------------

/** The line of a deliverable: the path (with this run's tokens resolved when `ctx` is given) and what it must be. */
export function deliverableLine(d: Deliverable, ctx?: TokenContext): string {
  const parts: string[] = [d.kind]
  if (d.requiredSections !== undefined && d.requiredSections.length > 0) {
    parts.push(`with the headings ${d.requiredSections.map((s) => `"${s}"`).join(', ')}`)
  }
  if (d.schema !== undefined) parts.push(`matching this JSON Schema: ${JSON.stringify(d.schema)}`)
  if (d.minChars !== undefined) parts.push(`at least ${d.minChars} characters`)
  return `${ctx === undefined ? d.path : resolvePath(d.path, ctx)} (${parts.join(', ')})`
}

/** The section of the run prompt that names the deliverables; empty when there are none. */
export function deliverablesPromptSection(
  list: readonly Deliverable[],
  ctx: TokenContext,
): string[] {
  if (list.length === 0) return []
  return [
    '## Deliverables (the server checks these files when you finish)',
    ...list.map((d) => `- ${deliverableLine(d, ctx)}`),
    'Write each of them to exactly that path. Missing, too short or wrongly structured files fail',
    'the check: you then get one turn to fix the exact problems, after that the run is marked',
    'partial and the client is asked.',
    '',
  ]
}

/** The fix-up turn: the exact failures, nothing else. */
export function fixUpPrompt(checks: readonly DeliverableCheck[]): string {
  return [
    'Verify: the server checked your deliverables and these failed.',
    '',
    ...failures(checks).flatMap((c) => [`- ${c.path}`, ...c.problems.map((p) => `  - ${p}`)]),
    '',
    'Fix exactly these files now (write or rewrite them in the library), then end with your final',
    'report. This is the only fix-up turn: if they still fail, the run is marked partial and the',
    'client is asked.',
  ].join('\n')
}

/** What the task summary and the decision body say when the fix-up did not help. */
export function failureText(checks: readonly DeliverableCheck[]): string {
  return failures(checks)
    .map((c) => `${c.path}: ${c.problems.join('; ')}`)
    .join('\n')
}

/** A stored result from untrusted JSON (the task column), or undefined. */
export function parseDeliverableResult(value: unknown): DeliverableResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.status !== 'pass' && v.status !== 'fail') return undefined
  if (!Array.isArray(v.checks)) return undefined
  const checks: DeliverableCheck[] = []
  for (const c of v.checks) {
    if (typeof c !== 'object' || c === null) return undefined
    const o = c as Record<string, unknown>
    if (typeof o.path !== 'string' || typeof o.pattern !== 'string') return undefined
    checks.push({
      pattern: o.pattern,
      path: o.path,
      ok: o.ok === true,
      problems: Array.isArray(o.problems)
        ? o.problems.filter((p): p is string => typeof p === 'string')
        : [],
    })
  }
  return {
    status: v.status,
    attempts: typeof v.attempts === 'number' ? v.attempts : 1,
    checkedAt: typeof v.checkedAt === 'number' ? v.checkedAt : 0,
    checks,
  }
}

/** A stored list of deliverables (the program column), tolerant of bad rows. */
export function parseDeliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (d): d is Deliverable =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as Deliverable).path === 'string' &&
      (DELIVERABLE_KINDS as readonly unknown[]).includes((d as Deliverable).kind),
  )
}
