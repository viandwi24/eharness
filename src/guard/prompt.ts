/**
 * Judge prompt rendering and the verdict cache key of the approval guard (spec 15 §3, §4).
 *
 * @see docs/specs/15-guard-plugin.md
 */
import type { GuardTranscriptEntry } from '../index.ts'
import { fill, GUARD_PROMPT, GUARD_TRUNCATED } from './texts.ts'

/** Canonical JSON: object keys sorted recursively, `undefined` dropped, non-JSON values as strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value, new Set())) ?? 'null'
}

function canonical(value: unknown, seen: Set<unknown>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (value === undefined) return undefined
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonical(item, seen) ?? null)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = canonical((value as Record<string, unknown>)[key], seen)
      if (item !== undefined) out[key] = item
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/** Cache key of a call: `<toolName>:<sha256 hex of the canonical JSON input>` (`crypto.subtle`). */
export async function verdictKey(toolName: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return `${toolName}:${hex}`
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - GUARD_TRUNCATED.length)) + GUARD_TRUNCATED
}

/** An input as JSON, or a truncated JSON string when it is longer than `max`. */
function boundedInput(input: unknown, max: number): unknown {
  const json = canonicalJson(input)
  return json.length <= max ? JSON.parse(json) : cut(json, max)
}

/** Limits of the transcript view. */
export interface TranscriptLimits {
  maxMessages: number
  maxChars: number
}

/**
 * Render the transcript as a JSON array, one entry per line, newest last: the last
 * `maxMessages` entries, each cut to `maxChars`, oldest dropped until the whole fits `maxChars`.
 */
export function renderTranscript(
  entries: ReadonlyArray<GuardTranscriptEntry>,
  limits: TranscriptLimits,
): string {
  const recent = limits.maxMessages <= 0 ? [] : entries.slice(-limits.maxMessages)
  // leave room for the JSON wrapper so a single long entry still fits once cut
  const perEntry = Math.max(64, Math.floor(limits.maxChars) - 200)
  const lines = recent.map((entry) =>
    JSON.stringify(
      entry.role === 'user'
        ? { role: 'user', text: cut(entry.text, perEntry) }
        : {
            role: 'tool-call',
            toolName: entry.toolName,
            input: boundedInput(entry.input, perEntry),
          },
    ),
  )
  let total = lines.reduce((sum, line) => sum + line.length + 2, 2)
  while (lines.length > 0 && total > limits.maxChars) {
    total -= (lines.shift() as string).length + 2
  }
  return lines.length === 0 ? '[]' : `[\n${lines.join(',\n')}\n]`
}

/** The call under review, as JSON. */
export function renderCall(
  call: { toolName: string; input: unknown; risk: string },
  maxChars: number,
): string {
  return JSON.stringify(
    {
      toolName: call.toolName,
      risk: call.risk,
      input: boundedInput(call.input, Math.max(64, Math.floor(maxChars))),
    },
    null,
    2,
  )
}

/** The whole user prompt of one judge call. */
export function renderPrompt(values: { policy: string; transcript: string; call: string }): string {
  return fill(GUARD_PROMPT, values)
}
