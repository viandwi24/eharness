/**
 * Pure description of a tool call for the transcript: label, one-line summary and status. No Ink
 * imports, so it can be unit-tested.
 */
import { getToolName, isToolUIPart } from 'ai'
import { diffLines } from 'diff'
import { classifyToolResult, isFileMediaRef } from 'eharness/filesystem'
import { editsOf } from '../app/edits.ts'
import type { AgentProgress, CoderMessage } from '../contracts.ts'
import { TOOL } from '../contracts.ts'

/** A tool part of a UI message, flattened. */
export interface ToolView {
  toolName: string
  toolCallId: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'approval-requested'
    | 'approval-responded'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
  input: unknown
  output?: unknown
  errorText?: string
  preliminary?: boolean
}

/** Status of a tool call, mapped to a color. */
export type ToolStatus = 'running' | 'waiting' | 'ok' | 'error' | 'denied'

/** Extra facts the card needs besides the part. */
export interface ToolContext {
  /** Live bash output (stdout and stderr interleaved) while the command runs. */
  bashLive?: string
  /** Wall-clock timing observed by the UI. */
  timing?: { start: number; end?: number }
  /** `data-filesystem.change` of the same message for the same path. */
  change?: { action: 'create' | 'write' | 'edit' | 'delete'; bytes?: number }
}

/** Result of {@link describeTool}. Rendered as `label(target)` and, below it, `⎿  summary`. */
export interface ToolDescription {
  /** Tool name shown in bold, e.g. `Read`, `Update`, `Bash`, `github - search (MCP)`. */
  label: string
  /** Short argument summary shown in parentheses (empty: no parentheses). */
  target: string
  /** Dim text after the call, e.g. the subagent type of a `Task`. */
  note?: string
  status: ToolStatus
  /** Result summary under the call (`Read 120 lines`, `exit 0 · 4.2s`); empty while running. */
  summary: string
  /** Render the summary red (bash: non-zero exit, timeout, abort). */
  summaryError?: boolean
  /** Error text (`Error: …`, `Denied by user`), shown red under the call. */
  error?: string
  /** Last lines of live output (bash while running). */
  tail?: string[]
}

/** Flatten a message part into a {@link ToolView}, or null when it is not a tool part. */
export function toolView(part: CoderMessage['parts'][number]): ToolView | null {
  if (!isToolUIPart(part)) return null
  const p = part as unknown as Record<string, unknown>
  return {
    toolName: getToolName(part),
    toolCallId: String(p.toolCallId),
    state: p.state as ToolView['state'],
    input: p.input,
    output: p.output,
    errorText: typeof p.errorText === 'string' ? p.errorText : undefined,
    preliminary: p.preliminary === true,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Path as shown to the user: the virtual path without its leading slash. */
export function displayPath(path: string): string {
  if (path === '/' || path === '') return '.'
  return path.startsWith('/') ? path.slice(1) : path
}

/** First line of a text, cut to `max` characters. */
export function firstLine(text: string, max = 100): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Last `count` non-empty lines of a text. */
export function tailLines(text: string, count: number): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count)
}

/** Count lines added and removed when `oldText` becomes `newText`. */
export function countChanges(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const part of diffLines(oldText, newText)) {
    const count = part.count ?? 0
    if (part.added) added += count
    else if (part.removed) removed += count
  }
  return { added, removed }
}

/** Additions and removals of an `edit_file` call, counted over all of its edits (`edits[]`). */
export function countEditChanges(input: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const edit of editsOf(input)) {
    const counts = countChanges(edit.oldString, edit.newString)
    added += counts.added
    removed += counts.removed
  }
  return { added, removed }
}

/** `4.2s` / `1m 05s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

/** Footer of a bash tool result (`shell/bash-tool.ts`), as parsed by {@link parseBashFooter}. */
export type BashFooter =
  | { kind: 'exit'; code: number; seconds?: number }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

/**
 * Parse the last non-empty line of a bash result: `Exit code <n> · <s>s`, `(timed out after Ns)`
 * or `(aborted after Ns)` (case-insensitive). Undefined when the output carries none of them.
 */
export function parseBashFooter(output: string): BashFooter | undefined {
  const lines = output.trimEnd().split('\n')
  const last = (lines[lines.length - 1] ?? '').trim()
  const exit = /^exit code (-?\d+)(?:\s*·\s*([\d.]+)s)?$/i.exec(last)
  if (exit) {
    return {
      kind: 'exit',
      code: Number(exit[1]),
      ...(exit[2] !== undefined ? { seconds: Number(exit[2]) } : {}),
    }
  }
  if (/^\(timed out after \d+s\)$/i.test(last)) return { kind: 'timeout' }
  if (/^\(aborted after [\d.]+s\)$/i.test(last)) return { kind: 'aborted' }
  return undefined
}

/** True when the output of the agent tool is a progress record. */
export function isAgentProgress(value: unknown): value is AgentProgress {
  const r = asRecord(value)
  return typeof r.status === 'string' && typeof r.agent === 'string' && typeof r.steps === 'number'
}

function baseStatus(view: ToolView): ToolStatus {
  switch (view.state) {
    case 'output-error':
      return 'error'
    case 'output-denied':
      return 'denied'
    case 'approval-requested':
      return 'waiting'
    case 'output-available':
      if (view.preliminary) return 'running'
      return typeof view.output === 'string' && classifyToolResult(view.output) !== 'ok'
        ? 'error'
        : 'ok'
    default:
      return 'running'
  }
}

function outputText(view: ToolView): string {
  if (typeof view.output === 'string') return view.output
  if (view.output === undefined) return ''
  // `read_file` of an image or PDF stores a small reference; its `text` is what the model reads
  if (isFileMediaRef(view.output)) return view.output.text
  return JSON.stringify(view.output)
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Library-provided tool names that are not in {@link TOOL} (eharness/subagent, shell, skills,
 * memory and core): never read as an MCP `server_tool`. Keep next to {@link TOOL}.
 */
const NON_MCP = new Set([
  'load_skill',
  'read_skill_file',
  'search_skills',
  'tool_search',
  'bash_output',
  'kill_shell',
  'agent_output',
  'agent_stop',
  'send_message',
  'memory_view',
  'memory_create',
  'memory_str_replace',
  'memory_insert',
  'memory_delete',
  'memory_rename',
  'todo_write',
  'ask_user_question',
  'exit_plan_mode',
  'request_directory_access',
  'web_fetch',
  'web_search',
  'read_file',
  'list_files',
  'edit_file',
  'write_file',
  'delete_file',
])

/**
 * Split an MCP tool name into server and tool: `mcp__server__tool`, or `server_tool` for any tool
 * outside the built-in set (the default tool prefix of `mcpServer()` is `<name>_`).
 */
export function splitMcpName(name: string): { server: string; tool: string } | undefined {
  const long = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (long) return { server: long[1] as string, tool: long[2] as string }
  if ((Object.values(TOOL) as string[]).includes(name) || NON_MCP.has(name)) return undefined
  const at = name.indexOf('_')
  if (at <= 0 || at === name.length - 1) return undefined
  return { server: name.slice(0, at), tool: name.slice(at + 1) }
}

/** `key: "value", key: 3` of a tool input, cut to `max` characters. */
export function argsSummary(input: unknown, max = 80): string {
  const entries = Object.entries(asRecord(input))
  const text = entries
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? '')}`,
    )
    .join(', ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Output lines of a bash result without its footer line. */
export function bashBody(output: string): string[] {
  const lines = output.replace(/\s+$/, '').split('\n')
  if (parseBashFooter(output)) lines.pop()
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  return lines
}

/** The `todos` of a `todo_write` input. */
export function todosOf(input: unknown): Array<{
  content: string
  status: string
  activeForm?: string
}> {
  const todos = asRecord(input).todos
  if (!Array.isArray(todos)) return []
  return todos.map((todo) => {
    const t = asRecord(todo)
    return {
      content: str(t.content),
      status: str(t.status) || 'pending',
      ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
    }
  })
}

function errorLine(message: string): string {
  const line = firstLine(message, 160)
  if (/^error:/i.test(line)) return `Error:${line.slice(6)}`
  return `Error: ${line}`
}

/** Shorten a URL for display: no scheme, no `www.`, no trailing slash, cut to `max` characters. */
export function shortUrl(url: string, max = 60): string {
  const bare = url
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare
}

function humanBytes(raw: string): string {
  const m = /^([\d.,]+)\s*(bytes?|b|kb|mb|gb)?$/i.exec(raw.trim())
  if (!m) return raw.trim()
  const n = Number((m[1] as string).replace(/,/g, ''))
  const unit = (m[2] ?? 'b').toLowerCase()
  if (Number.isNaN(n)) return raw.trim()
  if (unit.startsWith('b')) {
    if (n < 1024) return `${n}B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
    return `${(n / 1024 / 1024).toFixed(1)}MB`
  }
  return `${m[1]}${unit.toUpperCase()}`
}

/** Parsed `URL: <url> · <status> · <bytes>` header line of a `web_fetch` result (lenient). */
export interface FetchHeader {
  url?: string
  status?: string
  bytes?: string
}

/** Parse the header line of a `web_fetch` result; fields that are missing stay undefined. */
export function parseFetchHeader(output: string): FetchHeader {
  const line = output.split('\n').find((l) => /^url:/i.test(l.trim()))
  if (!line) return {}
  const parts = line
    .trim()
    .replace(/^url:\s*/i, '')
    .split(/\s+[·|]\s+/)
  const [url, a, b] = parts
  const header: FetchHeader = {}
  if (url) header.url = url.trim()
  for (const part of [a, b]) {
    if (!part) continue
    if (/^\d{3}\b/.test(part.trim()) || /^(status:?)/i.test(part.trim()))
      header.status = part.trim().replace(/^status:?\s*/i, '')
    else if (/\d/.test(part)) header.bytes = humanBytes(part.replace(/^(bytes|size):?\s*/i, ''))
  }
  return header
}

/** Number of sources in a `web_search` result: `Sources:` list entries, else distinct URLs. */
export function countSources(output: string): number {
  const lines = output.split('\n')
  const at = lines.findIndex((l) => /^sources:/i.test(l.trim()))
  if (at >= 0) {
    const inline = (lines[at] ?? '').replace(/^\s*sources:\s*/i, '').trim()
    const listed = lines.slice(at + 1).filter((l) => /^\s*(?:[-*]|\d+[.)])\s+\S/.test(l)).length
    if (listed > 0) return listed
    if (inline) return (inline.match(/https?:\/\/\S+/g) ?? [inline]).length
  }
  return new Set(output.match(/https?:\/\/[^\s)>\]"']+/g) ?? []).size
}

/** Names of the tools a `tool_search` result found (`{ tools: [{ name }] }`, maybe `{ type, value }`). */
export function foundToolNames(output: unknown): string[] {
  const rec = asRecord(output)
  const value = 'value' in rec && 'type' in rec ? rec.value : output
  const tools = asRecord(value).tools
  if (!Array.isArray(tools)) return []
  return tools.map((t) => asRecord(t).name).filter((n): n is string => typeof n === 'string')
}

/** Describe one tool call. */
export function describeTool(view: ToolView, ctx: ToolContext = {}): ToolDescription {
  const input = asRecord(view.input)
  let status = baseStatus(view)
  const text = outputText(view)
  const path = displayPath(str(input.path))
  const desc: ToolDescription = { label: view.toolName, target: '', summary: '', status }
  const ok = status === 'ok'

  switch (view.toolName) {
    case TOOL.read: {
      desc.label = 'Read'
      desc.target = path
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset !== undefined && limit !== undefined)
        desc.target += `, lines ${offset}–${offset + limit - 1}`
      else if (offset !== undefined) desc.target += `, from line ${offset}`
      if (ok) {
        // an image: `Image <path> (<w>x<h>, <bytes> bytes, <mediaType>)`
        desc.summary = isFileMediaRef(view.output)
          ? view.output.text
          : `Read ${plural(text.replace(/\s+$/, '').split('\n').length, 'line')}`
      }
      break
    }
    case TOOL.list: {
      desc.label = 'List'
      desc.target = displayPath(str(input.prefix) || '/')
      if (ok)
        desc.summary = `Found ${plural(text.startsWith('No files') ? 0 : countLines(text), 'file')}`
      break
    }
    case TOOL.glob: {
      desc.label = 'Glob'
      desc.target = str(input.pattern)
      if (ok)
        desc.summary = `Found ${plural(text.startsWith('No ') ? 0 : countLines(text.replace(/\n\(Showing \d+ of \d+ matches[^\n]*$/, '')), 'file')}`
      break
    }
    case TOOL.grep: {
      desc.label = 'Search'
      const parts = [`pattern: ${JSON.stringify(str(input.pattern))}`]
      if (str(input.path)) parts.push(`path: ${JSON.stringify(displayPath(str(input.path)))}`)
      if (str(input.glob)) parts.push(`glob: ${JSON.stringify(str(input.glob))}`)
      desc.target = parts.join(', ')
      if (ok)
        desc.summary = `Found ${plural(text.startsWith('No matches') ? 0 : countLines(text), 'match', 'matches')}`
      break
    }
    case TOOL.edit: {
      desc.label = 'Update'
      desc.target = path
      if (ok) {
        const { added, removed } = countEditChanges(input)
        const bits: string[] = []
        if (added > 0) bits.push(plural(added, 'addition'))
        if (removed > 0) bits.push(plural(removed, 'removal'))
        desc.summary = `Updated ${path}${bits.length > 0 ? ` with ${bits.join(' and ')}` : ''}`
      }
      break
    }
    case TOOL.write: {
      desc.label = 'Write'
      desc.target = path
      if (ok) {
        const lines = str(input.content).split('\n').length
        desc.summary = `${ctx.change?.action === 'create' ? 'Created' : 'Wrote'} ${plural(lines, 'line')} ${ctx.change?.action === 'create' ? 'in' : 'to'} ${path}`
      }
      break
    }
    case TOOL.delete: {
      desc.label = 'Delete'
      desc.target = path
      if (ok) desc.summary = `Deleted ${path}`
      break
    }
    case TOOL.bash: {
      desc.label = 'Bash'
      desc.target = firstLine(str(input.command), 90)
      if (status === 'running') {
        const tail = tailLines(ctx.bashLive ?? '', 5)
        if (tail.length > 0) desc.tail = tail
      } else if (view.state === 'output-available') {
        const footer = parseBashFooter(text)
        if (footer?.kind === 'timeout') desc.summary = 'timed out'
        else if (footer?.kind === 'aborted') desc.summary = 'aborted'
        else {
          const parts: string[] = []
          if (footer?.kind === 'exit') parts.push(`exit ${footer.code}`)
          if (footer?.kind === 'exit' && footer.seconds !== undefined)
            parts.push(`${footer.seconds.toFixed(1)}s`)
          else if (ctx.timing?.end !== undefined)
            parts.push(formatDuration(ctx.timing.end - ctx.timing.start))
          desc.summary = parts.join(' · ')
        }
        if (footer && (footer.kind !== 'exit' || footer.code !== 0)) {
          status = 'error'
          desc.summaryError = true
        }
      }
      break
    }
    case TOOL.todo: {
      desc.label = 'Update Todos'
      break
    }
    case TOOL.agent: {
      desc.label = 'Task'
      desc.target = firstLine(str(input.description), 90)
      desc.note = str(input.subagent_type) || 'general-purpose'
      break
    }
    case TOOL.sendMessage: {
      desc.label = `SendMessage → ${str(input.to)}`
      desc.note = firstLine(str(input.message), 100)
      if (ok && text) desc.summary = firstLine(text, 120)
      break
    }
    case 'agent_output': {
      desc.label = 'AgentOutput'
      desc.target = str(input.id)
      if (ok && text) {
        if (/is still running/.test(text)) desc.summary = 'still running'
        else if (/^ERROR/.test(text)) desc.summary = firstLine(text, 120)
        else
          desc.summary = `Read ${plural(countLines(text.split('\n\n').slice(1).join('\n\n')), 'line')}`
      }
      break
    }
    case 'agent_stop': {
      desc.label = 'AgentStop'
      desc.target = str(input.id)
      if (ok && text) desc.summary = firstLine(text, 120)
      break
    }
    case TOOL.ask: {
      desc.label = 'Ask'
      const questions = Array.isArray(input.questions) ? input.questions : []
      desc.target = questions
        .map((q) => str(asRecord(q).header))
        .filter(Boolean)
        .join(', ')
      if (ok && text) desc.summary = firstLine(text, 120)
      break
    }
    case TOOL.exitPlan: {
      desc.label = 'Plan'
      if (ok) desc.summary = 'Plan proposed'
      break
    }
    case TOOL.dirAccess: {
      desc.label = 'Directory access'
      desc.target = str(input.path)
      if (ok && text) desc.summary = firstLine(text, 120)
      break
    }
    case TOOL.webFetch: {
      desc.label = 'Fetch'
      desc.target = shortUrl(str(input.url))
      if (view.state === 'output-available' && !view.preliminary) {
        if (/^redirect:/i.test(text)) {
          status = 'ok'
          desc.summary = firstLine(text, 160)
        } else if (!/^error:/i.test(text)) {
          const h = parseFetchHeader(text)
          desc.summary = `Received ${h.bytes ?? `${text.length}B`}${h.status ? ` (${h.status})` : ''}`
        } else status = 'error'
      }
      break
    }
    case TOOL.webSearch: {
      desc.label = 'Web Search'
      desc.target = JSON.stringify(str(input.query))
      if (view.state === 'output-available' && !view.preliminary && !/^error:/i.test(text))
        desc.summary = `Did 1 search · ${plural(countSources(text), 'source')}`
      else if (/^error:/i.test(text)) status = 'error'
      break
    }
    case 'tool_search': {
      desc.label = 'Loaded tools'
      const names = foundToolNames(view.output)
      desc.target =
        names.length > 0
          ? names.join(', ')
          : str(input.query)
              .replace(/^select:/, '')
              .trim()
      if (ok && names.length === 0) desc.summary = 'No matching tools'
      break
    }
    case 'bash_output':
    case 'kill_shell': {
      desc.label = view.toolName === 'bash_output' ? 'BashOutput' : 'KillShell'
      desc.target = str(asRecord(view.input).id)
      break
    }
    default: {
      const mcp = splitMcpName(view.toolName)
      desc.label = mcp ? `${mcp.server} - ${mcp.tool} (MCP)` : view.toolName
      desc.target = argsSummary(view.input)
    }
  }

  const message = view.errorText ?? text
  if (view.state === 'output-denied') {
    status = 'denied'
    desc.error = 'Denied by user'
  } else if (status === 'error') {
    if (view.toolName !== TOOL.bash || view.state === 'output-error') {
      if (message) {
        desc.error = errorLine(message)
        if (/^(error: )?(denied|permission denied|rejected by user|plan mode)/i.test(message)) {
          status = 'denied'
          desc.error = firstLine(message, 160)
        }
      }
    }
  }
  if (status === 'waiting') desc.summary = 'awaiting approval'
  desc.status = status
  return desc
}
