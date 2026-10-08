/**
 * Pure description of a tool call for the transcript: label, one-line summary and status. No Ink
 * imports, so it can be unit-tested.
 */
import { getToolName, isToolUIPart } from 'ai'
import { diffLines } from 'diff'
import { classifyToolResult } from 'eharness/filesystem'
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

/** Result of {@link describeTool}. */
export interface ToolDescription {
  /** Verb or tool label, e.g. `Read`, `Edited`, `Bash`. */
  label: string
  /** Text after the label. */
  target: string
  /** Dim suffix, e.g. `(lines 120–180)` or `exit 0 · 4.2s`. */
  suffix: string
  status: ToolStatus
  /** First line of an error, shown under the card. */
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

/** `4.2s` / `1m 05s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

/** Exit code in a bash tool result, when the text carries one. */
export function parseExitCode(output: string): number | undefined {
  const match = /\bexit(?:ed)?(?: with)?(?: code| status)?[:= ]+(-?\d+)/i.exec(output)
  return match ? Number(match[1]) : undefined
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
  return JSON.stringify(view.output)
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length
}

/** Describe one tool call. */
export function describeTool(view: ToolView, ctx: ToolContext = {}): ToolDescription {
  const input = asRecord(view.input)
  const status = baseStatus(view)
  const done = status !== 'running' && status !== 'waiting'
  const text = outputText(view)
  const path = displayPath(str(input.path))
  const desc: ToolDescription = { label: view.toolName, target: '', suffix: '', status }

  switch (view.toolName) {
    case TOOL.read: {
      desc.label = done ? 'Read' : 'Reading'
      desc.target = path
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset !== undefined && limit !== undefined) {
        desc.suffix = `(lines ${offset}–${offset + limit - 1})`
      } else if (offset !== undefined) desc.suffix = `(from line ${offset})`
      else if (limit !== undefined) desc.suffix = `(first ${limit} lines)`
      break
    }
    case TOOL.list: {
      desc.label = 'List'
      desc.target = displayPath(str(input.prefix) || '/')
      if (status === 'ok')
        desc.suffix = `(${text.startsWith('No files') ? 0 : countLines(text)} files)`
      break
    }
    case TOOL.glob: {
      desc.label = 'Glob'
      desc.target = str(input.pattern)
      if (status === 'ok') desc.suffix = `(${text.startsWith('No ') ? 0 : countLines(text)} files)`
      break
    }
    case TOOL.grep: {
      desc.label = 'Grep'
      desc.target = `"${str(input.pattern)}"`
      if (status === 'ok') {
        desc.suffix = `(${text.startsWith('No matches') ? 0 : countLines(text)} matches)`
      }
      break
    }
    case TOOL.edit: {
      desc.label = done ? 'Edited' : 'Editing'
      desc.target = path
      if (status === 'ok') {
        const { added, removed } = countChanges(str(input.old_string), str(input.new_string))
        desc.suffix = `(+${added} −${removed})`
      }
      break
    }
    case TOOL.write: {
      desc.label = done ? (ctx.change?.action === 'create' ? 'Created' : 'Wrote') : 'Writing'
      desc.target = path
      if (status === 'ok') {
        const lines = str(input.content).split('\n').length
        desc.suffix = `(${lines} lines)`
      }
      break
    }
    case TOOL.delete: {
      desc.label = done ? 'Deleted' : 'Deleting'
      desc.target = path
      break
    }
    case TOOL.bash: {
      desc.label = 'Bash:'
      desc.target = firstLine(str(input.command), 90)
      if (status === 'running') {
        const tail = tailLines(ctx.bashLive ?? '', 5)
        if (tail.length > 0) desc.tail = tail
      } else if (view.state === 'output-available') {
        const code = parseExitCode(text)
        const parts: string[] = []
        if (code !== undefined) parts.push(`exit ${code}`)
        if (ctx.timing?.end !== undefined)
          parts.push(formatDuration(ctx.timing.end - ctx.timing.start))
        desc.suffix = parts.join(' · ')
        if (code !== undefined && code !== 0) desc.status = 'error'
      }
      break
    }
    case TOOL.todo: {
      desc.label = 'Todos'
      const todos = asRecord(view.input).todos
      desc.target = Array.isArray(todos) ? `updated (${todos.length} items)` : 'updated'
      break
    }
    case TOOL.agent: {
      desc.label = 'Agent'
      desc.target = `${str(input.subagent_type) || 'general-purpose'}: ${str(input.description)}`
      break
    }
    case TOOL.exitPlan: {
      desc.label = 'Plan'
      desc.target = 'proposed'
      break
    }
    case TOOL.dirAccess: {
      desc.label = 'Directory access'
      desc.target = str(input.path)
      break
    }
    default: {
      desc.label = view.toolName
      const json = JSON.stringify(view.input ?? {})
      desc.target = json.length > 80 ? `${json.slice(0, 79)}…` : json
    }
  }

  if (desc.status === 'error' || desc.status === 'denied') {
    const message = view.errorText ?? text
    if (message && view.toolName !== TOOL.bash) desc.error = firstLine(message, 160)
    else if (view.state === 'output-error' && view.errorText) desc.error = firstLine(view.errorText)
  }
  if (view.state === 'output-denied') desc.error = 'denied'
  if (status === 'waiting') desc.suffix = 'awaiting approval'
  return desc
}
