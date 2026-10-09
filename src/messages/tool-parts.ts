/**
 * Helpers for tool parts of UI messages (internal).
 *
 * @see docs/decisions/0014-interrupted-tool-calls-answered.md
 */
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai'

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

/**
 * True for `tool-<name>` and `dynamic-tool` parts: AI SDK `isToolUIPart` for loosely typed parts
 * (stored or client data). Typed `UIMessage` parts should use `isToolUIPart` directly.
 */
export function isToolPart(part: { type: string }): part is ToolPartLike {
  return isToolUIPart(part as AnyPart)
}

/** Tool name of a loosely typed tool part (AI SDK `getToolName`). */
export function toolNameOf(part: ToolPartLike): string {
  return String(getToolName(part as unknown as ToolUIPart | DynamicToolUIPart))
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
    if (!isToolUIPart(original)) return original
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

/**
 * Replace the deprecated `rawInput` of `output-error` tool parts by `input` (AI SDK's UI stream
 * sets `rawInput` when a call's input failed to parse; `convertToModelMessages` and
 * `validateUIMessages` warn about it). `input` is only filled when it is undefined. Returns the
 * same message object when nothing changed, otherwise a shallow copy with new parts.
 */
export function normalizeRawInput<M extends UIMessage>(message: M): M {
  let changed = false
  const parts = message.parts.map((part): AnyPart => {
    const p = part as { type?: unknown; state?: unknown } & Record<string, unknown>
    if (
      typeof p.type !== 'string' ||
      !isToolPart(p as { type: string }) ||
      p.state !== 'output-error' ||
      !Object.hasOwn(p, 'rawInput')
    )
      return part
    changed = true
    const { rawInput, ...rest } = p
    return (
      rest.input === undefined && rawInput !== undefined ? { ...rest, input: rawInput } : rest
    ) as AnyPart
  })
  return changed ? { ...message, parts } : message
}
