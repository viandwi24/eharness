/**
 * The six file tools (spec 08 §3) and the editing rules (spec 08 §4): read-before-edit,
 * staleness with current content, smart replace, optimistic locking, policy checks.
 *
 * Every expected failure is returned as a prefixed string (`ERROR:`, `STALE:`, `CONFLICT:`,
 * `REJECTED:`); only adapter failures (I/O errors) throw and become tool errors.
 *
 * @see docs/specs/08-filesystem-plugin.md#3-tools
 */
import { type Tool, tool } from 'ai'
import { z } from 'zod/v4'
import type { LastRead } from './last-read.ts'
import { dirPrefix, isUnder, isUnderAny, normalizePath } from './paths.ts'
import { smartReplace } from './smart-replace.ts'
import {
  GREP_PATTERN_RULE,
  GREP_SCAN_CHARS,
  isLiteralPattern,
  splitLines,
  statelessPattern,
  unsafePatternReason,
} from './text.ts'
import type {
  FileChangeData,
  FileEntry,
  FileMeta,
  FileSystem,
  FileToolName,
  GrepHit,
} from './types.ts'
import { byteLength } from './version.ts'

/** Default and maximum number of lines `read_file` returns per call. */
export const READ_LINE_LIMIT = 2000
/** Maximum hits returned by `grep`. */
export const GREP_MAX_HITS = 50
/** Hit budget of the adapter's `grep` fast path (before hidden/unlisted hits are filtered). */
export const GREP_FAST_PATH_HITS = 500
/** Maximum characters of one grep line in the result. */
export const GREP_LINE_CHARS = 300

/** Everything the tools need, resolved at session open. */
export interface FileToolsEnv {
  fs: FileSystem
  lastRead: LastRead
  /** Writes the `data-filesystem.change` part (id = path). */
  change(data: FileChangeData): void
  /** Invisible to every tool. */
  hidden: readonly string[]
  /** Writes and deletes rejected. */
  readonly: readonly string[]
  /** Listed and searched only when asked for explicitly (tool outputs dir). */
  unlisted: readonly string[]
  /** Lowercase, with leading dot; `undefined` = any. */
  allowedExtensions: readonly string[] | undefined
  isUndeletable: ((path: string) => boolean) | undefined
  maxReadChars: number
}

type Resolved = { ok: true; path: string } | { ok: false; text: string }

function resolvePath(input: unknown): Resolved {
  if (typeof input !== 'string') return { ok: false, text: 'ERROR: `path` must be a string' }
  const result = normalizePath(input)
  return result.ok ? result : { ok: false, text: `ERROR: invalid path: ${result.error}` }
}

/** Lines of a file for display: a final line break does not start another line. */
function fileLines(content: string): string[] {
  if (content === '') return []
  const lines = splitLines(content)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

/**
 * Line-numbered window of a file (`cat -n` style: number right-aligned to 6, a tab, the line),
 * bounded by `limit` lines and `maxChars` characters, with a continuation hint. The whole text,
 * continuation hint included, stays within `maxChars` (so the core's tool output limit, spec 09
 * §4, never cuts a full window).
 */
export function renderWindow(
  content: string,
  offset: number,
  limit: number,
  maxChars: number,
  charOffset = 0,
): { text: string } | { error: string } {
  const lines = fileLines(content)
  if (lines.length === 0) return { text: '(empty file)' }
  if (offset > lines.length) {
    return { error: `offset ${offset} is past the end of the file (${lines.length} lines)` }
  }
  const firstLength = (lines[offset - 1] as string).length
  if (charOffset > 0 && charOffset >= firstLength) {
    return {
      error: `charOffset ${charOffset} is past the end of line ${offset} (${firstLength} characters)`,
    }
  }
  const hint = (last: number) =>
    `\n\n(Showing lines ${offset}-${last} of ${lines.length}. Continue with offset=${last + 1}.)`
  const continues = (line: number, next: number) =>
    `\n\n(Line ${line} continues; use offset=${line} charOffset=${next}.)`
  const truncated = ' … [line truncated]'
  const fill = (budget: number) => {
    const out: string[] = []
    let used = 0
    let last = offset - 1
    /** The first line was cut: where it continues. */
    let cut: number | undefined
    for (let n = offset; n <= Math.min(lines.length, offset + limit - 1); n++) {
      const prefix = `${String(n).padStart(6)}\t`
      const text =
        n === offset ? (lines[n - 1] as string).slice(charOffset) : (lines[n - 1] as string)
      let line = prefix + text
      const cost = line.length + 1
      if (used + cost > budget) {
        if (out.length > 0) break
        // a single line longer than the budget: show its head; the rest is reachable with
        // charOffset (spec 08 §3)
        const shown = Math.max(1, budget - prefix.length - truncated.length)
        line = `${prefix}${text.slice(0, shown)}${truncated}`
        cut = (n === offset ? charOffset : 0) + shown
      }
      out.push(line)
      used += cost
      last = n
      if (cut !== undefined) break
    }
    return { text: out.join('\n'), last, cut }
  }
  let window = fill(maxChars)
  if (window.cut !== undefined || window.last < lines.length) {
    // reserve room for the hint (its longest form) and fill again
    const reserve = Math.max(
      hint(lines.length).length,
      continues(lines.length, content.length).length,
    )
    window = fill(Math.max(0, maxChars - reserve))
    window.text += window.cut !== undefined ? continues(window.last, window.cut) : hint(window.last)
  }
  return { text: window.text }
}

const pathSchema = z.string().describe('Absolute path of the file, e.g. /src/main.pine')

/** Create the file tools selected by `names`. */
export function createFileTools(
  env: FileToolsEnv,
  names: readonly FileToolName[],
): Record<string, Tool> {
  const { fs, lastRead } = env

  const hiddenText = (path: string): string => `ERROR: file not found: ${path}`
  const policy = (path: string, what: 'write' | 'delete'): string | undefined => {
    if (isUnderAny(path, env.hidden)) return `REJECTED: ${path} is not accessible.`
    if (isUnderAny(path, env.readonly)) return `REJECTED: ${path} is read-only.`
    if (what === 'write' && env.allowedExtensions !== undefined) {
      const base = path.slice(path.lastIndexOf('/') + 1)
      const dot = base.lastIndexOf('.')
      const extension = dot > 0 ? base.slice(dot).toLowerCase() : ''
      if (!env.allowedExtensions.includes(extension)) {
        return `REJECTED: ${path}: extension not allowed (allowed: ${env.allowedExtensions.join(', ')}).`
      }
    }
    if (what === 'delete' && env.isUndeletable?.(path) === true) {
      return `REJECTED: ${path} cannot be deleted.`
    }
    return undefined
  }

  /** Visible in listings/searches under `root` (the requested prefix). */
  const listed = (path: string, root: string): boolean =>
    !isUnderAny(path, env.hidden) &&
    env.unlisted.every((dir) => !isUnder(path, dir) || isUnder(root, dir))

  const stale = (current: FileEntry): string => {
    lastRead.set(current.path, current.version)
    const window = renderWindow(current.content, 1, READ_LINE_LIMIT, env.maxReadChars)
    const body = 'text' in window ? window.text : ''
    return `STALE: ${current.path} changed since you last read it. Its current content is below; apply your change to this version.\n\n${body}`
  }

  /** Read-before-write check: `undefined` when the model's last read is current. */
  const freshness = (current: FileEntry, verb: string): string | undefined => {
    const known = lastRead.get(current.path)
    if (known === undefined) {
      return `ERROR: read ${current.path} with read_file before ${verb} it.`
    }
    return known === current.version ? undefined : stale(current)
  }

  const conflict = (path: string): string =>
    `CONFLICT: ${path} was changed by someone else at the same time; read it again and retry.`

  const all: Record<FileToolName, Tool> = {
    list_files: tool({
      description:
        'List files (recursive) with their sizes. Optionally only under a directory prefix.',
      inputSchema: z.object({
        prefix: z.string().optional().describe('Directory to list, e.g. /src. Default: /'),
      }),
      execute: async ({ prefix }): Promise<string> => {
        const resolved = resolvePath(prefix ?? '/')
        if (!resolved.ok) return resolved.text
        const root = resolved.path
        if (isUnderAny(root, env.hidden)) return `No files under ${root}.`
        const files = (await fs.list(dirPrefix(root))).filter(
          (file) => isUnder(file.path, root) && listed(file.path, root),
        )
        if (files.length === 0) return `No files under ${root}.`
        return files.map((file) => `${file.path} (${file.size} bytes)`).join('\n')
      },
    }),

    read_file: tool({
      description: `Read a text file. Returns numbered lines (at most ${READ_LINE_LIMIT} per call); use offset/limit to page through long files and charOffset to continue a very long line. Read a file before editing, overwriting or deleting it.`,
      inputSchema: z.object({
        path: pathSchema,
        offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Number of lines to read (max ${READ_LINE_LIMIT})`),
        charOffset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Character offset inside the first line (to continue a very long line)'),
      }),
      execute: async ({ path: input, offset, limit, charOffset }): Promise<string> => {
        const resolved = resolvePath(input)
        if (!resolved.ok) return resolved.text
        const path = resolved.path
        if (isUnderAny(path, env.hidden)) return hiddenText(path)
        const entry = await fs.read(path)
        if (entry === null) return `ERROR: file not found: ${path}`
        const window = renderWindow(
          entry.content,
          offset ?? 1,
          Math.min(limit ?? READ_LINE_LIMIT, READ_LINE_LIMIT),
          env.maxReadChars,
          charOffset ?? 0,
        )
        if ('error' in window) return `ERROR: ${window.error}`
        lastRead.set(path, entry.version)
        return window.text
      },
    }),

    write_file: tool({
      description:
        'Create a file, or overwrite an existing file with new content (read it first). Prefer edit_file for small changes.',
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().describe('The complete new content of the file'),
      }),
      execute: async ({ path: input, content }): Promise<string> => {
        const resolved = resolvePath(input)
        if (!resolved.ok) return resolved.text
        const path = resolved.path
        if (path === '/') return 'ERROR: invalid path: the path does not name a file'
        const denied = policy(path, 'write')
        if (denied !== undefined) return denied
        const current = await fs.read(path)
        if (current !== null) {
          const problem = freshness(current, 'overwriting')
          if (problem !== undefined) return problem
        }
        const result = await fs.write(path, content, {
          ifVersion: current === null ? null : current.version,
        })
        if (!result.ok) return conflict(path)
        const bytes = byteLength(content)
        lastRead.set(path, result.version)
        const action = current === null ? 'create' : 'write'
        env.change({ path, action, version: result.version, bytes })
        return `${current === null ? 'Created' : 'Wrote'} ${path} (${bytes} bytes).`
      },
    }),

    edit_file: tool({
      description:
        'Replace text in a file (read it first). old_string must match exactly one place (include surrounding lines to make it unique) unless replace_all is true. Indentation and whitespace differences are tolerated when unambiguous.',
      inputSchema: z.object({
        path: pathSchema,
        old_string: z.string().describe('Text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every match. Default false'),
      }),
      execute: async (input): Promise<string> => {
        const resolved = resolvePath(input.path)
        if (!resolved.ok) return resolved.text
        const path = resolved.path
        const denied = policy(path, 'write')
        if (denied !== undefined) return denied
        const current = await fs.read(path)
        if (current === null) return `ERROR: file not found: ${path} (use write_file to create it)`
        const problem = freshness(current, 'editing')
        if (problem !== undefined) return problem
        const replaced = smartReplace(
          current.content,
          input.old_string,
          input.new_string,
          input.replace_all === true,
        )
        if (!replaced.ok) return `ERROR: ${replaced.error}`
        const result = await fs.write(path, replaced.content, { ifVersion: current.version })
        if (!result.ok) return conflict(path)
        const bytes = byteLength(replaced.content)
        lastRead.set(path, result.version)
        env.change({ path, action: 'edit', version: result.version, bytes })
        const count = replaced.count === 1 ? '1 replacement' : `${replaced.count} replacements`
        return `Edited ${path} (${count}).`
      },
    }),

    delete_file: tool({
      description: 'Delete a file (read it first).',
      inputSchema: z.object({ path: pathSchema }),
      execute: async ({ path: input }): Promise<string> => {
        const resolved = resolvePath(input)
        if (!resolved.ok) return resolved.text
        const path = resolved.path
        const denied = policy(path, 'delete')
        if (denied !== undefined) return denied
        const current = await fs.read(path)
        if (current === null) return `ERROR: file not found: ${path}`
        const problem = freshness(current, 'deleting')
        if (problem !== undefined) return problem
        const result = await fs.delete(path, { ifVersion: current.version })
        if (!result.ok) {
          if (result.reason === 'missing') {
            lastRead.delete(path)
            return `ERROR: file not found: ${path}`
          }
          return conflict(path)
        }
        lastRead.delete(path)
        env.change({ path, action: 'delete', version: null })
        return `Deleted ${path}.`
      },
    }),

    grep: tool({
      description: `Search file contents with a regular expression (JavaScript syntax, per line). Returns at most ${GREP_MAX_HITS} matches as path:line: text.`,
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression, e.g. "TODO|FIXME"'),
        prefix: z.string().optional().describe('Only search under this directory. Default: /'),
      }),
      execute: async ({ pattern, prefix }): Promise<string> => {
        // no catastrophic backtracking: the event loop must never freeze on a model's pattern
        const unsafe = unsafePatternReason(pattern)
        if (unsafe !== undefined) {
          return `ERROR: invalid pattern: ${unsafe}. ${GREP_PATTERN_RULE}`
        }
        let regex: RegExp
        try {
          regex = new RegExp(pattern)
        } catch (error) {
          return `ERROR: invalid pattern: ${error instanceof Error ? error.message : String(error)}`
        }
        const resolved = resolvePath(prefix ?? '/')
        if (!resolved.ok) return resolved.text
        const root = resolved.path
        if (isUnderAny(root, env.hidden)) return 'No matches.'
        const hits = await search(root, regex, isLiteralPattern(pattern) ? pattern : undefined)
        if (hits.length === 0) return 'No matches.'
        const matcher = statelessPattern(regex)
        const shown = hits.slice(0, GREP_MAX_HITS).map((hit) => {
          if (hit.text.length <= GREP_LINE_CHARS) return `${hit.path}:${hit.line}: ${hit.text}`
          // a cut line names where the match is, so read_file can reach it (charOffset)
          const at = matcher.exec(hit.text.slice(0, GREP_SCAN_CHARS))?.index
          const where = at === undefined ? '' : ` (match at charOffset=${at})`
          return `${hit.path}:${hit.line}: ${hit.text.slice(0, GREP_LINE_CHARS)} …${where}`
        })
        if (hits.length > GREP_MAX_HITS) {
          shown.push(`(Stopped at ${GREP_MAX_HITS} matches; narrow the pattern or the prefix.)`)
        }
        return shown.join('\n')
      },
    }),
  }

  /** Up to GREP_MAX_HITS + 1 visible hits under `root`. */
  async function search(
    root: string,
    regex: RegExp,
    literal: string | undefined,
  ): Promise<GrepHit[]> {
    const limit = GREP_MAX_HITS + 1
    const visible = (hit: GrepHit): boolean => isUnder(hit.path, root) && listed(hit.path, root)
    // the adapter's fast path with a larger budget; hidden/unlisted hits are filtered out
    if (fs.grep !== undefined) {
      const raw = await fs.grep(regex, { prefix: dirPrefix(root), maxHits: GREP_FAST_PATH_HITS })
      const hits = raw.filter(visible)
      // complete result, or enough visible hits: done; otherwise hidden hits used up the budget
      if (raw.length < GREP_FAST_PATH_HITS || hits.length >= limit) return hits.slice(0, limit)
    }
    const line = statelessPattern(regex)
    // a pattern without metacharacters is a plain substring search; each line is scanned up to
    // GREP_SCAN_CHARS characters
    const matches = (text: string): boolean => {
      const head = text.length > GREP_SCAN_CHARS ? text.slice(0, GREP_SCAN_CHARS) : text
      return literal === undefined ? line.test(head) : head.includes(literal)
    }
    const hits: GrepHit[] = []
    const files: FileMeta[] = (await fs.list(dirPrefix(root))).filter(
      (file) => isUnder(file.path, root) && listed(file.path, root),
    )
    for (const file of files) {
      const entry = await fs.read(file.path)
      if (entry === null) continue
      const lines = splitLines(entry.content)
      for (let i = 0; i < lines.length; i++) {
        if (!matches(lines[i] as string)) continue
        hits.push({ path: file.path, line: i + 1, text: lines[i] as string })
        if (hits.length >= limit) return hits
      }
    }
    return hits
  }

  const selected: Record<string, Tool> = {}
  for (const name of names) selected[name] = all[name]
  return selected
}
