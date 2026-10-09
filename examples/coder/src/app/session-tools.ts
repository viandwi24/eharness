/**
 * Session tools: names (`/rename`, the label of a branch), plain-text export (`/export`), the
 * n-th assistant answer (`/copy`) and the clipboard. Also the helpers the side question, recap and
 * rewind modules share: {@link loadView}, {@link renderToolPart} and {@link textOnly}. Copying a
 * session is the library's `session.fork()`.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename as renameFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { UIMessage } from 'ai'
import {
  type CompactionPayload,
  isKindMessage,
  type MessageAdapter,
  type StateAdapter,
} from 'eharness'
import type { CoderConfig, CoderMessage, SessionSummary } from '../contracts.ts'

/** The storage pair of the controller (`createStorage(config)`). */
export interface SessionStorage {
  messages: MessageAdapter
  state: StateAdapter
}

type AnyPart = UIMessage['parts'][number]

const kindOf = (m: UIMessage): string | undefined =>
  (m.metadata as { eharness?: { kind?: string } } | undefined)?.eharness?.kind

/** Joined text parts of a message. */
export function messageText(message: UIMessage, joiner = ''): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter((t) => t !== '')
    .join(joiner)
}

// ─── the model's view of a session ───────────────────────────────────────────────────────────

/**
 * The messages the model would see, approximately: the newest compaction marker (when the state
 * points at one) followed by the messages from its resume point on; kind messages other than
 * the marker are dropped. Stored data only: nothing is written.
 */
export async function loadView(
  storage: SessionStorage,
  sessionId: string,
): Promise<CoderMessage[]> {
  const state = await storage.state.get(sessionId)
  const ptr = state?.core.compaction
  let messages: CoderMessage[] | undefined
  let marker: CoderMessage | undefined
  if (ptr !== undefined) {
    const loaded = (await storage.messages.load({
      sessionId,
      fromId: ptr.resumeFromId ?? ptr.markerId,
    })) as CoderMessage[]
    marker = loaded.find((m) => m.id === ptr.markerId)
    if (marker !== undefined) messages = loaded
  }
  if (messages === undefined) {
    messages = (await storage.messages.load({ sessionId })) as CoderMessage[]
    marker = undefined
  }
  const start = marker !== undefined ? (ptr?.resumeFromId ?? marker.id) : ''
  const plain = messages.filter((m) => kindOf(m) === undefined && m.id >= start)
  return marker !== undefined ? [marker, ...plain] : plain
}

// ─── rendering ───────────────────────────────────────────────────────────────────────────────

const ARG_CHARS = 160
const RESULT_CHARS = 200

const oneLine = (text: string, max: number): string => {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

type ToolLike = {
  type: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

/** True for static (`tool-<name>`) and `dynamic-tool` parts. */
export function isToolPart(part: AnyPart): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** `[name({"a":1})] → first line of the result`. `resultChars: 0` omits the result. */
export function renderToolPart(
  part: AnyPart,
  opts: { resultChars?: number; argChars?: number } = {},
): string {
  const p = part as ToolLike
  const name = p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice('tool-'.length)
  let args = ''
  try {
    args = JSON.stringify(p.input ?? {}) ?? ''
  } catch {
    args = ''
  }
  const argMax = opts.argChars ?? ARG_CHARS
  if (args.length > argMax) args = `${args.slice(0, argMax - 1)}…`
  const head = `[${name}(${args})]`
  let result: string
  switch (p.state) {
    case 'output-available':
      result = typeof p.output === 'string' ? p.output : (safeJson(p.output) ?? '')
      break
    case 'output-error':
      result = `error: ${p.errorText ?? ''}`
      break
    case 'output-denied':
      result = 'denied'
      break
    case 'approval-requested':
    case 'approval-responded':
      result = 'awaiting approval'
      break
    default:
      result = 'no result'
  }
  return `${head} → ${oneLine(result, opts.resultChars ?? RESULT_CHARS)}`
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** One message as transcript lines: user text `> `-quoted, assistant text and tool lines. */
function renderMessage(message: UIMessage): string | undefined {
  if (message.role === 'user') {
    const chunks: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim() !== '') chunks.push(part.text)
      else if (part.type === 'file') chunks.push(`[file: ${part.filename ?? part.mediaType}]`)
    }
    if (chunks.length === 0) return undefined
    return chunks
      .join('\n')
      .split('\n')
      .map((l) => (l === '' ? '>' : `> ${l}`))
      .join('\n')
  }
  if (message.role !== 'assistant') return undefined
  const lines: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text.trim() !== '') lines.push(part.text.trim())
    } else if (isToolPart(part)) lines.push(renderToolPart(part))
  }
  return lines.length > 0 ? lines.join('\n\n') : undefined
}

/**
 * A readable plain-text transcript. User text is quoted with `> `, tool calls become
 * `[name(args)] → first line of result`; reasoning, data parts and kind messages (compaction
 * markers, notices) are left out.
 */
export function exportText(messages: readonly UIMessage[]): string {
  const blocks: string[] = []
  for (const message of messages) {
    if (kindOf(message) !== undefined) continue
    const block = renderMessage(message)
    if (block !== undefined) blocks.push(block)
  }
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''
}

/** Text of the n-th latest assistant message that has text (1 = latest). */
export function assistantText(messages: readonly UIMessage[], n = 1): string | undefined {
  let left = Math.max(1, Math.floor(n))
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'assistant' || kindOf(m) !== undefined) continue
    const text = messageText(m, '\n\n').trim()
    if (text === '') continue
    if (--left === 0) return text
  }
  return undefined
}

/**
 * Messages reduced to plain text and files for a model call without tools: tool calls and
 * results become `[name(args)] → result` text, reasoning and data parts are dropped and the
 * compaction marker becomes a summary note. Safe for providers that reject tool history without
 * tool definitions.
 */
export function textOnly(
  messages: readonly CoderMessage[],
  opts: { resultChars?: number } = {},
): UIMessage[] {
  const out: UIMessage[] = []
  for (const message of messages) {
    if (isKindMessage(message, 'eh.compaction')) {
      const data = (message.parts[0] as { data?: CompactionPayload } | undefined)?.data
      if (data?.summary)
        out.push({
          id: message.id,
          role: 'user',
          parts: [{ type: 'text', text: `Summary of the earlier conversation:\n${data.summary}` }],
        })
      continue
    }
    if (kindOf(message) !== undefined || (message.role !== 'user' && message.role !== 'assistant'))
      continue
    const parts: UIMessage['parts'] = []
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (part.text.trim() !== '') parts.push({ type: 'text', text: part.text })
      } else if (part.type === 'file') {
        if (message.role === 'user') parts.push(part)
      } else if (isToolPart(part)) {
        parts.push({
          type: 'text',
          text: renderToolPart(part, { resultChars: opts.resultChars ?? 500, argChars: 300 }),
        })
      }
    }
    if (parts.length > 0) out.push({ id: message.id, role: message.role, parts })
  }
  return out
}

// ─── names ───────────────────────────────────────────────────────────────────────────────────

async function readNames(file: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== '') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** Session names (`<projectDataDir>/session-names.json`), cached in memory for sync reads. */
export interface SessionNames {
  nameOf(id: string): string | undefined
  /** An empty name removes the entry. */
  rename(id: string, name: string): Promise<void>
  /** Re-read the file (another process may have renamed sessions). */
  reload(): Promise<void>
  /** Summaries with `name` set; re-reads the file first. Use on the result of `listSessions`. */
  withNames(summaries: SessionSummary[]): Promise<SessionSummary[]>
}

/** Load the names file. */
export async function createSessionNames(projectDataDir: string): Promise<SessionNames> {
  const file = join(projectDataDir, 'session-names.json')
  let names = await readNames(file)
  let writing: Promise<unknown> = Promise.resolve()
  return {
    nameOf: (id) => names[id],
    async rename(id, name) {
      const clean = name.replace(/\s+/g, ' ').trim()
      const run = writing.then(async () => {
        // merge with what is on disk so another process's names survive
        const next = { ...(await readNames(file)) }
        if (clean === '') delete next[id]
        else next[id] = clean
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${crypto.randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
        await renameFile(temp, file)
        names = next
      })
      writing = run.catch(() => {})
      await run
    },
    async reload() {
      names = await readNames(file)
    },
    async withNames(summaries) {
      names = await readNames(file)
      return summaries.map((s) => (names[s.id] !== undefined ? { ...s, name: names[s.id] } : s))
    },
  }
}

// ─── clipboard ───────────────────────────────────────────────────────────────────────────────

/** Result of {@link copyToClipboard}. */
export interface ClipboardResult {
  copied: boolean
  /** The command that copied, or `osc52` when none worked. */
  method: string
  /** Escape sequence for the UI to write to the terminal when no command worked. */
  osc52?: string
}

/** The OSC 52 sequence that asks the terminal to put `text` on the clipboard. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`
}

/** Runs a command with `input` on stdin; resolves whether it exited 0. */
export type RunCommand = (cmd: string, args: string[], input: string) => Promise<boolean>

const spawnCommand: RunCommand = (cmd, args, input) =>
  new Promise((done) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } catch {
      done(false)
    }
  })

/**
 * Copy with `pbcopy` (macOS), `wl-copy` / `xclip` / `xsel` (Linux) or `clip` (Windows); when none
 * works the OSC 52 sequence is returned for the UI to write to the terminal.
 */
export async function copyToClipboard(
  text: string,
  opts: { run?: RunCommand; platform?: NodeJS.Platform } = {},
): Promise<ClipboardResult> {
  const run = opts.run ?? spawnCommand
  const platform = opts.platform ?? process.platform
  const candidates: Array<[string, string[]]> =
    platform === 'darwin'
      ? [['pbcopy', []]]
      : platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ]
  for (const [cmd, args] of candidates) {
    if (await run(cmd, args, text)) return { copied: true, method: cmd }
  }
  return { copied: false, method: 'osc52', osc52: osc52(text) }
}

// ─── factory ─────────────────────────────────────────────────────────────────────────────────

/** Dependencies of {@link createSessionTools}. */
export interface SessionToolsDeps {
  config: Pick<CoderConfig, 'root' | 'projectDataDir'>
  storage: SessionStorage
  /** The id of the current session (the controller's `sessionId`). */
  sessionId: () => string
  /** Clipboard command runner (tests). */
  run?: RunCommand
}

export interface SessionTools {
  names: SessionNames
  /** Name a branch (`session.fork()` of `from` is `to`): the given name, else `<name> (branch)`. */
  nameBranch(from: string, to: string, name?: string): Promise<void>
  /** Rename the current session. */
  rename(name: string): Promise<void>
  /** Name of the current session (sync; `CoderController.sessionName`). */
  sessionName(): string | undefined
  exportText(messages: readonly UIMessage[]): string
  /** Write a transcript to `file` (relative to the project root) or `<root>/coder-export-<timestamp>.txt`. Returns the absolute path. */
  writeExport(text: string, file?: string): Promise<string>
  assistantText(messages: readonly UIMessage[], n?: number): string | undefined
  copyToClipboard(text: string): Promise<ClipboardResult>
  /** `listSessions(config)` result with names. */
  withNames(summaries: SessionSummary[]): Promise<SessionSummary[]>
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Timestamp `YYYYMMDD-HHMMSS` in local time. */
function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export async function createSessionTools(deps: SessionToolsDeps): Promise<SessionTools> {
  const names = await createSessionNames(deps.config.projectDataDir)
  return {
    names,
    async nameBranch(from, to, name) {
      const current = names.nameOf(from)
      const label = name?.trim() || (current !== undefined ? `${current} (branch)` : '')
      if (label !== '') await names.rename(to, label)
    },
    rename: (name) => names.rename(deps.sessionId(), name),
    sessionName: () => names.nameOf(deps.sessionId()),
    exportText,
    async writeExport(text, file) {
      const target = file?.trim()
        ? isAbsolute(file)
          ? file
          : resolve(deps.config.root, file)
        : join(deps.config.root, `coder-export-${stamp(new Date())}.txt`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
      return target
    },
    assistantText,
    copyToClipboard: (text) => copyToClipboard(text, deps.run ? { run: deps.run } : {}),
    withNames: (summaries) => names.withNames(summaries),
  }
}
