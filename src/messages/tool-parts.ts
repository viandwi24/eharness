/**
 * Helpers for tool parts of UI messages (internal).
 *
 * @see docs/decisions/0014-interrupted-tool-calls-answered.md
 */
import type { UIMessage } from 'ai'

type AnyPart = UIMessage['parts'][number]

/** A static (`tool-<name>`) or dynamic (`dynamic-tool`) tool part, loosely typed. */
export interface ToolPartLike {
  type: string
  toolCallId: string
  state: string
  input?: unknown
  preliminary?: boolean
  approval?: { id: string; approved?: boolean }
  [key: string]: unknown
}

/** True for `tool-<name>` and `dynamic-tool` parts. */
export function isToolPart(part: { type: string }): part is ToolPartLike {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** Tool name of a tool part. */
export function toolNameOf(part: ToolPartLike): string {
  return part.type === 'dynamic-tool' ? String(part.toolName) : part.type.slice(5)
}

/**
 * True when the part has a final result: `output-available` (not preliminary), `output-error`
 * or `output-denied`.
 */
export function hasToolResult(part: ToolPartLike): boolean {
  return (
    (part.state === 'output-available' && part.preliminary !== true) ||
    part.state === 'output-error' ||
    part.state === 'output-denied'
  )
}

/**
 * Answer every tool part without a result with an `output-error` part carrying `errorText`
 * (ADR-0014), except parts for which `keep(part)` returns true. Returns the same message object
 * when nothing changed, otherwise a shallow copy with new parts.
 *
 * The patched part keeps `type`, `toolCallId`, `toolName` (dynamic tools), `title`,
 * `providerExecuted` and `callProviderMetadata`; `input` falls back to `{}` when the call never
 * finished streaming its input. Approval objects are removed: an interrupted call has neither a
 * pending request nor an executable response.
 */
export function answerDanglingToolParts<M extends { parts: AnyPart[] }>(
  message: M,
  errorText: string,
  keep: (part: ToolPartLike) => boolean = () => false,
): M {
  let changed = false
  const parts = message.parts.map((original) => {
    if (!isToolPart(original)) return original
    const part = original as unknown as ToolPartLike
    if (hasToolResult(part) || keep(part)) return original
    changed = true
    const patched: Record<string, unknown> = {
      type: part.type,
      toolCallId: part.toolCallId,
      state: 'output-error',
      input: part.input ?? {},
      errorText,
    }
    for (const key of [
      'toolName',
      'title',
      'toolMetadata',
      'providerExecuted',
      'callProviderMetadata',
    ]) {
      if (part[key] !== undefined) patched[key] = part[key]
    }
    return patched as unknown as AnyPart
  })
  return changed ? { ...message, parts } : message
}
