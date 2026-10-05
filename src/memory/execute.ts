/**
 * The memory commands (spec 14 §2–§6): one executor behind the six memory tools and behind an
 * app-supplied tool (the `tool` option, e.g. a provider-defined memory tool).
 *
 * Every expected failure is returned as a prefixed string (`ERROR:`, `CONFLICT:`, `REJECTED:`);
 * only adapter failures (I/O errors) and invalid roots (programmer errors) throw.
 *
 * @see docs/specs/14-memory-plugin.md
 */
import { HarnessError } from '../index.ts'
import { dirPrefix, isUnder, normalizeMemoryPath } from './paths.ts'
import { conflictText, missingText, outsideText, readOnlyText, tooLargeText } from './texts.ts'

/**
 * One memory command. Same shape as the input of Anthropic's `memory_20250818` tool, so a
 * provider-defined memory tool can be executed by {@link executeMemoryCommand} unchanged.
 *
 * @see docs/specs/14-memory-plugin.md#2-commands-and-tools
 */
export type MemoryCommand =
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string }

/**
 * A memory root: a directory the model may view (and, with `write: true`, change). Chosen by the
 * application per turn (e.g. one root per user, a read-only root for the organisation).
 *
 * @see docs/specs/14-memory-plugin.md#3-paths-and-roots
 */
export interface MemoryRoot {
  /** Directory (normalized like a file path; a trailing `/` is optional). */
  path: string
  /** Default `false` (read-only). */
  write?: boolean
  /** Shown to the model next to the root in the turn reminder. */
  label?: string
}

/**
 * Event passed to `onWrite` after every successful write.
 *
 * @see docs/specs/14-memory-plugin.md#7-onwrite
 */
export interface MemoryWriteEvent {
  op: 'create' | 'str_replace' | 'insert' | 'delete' | 'rename'
  /** The changed file (the old path of a rename). */
  path: string
  /** The new path of a rename. */
  to?: string
  /** Version and UTF-8 size before the change (absent for `create`). */
  before?: { version: string; size: number }
  /** Version and UTF-8 size after the change (absent for `delete`). */
  after?: { version: string; size: number }
  /** The tool call that made the change, when known. */
  toolCallId?: string
}

/** Metadata of one file (mirror of `FileMeta` from `eharness/filesystem`). */
interface MemoryFileMeta {
  path: string
  version: string
  size: number
  updatedAt?: number
}

/**
 * The part of the `FileSystem` contract of `eharness/filesystem` (spec 08 §1) the memory commands
 * use. `eharness/memory` never imports another subpath (ADR-0008), so the contract is mirrored
 * structurally: every `FileSystem` is a `MemoryFileSystem`.
 */
export interface MemoryFileSystem {
  read(path: string): Promise<(MemoryFileMeta & { content: string }) | null>
  write(
    path: string,
    content: string,
    opts?: { ifVersion?: string | null },
  ): Promise<
    | { ok: true; version: string }
    | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
  >
  delete(
    path: string,
    opts?: { ifVersion?: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }>
  list(prefix?: string): Promise<MemoryFileMeta[]>
  move?(
    from: string,
    to: string,
    opts?: { ifVersion?: string },
  ): Promise<
    { ok: true } | { ok: false; reason: 'missing' | 'exists' | 'conflict'; currentVersion?: string }
  >
}

/**
 * Options of {@link executeMemoryCommand}.
 *
 * @see docs/specs/14-memory-plugin.md#2-commands-and-tools
 */
export interface MemoryExecuteOptions {
  fs: MemoryFileSystem
  roots: readonly MemoryRoot[]
  /** Default 20_000: maximum characters (`string.length`) of a file after `create` or an edit. */
  maxFileChars?: number
  /** Passed on in {@link MemoryWriteEvent.toolCallId}. */
  toolCallId?: string
  /** Called after every successful write. Its errors never change the command result. */
  onWrite?: (event: MemoryWriteEvent) => void | Promise<void>
  /** Receives errors thrown by `onWrite` (default: ignored). */
  onWriteError?: (error: unknown, event: MemoryWriteEvent) => void
}

/** Default `maxFileChars`. */
export const DEFAULT_MAX_FILE_CHARS = 20_000

/** Most files a directory `view` lists. */
const VIEW_MAX_FILES = 200

/** A root after validation: a normalized directory. */
export interface ResolvedMemoryRoot {
  path: string
  write: boolean
  label?: string
}

function invalidRoots(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', `memory: ${message}`, {
    details: { plugin: 'memory' },
  })
}

/**
 * Validate and normalize roots. Duplicate paths merge (read-only wins).
 *
 * @throws {HarnessError} `EH_CONFIG_INVALID` for a list that is not an array of roots or an
 *   invalid root path.
 */
export function resolveMemoryRoots(roots: unknown): ResolvedMemoryRoot[] {
  if (!Array.isArray(roots)) invalidRoots('`roots` must return an array of { path, write? }.')
  const out: ResolvedMemoryRoot[] = []
  for (const root of roots as unknown[]) {
    if (
      typeof root !== 'object' ||
      root === null ||
      typeof (root as MemoryRoot).path !== 'string'
    ) {
      invalidRoots(`invalid root ${JSON.stringify(root)}: expected { path, write?, label? }.`)
    }
    const { path, write, label } = root as MemoryRoot
    const normalized = normalizeMemoryPath(path)
    if (!normalized.ok) invalidRoots(`invalid root ${JSON.stringify(path)}: ${normalized.error}.`)
    const existing = out.find((r) => r.path === normalized.path)
    if (existing !== undefined) {
      existing.write = existing.write && write === true
      continue
    }
    const resolved: ResolvedMemoryRoot = { path: normalized.path, write: write === true }
    if (typeof label === 'string' && label.trim() !== '') resolved.label = label.trim()
    out.push(resolved)
  }
  return out
}

/** The most specific root containing `path`. */
function rootOf(
  path: string,
  roots: readonly ResolvedMemoryRoot[],
): ResolvedMemoryRoot | undefined {
  let best: ResolvedMemoryRoot | undefined
  for (const root of roots) {
    if (isUnder(path, root.path) && (best === undefined || root.path.length > best.path.length)) {
      best = root
    }
  }
  return best
}

const encoder = new TextEncoder()
const utf8 = (text: string): number => encoder.encode(text).byteLength

/** Lines of a file for display: a final line break does not start another line. */
function fileLines(content: string): string[] {
  if (content === '') return []
  return (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
}

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

/** Validate a command; returns the error text of an invalid one. */
function validate(input: unknown): MemoryCommand | string {
  const bad = (message: string) => `ERROR: invalid input: ${message}`
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { command?: unknown }).command !== 'string'
  ) {
    return bad('expected an object with a `command`.')
  }
  const record = input as Record<string, unknown>
  const strings = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (typeof record[key] !== 'string') return bad(`\`${key}\` must be a string.`)
    }
    return undefined
  }
  switch (record.command) {
    case 'view': {
      const error = strings('path')
      if (error !== undefined) return error
      const range = record.view_range
      if (
        range !== undefined &&
        range !== null &&
        !(Array.isArray(range) && range.length === 2 && isInt(range[0]) && isInt(range[1]))
      ) {
        return bad('`view_range` must be two integers [start, end].')
      }
      break
    }
    case 'create':
      return strings('path', 'file_text') ?? (record as MemoryCommand)
    case 'str_replace':
      return strings('path', 'old_str', 'new_str') ?? (record as MemoryCommand)
    case 'insert': {
      const error = strings('path', 'insert_text')
      if (error !== undefined) return error
      if (!isInt(record.insert_line) || record.insert_line < 0) {
        return bad('`insert_line` must be an integer ≥ 0.')
      }
      break
    }
    case 'delete':
      return strings('path') ?? (record as MemoryCommand)
    case 'rename':
      return strings('old_path', 'new_path') ?? (record as MemoryCommand)
    default:
      return bad(`unknown command ${JSON.stringify(record.command)}.`)
  }
  return record as MemoryCommand
}

type Checked = { ok: true; path: string } | { ok: false; text: string }

/**
 * Execute one memory command against a file system, confined to `roots`. Returns the
 * model-visible result text; expected failures are `ERROR:` / `CONFLICT:` / `REJECTED:` strings.
 *
 * Every mutation reads the file, applies the change and writes with `ifVersion` (create:
 * `ifVersion: null`), so concurrent writers never overwrite each other (`CONFLICT:`). `rename`
 * uses `fs.move` when the adapter has it, else write + delete.
 *
 * @example
 * ```ts
 * await executeMemoryCommand(
 *   { command: 'create', path: '/memories/u1/notes.md', file_text: '# Notes\n' },
 *   { fs, roots: [{ path: '/memories/u1', write: true }] },
 * ) // 'Created /memories/u1/notes.md.'
 * ```
 * @throws {HarnessError} `EH_CONFIG_INVALID` for invalid `roots`. Adapter errors propagate.
 * @see docs/specs/14-memory-plugin.md#2-commands-and-tools
 */
export async function executeMemoryCommand(
  input: MemoryCommand,
  options: MemoryExecuteOptions,
): Promise<string> {
  const roots = resolveMemoryRoots(options.roots)
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS
  const { fs } = options
  const command = validate(input)
  if (typeof command === 'string') return command

  const check = (raw: string, access: 'read' | 'write'): Checked => {
    const normalized = normalizeMemoryPath(raw)
    if (!normalized.ok) return { ok: false, text: `ERROR: invalid path: ${normalized.error}` }
    const root = rootOf(normalized.path, roots)
    if (root === undefined) return { ok: false, text: outsideText(normalized.path) }
    if (access === 'write' && !root.write) return { ok: false, text: readOnlyText(normalized.path) }
    return normalized
  }
  const isDirectory = async (path: string): Promise<boolean> =>
    roots.some((r) => r.path === path) || (await fs.list(dirPrefix(path))).length > 0
  const written = async (event: Omit<MemoryWriteEvent, 'toolCallId'>): Promise<void> => {
    const full: MemoryWriteEvent =
      options.toolCallId === undefined ? event : { ...event, toolCallId: options.toolCallId }
    if (options.onWrite === undefined) return
    try {
      await options.onWrite(full)
    } catch (error) {
      options.onWriteError?.(error, full)
    }
  }
  const meta = (version: string, content: string) => ({ version, size: utf8(content) })

  if (command.command === 'view') {
    const checked = check(command.path, 'read')
    if (!checked.ok) return checked.text
    const { path } = checked
    const file = await fs.read(path)
    if (file === null) {
      const dir = dirPrefix(path)
      const files = (await fs.list(dir)).filter((f) => f.path.startsWith(dir))
      if (files.length === 0) {
        return roots.some((r) => r.path === path) ? `${dir} is empty.` : missingText(path)
      }
      const shown = files.slice(0, VIEW_MAX_FILES).map((f) => `${f.path}\t${f.size} bytes`)
      if (files.length > VIEW_MAX_FILES) {
        shown.push(`(… and ${files.length - VIEW_MAX_FILES} more files)`)
      }
      const count = `${files.length} file${files.length === 1 ? '' : 's'}`
      return `${dir} (${count}):\n${shown.join('\n')}`
    }
    const lines = fileLines(file.content)
    if (lines.length === 0) return '(empty file)'
    let start = 1
    let end = lines.length
    const range = command.view_range
    if (range !== undefined && range !== null) {
      const [from, to] = range
      if (from < 1 || from > lines.length || (to !== -1 && to < from)) {
        return `ERROR: invalid view_range [${from}, ${to}]: ${path} has ${lines.length} lines.`
      }
      start = from
      end = to === -1 ? lines.length : Math.min(to, lines.length)
    }
    const out: string[] = []
    for (let n = start; n <= end; n++) out.push(`${String(n).padStart(6)}\t${lines[n - 1]}`)
    return out.join('\n')
  }

  if (command.command === 'create') {
    const checked = check(command.path, 'write')
    if (!checked.ok) return checked.text
    const { path } = checked
    const exists = `ERROR: ${path} already exists. Change it with str_replace or insert, or delete it first.`
    if ((await fs.read(path)) !== null) return exists
    if (await isDirectory(path)) return `ERROR: ${path} is a directory.`
    if (command.file_text.length > maxFileChars) return tooLargeText(path, maxFileChars)
    const result = await fs.write(path, command.file_text, { ifVersion: null })
    if (!result.ok) return result.reason === 'exists' ? exists : conflictText(path)
    await written({ op: 'create', path, after: meta(result.version, command.file_text) })
    return `Created ${path}.`
  }

  if (command.command === 'str_replace' || command.command === 'insert') {
    const checked = check(command.path, 'write')
    if (!checked.ok) return checked.text
    const { path } = checked
    if (command.command === 'str_replace' && command.old_str === '') {
      return 'ERROR: old_str must not be empty.'
    }
    const file = await fs.read(path)
    if (file === null) {
      return (await isDirectory(path)) ? `ERROR: ${path} is a directory.` : missingText(path)
    }
    let next: string
    let done: string
    if (command.command === 'str_replace') {
      const count = file.content.split(command.old_str).length - 1
      if (count === 0) return `ERROR: old_str was not found in ${path}.`
      if (count > 1) {
        return `ERROR: old_str occurs ${count} times in ${path}; include more surrounding text so it is unique.`
      }
      next = file.content.replace(command.old_str, () => command.new_str)
      done = `Edited ${path}.`
    } else {
      const lines = fileLines(file.content)
      const at = command.insert_line
      if (at > lines.length) {
        return `ERROR: invalid insert_line ${at}: ${path} has ${lines.length} lines.`
      }
      const text = command.insert_text.endsWith('\n')
        ? command.insert_text.slice(0, -1)
        : command.insert_text
      lines.splice(at, 0, ...text.split('\n'))
      const trailing = file.content === '' || file.content.endsWith('\n') ? '\n' : ''
      next = `${lines.join('\n')}${trailing}`
      done =
        at === 0
          ? `Inserted text at the start of ${path}.`
          : `Inserted text after line ${at} of ${path}.`
    }
    if (next.length > maxFileChars) return tooLargeText(path, maxFileChars)
    const result = await fs.write(path, next, { ifVersion: file.version })
    if (!result.ok) return conflictText(path)
    await written({
      op: command.command,
      path,
      before: meta(file.version, file.content),
      after: meta(result.version, next),
    })
    return done
  }

  if (command.command === 'delete') {
    const checked = check(command.path, 'write')
    if (!checked.ok) return checked.text
    const { path } = checked
    const file = await fs.read(path)
    if (file === null) {
      return (await isDirectory(path))
        ? `ERROR: ${path} is a directory; delete its files one by one.`
        : missingText(path)
    }
    const result = await fs.delete(path, { ifVersion: file.version })
    if (!result.ok) return result.reason === 'missing' ? missingText(path) : conflictText(path)
    await written({ op: 'delete', path, before: meta(file.version, file.content) })
    return `Deleted ${path}.`
  }

  // rename
  const from = check(command.old_path, 'write')
  if (!from.ok) return from.text
  const to = check(command.new_path, 'write')
  if (!to.ok) return to.text
  const file = await fs.read(from.path)
  if (file === null) {
    return (await isDirectory(from.path))
      ? `ERROR: ${from.path} is a directory; rename its files one by one.`
      : missingText(from.path)
  }
  const exists = `ERROR: ${to.path} already exists.`
  if (from.path === to.path || (await fs.read(to.path)) !== null) return exists
  if (await isDirectory(to.path)) return `ERROR: ${to.path} is a directory.`
  if (fs.move !== undefined) {
    const moved = await fs.move(from.path, to.path, { ifVersion: file.version })
    if (!moved.ok) {
      if (moved.reason === 'exists') return exists
      return moved.reason === 'missing' ? missingText(from.path) : conflictText(from.path)
    }
  } else {
    const copy = await fs.write(to.path, file.content, { ifVersion: null })
    if (!copy.ok) return copy.reason === 'exists' ? exists : conflictText(to.path)
    const removed = await fs.delete(from.path, { ifVersion: file.version })
    if (!removed.ok) {
      // best effort: remove the copy again so nothing is duplicated
      try {
        await fs.delete(to.path, { ifVersion: copy.version })
      } catch {
        // the source failure is what the model needs to know about
      }
      return conflictText(from.path)
    }
  }
  const same = meta(file.version, file.content)
  await written({ op: 'rename', path: from.path, to: to.path, before: same, after: same })
  return `Renamed ${from.path} to ${to.path}.`
}
