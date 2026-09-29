/**
 * Flat-text transcript of the messages a compaction summarizes (internal). Never raw tool
 * messages: some providers continue the markup instead of summarizing.
 *
 * @see docs/specs/06-compaction.md#53-summarize
 */
import type { FilePart, TextPart } from 'ai'
import { kindOf } from '../messages/kinds.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import { isToolPart, type ToolPartLike, toolNameOf } from '../messages/tool-parts.ts'
import type { HarnessUIMessage, InputPartData, ProjectionContext } from '../messages/types.ts'
import { truncateMiddle } from './truncate.ts'

/** Max characters of a tool input in the transcript. */
export const TRANSCRIPT_INPUT_CHARS = 500
/** Max characters of a tool output in the transcript. */
export const TRANSCRIPT_OUTPUT_CHARS = 2_000

/** Input of {@link renderTranscript}. */
export interface TranscriptInput {
  /** Summary of the previous marker, rendered first as `PREVIOUS SUMMARY:`. */
  previousSummary?: string | undefined
  /** Messages to render (already trimmed by `partial` where needed), id order. */
  messages: readonly HarnessUIMessage[]
  registry: MessageRegistry
  sessionId: string
}

type AnyPart = HarnessUIMessage['parts'][number]

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function fileLine(part: { mediaType?: unknown; filename?: unknown }): string {
  const name =
    typeof part.filename === 'string' && part.filename.length > 0 ? ` ${part.filename}` : ''
  return `[file ${String(part.mediaType ?? 'application/octet-stream')}${name}]`
}

function projectedText(result: string | Array<TextPart | FilePart> | TextPart | FilePart): string {
  if (typeof result === 'string') return result
  const parts = Array.isArray(result) ? result : [result]
  return parts
    .map((p) =>
      p.type === 'text'
        ? p.text
        : fileLine({ mediaType: p.mediaType, filename: (p as { filename?: unknown }).filename }),
    )
    .filter((t) => t.length > 0)
    .join('\n')
}

function toolLine(part: ToolPartLike): string {
  const input = truncateMiddle(stringify(part.input ?? {}), TRANSCRIPT_INPUT_CHARS)
  let output: string
  switch (part.state) {
    case 'output-available':
      output = stringify(part.output)
      break
    case 'output-error':
      output = `ERROR: ${stringify(part.errorText)}`
      break
    case 'output-denied': {
      const reason = (part.approval as { reason?: unknown } | undefined)?.reason
      output = typeof reason === 'string' && reason.length > 0 ? `DENIED: ${reason}` : 'DENIED'
      break
    }
    default:
      output = '(no result)'
  }
  return `TOOL ${toolNameOf(part)}(${input}) → ${truncateMiddle(output, TRANSCRIPT_OUTPUT_CHARS)}`
}

function inputLine(data: InputPartData): string {
  const prefix = data.source === 'user' ? 'USER' : data.source === 'event' ? 'EVENT' : 'NOTE'
  const lines = [data.text, ...(data.files ?? []).map((f) => fileLine(f))].filter(
    (t) => t.length > 0,
  )
  return `${prefix}: ${lines.join('\n')}`
}

/**
 * Render messages as transcript entries (one entry per block; join with a blank line):
 *
 * - the previous summary first, as `PREVIOUS SUMMARY:`;
 * - user/assistant text as `USER:` / `ASSISTANT:` (consecutive text parts of a message merged);
 * - tool calls as `TOOL <name>(<json input, 500 chars>) → <output, 2_000 chars>`;
 * - reasoning dropped; file parts as `[file <mediaType> <name>]`;
 * - `data-eh.input` parts in place as `USER:` / `EVENT:` / `NOTE:` (source user / event / plugin);
 * - other data parts via their `model` projection (omitted ones dropped), kinds via their
 *   projection as `EVENT:` entries.
 */
export function renderTranscriptEntries(input: TranscriptInput): string[] {
  const { registry } = input
  const entries: string[] = []
  if (input.previousSummary !== undefined && input.previousSummary.trim().length > 0) {
    entries.push(`PREVIOUS SUMMARY:\n${input.previousSummary.trim()}`)
  }
  for (const message of input.messages) {
    const ctx: ProjectionContext = { message, sessionId: input.sessionId }
    const kind = kindOf(message)
    if (kind !== undefined) {
      const registered = registry.kind(kind)
      const model = registered?.def.model
      if (registered === undefined || registered.def.boundary === true) continue
      if (model === undefined || model === 'omit') continue
      const part = message.parts[0] as { type: string; data?: unknown } | undefined
      if (part?.type !== `data-${kind}`) continue
      let result: ReturnType<typeof model>
      try {
        result = model(part.data, ctx)
      } catch {
        continue
      }
      if (result === null) continue
      const text = projectedText(result)
      if (text.length > 0) entries.push(`EVENT: ${text}`)
      continue
    }
    if (message.role === 'system') continue
    const prefix = message.role === 'user' ? 'USER' : 'ASSISTANT'
    let texts: string[] = []
    const flush = () => {
      const text = texts.join('\n').trim()
      if (text.length > 0) entries.push(`${prefix}: ${text}`)
      texts = []
    }
    for (const part of message.parts as AnyPart[]) {
      const loose = part as { type: string; [key: string]: unknown }
      if (loose.type === 'text') {
        texts.push(String(loose.text ?? ''))
        continue
      }
      if (loose.type === 'reasoning' || loose.type === 'reasoning-file') continue
      if (
        loose.type === 'step-start' ||
        loose.type === 'source-url' ||
        loose.type === 'source-document'
      )
        continue
      if (loose.type === 'file') {
        texts.push(fileLine(loose as { mediaType?: unknown; filename?: unknown }))
        continue
      }
      flush()
      if (isToolPart(loose)) {
        entries.push(toolLine(loose as ToolPartLike))
        continue
      }
      if (loose.type === 'data-eh.input') {
        entries.push(inputLine(loose.data as InputPartData))
        continue
      }
      if (loose.type.startsWith('data-')) {
        const text = dataPartText(loose as { type: string; data: unknown }, ctx, registry)
        if (text !== undefined && text.length > 0) entries.push(`${prefix}: ${text}`)
      }
    }
    flush()
  }
  return entries
}

/** The whole transcript as one string (entries separated by a blank line). */
export function renderTranscript(input: TranscriptInput): string {
  return renderTranscriptEntries(input).join('\n\n')
}

function dataPartText(
  part: { type: string; data: unknown },
  ctx: ProjectionContext,
  registry: MessageRegistry,
): string | undefined {
  const registered = registry.dataPart(part.type)
  if (registered === undefined || registered.def.transient === true) return undefined
  const model = registered.def.model
  if (model === undefined || model === 'omit') return undefined
  if (model === 'text') return `<data type="${registered.name}">${stringify(part.data)}</data>`
  try {
    const result = model(part.data, ctx)
    return result === undefined ? undefined : projectedText(result)
  } catch {
    return undefined
  }
}
