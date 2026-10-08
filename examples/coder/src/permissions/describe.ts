/**
 * Human-readable descriptions of tool calls for the approval prompt: a one-line title, a detail
 * (command, unified diff or plan) and the rule offered for "don't ask again".
 */
import { createTwoFilesPatch } from 'diff'
import type { FileSystem } from 'eharness/filesystem'
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
  const oldString = str(call.input, 'old_string') ?? ''
  const newString = str(call.input, 'new_string') ?? ''
  const all = (call.input as { replace_all?: unknown } | null | undefined)?.replace_all === true
  const current = await readText(fs, path)
  if (typeof current === 'string' && oldString !== '' && current.includes(oldString)) {
    const next = all
      ? current.split(oldString).join(newString)
      : current.replace(oldString, () => newString)
    return patch(path, current, next)
  }
  return truncate(`--- old\n${oldString}\n+++ new\n${newString}`, MAX_DETAIL)
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
    const result: ApprovalDescription = { title }
    if (detail !== undefined) result.detail = detail
    if (suggestedRule !== undefined) result.suggestedRule = suggestedRule
    return result
  }
  const input = call.input
  const path = str(input, 'path') ?? ''
  switch (call.toolName) {
    case TOOL.bash: {
      const command = str(input, 'command') ?? ''
      const description = str(input, 'description')
      return out(`Bash: ${oneLine(description ?? command)}`, command)
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
    case TOOL.exitPlan:
      return out('Plan ready: start implementing?', str(input, 'plan'))
    case TOOL.dirAccess: {
      const reason = str(input, 'reason')
      return out(`Access directory ${path}`, reason === undefined ? path : `${path}\n\n${reason}`)
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
