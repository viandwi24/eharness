/**
 * Human-readable descriptions of tool calls for the approval prompt: a one-line title, a detail
 * (command, unified diff or plan) and the rule offered for "don't ask again".
 */
import { realpath } from 'node:fs/promises'
import { createTwoFilesPatch } from 'diff'
import type { FileSystem } from 'eharness/filesystem'
import { editsOf } from '../app/edits.ts'
import {
  type ApprovalRequest,
  type PermissionEngine,
  TOOL,
  type ToolCallInfo,
} from '../contracts.ts'

/** The parts of an {@link ApprovalRequest} that describe the call. */
export type ApprovalDescription = Pick<ApprovalRequest, 'title' | 'detail' | 'suggestedRule'>

const MAX_DETAIL = 20_000
const MAX_TITLE = 120

function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}

/**
 * Remove terminal control sequences (CSI and OSC escapes, other escapes, control characters except
 * newline and tab): a prompt must not be able to redraw itself or hide what it asks.
 */
function clean(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x1b) {
      const next = text[i + 1]
      if (next === '[') {
        i += 2
        while (i < text.length && (text.charCodeAt(i) < 0x40 || text.charCodeAt(i) > 0x7e)) i++
      } else if (next === ']') {
        i += 2
        while (i < text.length && text[i] !== '\u0007') {
          if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') {
            i++
            break
          }
          i++
        }
      } else {
        i++
      }
      continue
    }
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) continue
    out += text[i]
  }
  return out
}

/** First line of a text, cut to `max` characters. */
function firstLine(text: string, max: number): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

function oneLine(text: string, max = MAX_TITLE): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function patch(path: string, before: string, after: string): string {
  return truncate(createTwoFilesPatch(path, path, before, after, 'before', 'after'), MAX_DETAIL)
}

async function readText(fs: FileSystem, path: string): Promise<string | null | undefined> {
  try {
    const entry = await fs.read(path)
    return entry === null ? null : entry.content
  } catch {
    return undefined
  }
}

async function describeEdit(call: ToolCallInfo, fs: FileSystem): Promise<string | undefined> {
  const path = str(call.input, 'path') ?? ''
  const edits = editsOf(call.input)
  const current = await readText(fs, path)
  if (typeof current === 'string' && edits.length > 0) {
    // every edit is applied in order to the result of the previous one (all or nothing)
    let next: string | undefined = current
    for (const edit of edits) {
      if (edit.oldString === '' || !next.includes(edit.oldString)) {
        next = undefined
        break
      }
      next = edit.replaceAll
        ? next.split(edit.oldString).join(edit.newString)
        : next.replace(edit.oldString, () => edit.newString)
    }
    if (next !== undefined) return patch(path, current, next)
  }
  return truncate(
    edits.map((e) => `--- old\n${e.oldString}\n+++ new\n${e.newString}`).join('\n\n'),
    MAX_DETAIL,
  )
}

async function describeWrite(call: ToolCallInfo, fs: FileSystem): Promise<string> {
  const path = str(call.input, 'path') ?? ''
  const content = str(call.input, 'content') ?? ''
  const current = await readText(fs, path)
  if (typeof current === 'string') return patch(path, current, content)
  return truncate(`New file (${content.length} characters)\n${content}`, MAX_DETAIL)
}

/**
 * Describe a tool call for the approval prompt.
 *
 * @param call - The call being approved.
 * @param fs - The workspace file system (to diff edits against the current content).
 * @param engine - Supplies the "don't ask again" rule.
 */
export async function describeApproval(
  call: ToolCallInfo,
  fs: FileSystem,
  engine: PermissionEngine,
): Promise<ApprovalDescription> {
  const suggestedRule = engine.suggestRule(call)
  const out = (title: string, detail?: string): ApprovalDescription => {
    const result: ApprovalDescription = { title: clean(title) }
    if (detail !== undefined) result.detail = clean(detail)
    if (suggestedRule !== undefined) result.suggestedRule = suggestedRule
    return result
  }
  const input = call.input
  const path = str(input, 'path') ?? ''
  switch (call.toolName) {
    case TOOL.bash: {
      const command = clean(str(input, 'command') ?? '')
      const description = str(input, 'description')
      // the title shows the command, never the model's own description of it
      return out(
        `Bash: ${firstLine(command, 100)}`,
        description === undefined || description === ''
          ? command
          : `${command}\n\nDescription (written by the model): ${description}`,
      )
    }
    case TOOL.edit:
      return out(`Edit ${path}`, await describeEdit(call, fs))
    case TOOL.write:
      return out(`Write ${path}`, await describeWrite(call, fs))
    case TOOL.delete:
      return out(`Delete ${path}`)
    case TOOL.agent:
      return out(
        `Agent ${str(input, 'subagent_type') ?? ''}: ${oneLine(str(input, 'description') ?? '')}`,
        str(input, 'prompt'),
      )
    case TOOL.webFetch: {
      const url = oneLine(str(input, 'url') ?? '', 300)
      const prompt = str(input, 'prompt')
      return out(`Fetch ${url}`, prompt === undefined || prompt === '' ? undefined : prompt)
    }
    case TOOL.webSearch: {
      const allowed = (input as { allowed_domains?: unknown } | null)?.allowed_domains
      const blocked = (input as { blocked_domains?: unknown } | null)?.blocked_domains
      const lines: string[] = []
      if (Array.isArray(allowed) && allowed.length > 0) lines.push(`Only: ${allowed.join(', ')}`)
      if (Array.isArray(blocked) && blocked.length > 0) lines.push(`Not: ${blocked.join(', ')}`)
      return out(
        `Web search: ${oneLine(str(input, 'query') ?? '', 200)}`,
        lines.length > 0 ? lines.join('\n') : undefined,
      )
    }
    case TOOL.exitPlan:
      return out('Plan ready: start implementing?', str(input, 'plan'))
    case TOOL.dirAccess: {
      const reason = str(input, 'reason')
      let real = path
      try {
        real = await realpath(path)
      } catch {
        // missing path: show it as requested
      }
      const shown =
        real === path ? path : `${real}\n(requested ${path}, which is a symlink to ${real})`
      return out(`Access directory ${real}`, reason === undefined ? shown : `${shown}\n\n${reason}`)
    }
    default: {
      let json: string
      try {
        json = JSON.stringify(input, null, 2) ?? ''
      } catch {
        json = String(input)
      }
      return out(call.toolName, truncate(json, 2_000))
    }
  }
}
