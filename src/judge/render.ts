/**
 * Prompt rendering and the verdict cache key of the shared LLM judge engine (spec 15 §3, spec 18
 * §12): one renderer for the restricted transcript, the call under review and the framed prompt.
 *
 * @see docs/decisions/0060-shared-llm-judge-engine.md
 */
import { neutralizeTags } from '../messages/framing.ts'
import type { GuardTranscriptEntry } from '../registry/transcript.ts'

/** Marker appended to truncated transcript texts and inputs. */
export const JUDGE_TRUNCATED = '…[truncated]'

/** Frame tags of the judge prompt; the same names inside untrusted text are neutralised. */
const BLOCK_TAGS = ['policy', 'environment', 'transcript', 'action', 'system-reminder'] as const

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

/**
 * Cache key of a call: `<toolName>:<sha256 hex of the canonical JSON input>` (`crypto.subtle`).
 * With `scope` (instructions, policy, environment and judge model id) the hash covers it too, so a
 * changed rule set or judge never reuses an older verdict.
 */
export async function judgeKey(toolName: string, input: unknown, scope?: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    scope === undefined ? canonicalJson(input) : `${scope}\u0000${canonicalJson(input)}`,
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return `${toolName}:${hex}`
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - JUDGE_TRUNCATED.length)) + JUDGE_TRUNCATED
}

/** An input as JSON, or a truncated JSON string when it is longer than `max`. */
function boundedInput(input: unknown, max: number): unknown {
  const json = canonicalJson(input)
  return json.length <= max ? JSON.parse(json) : cut(json, max)
}

/** The call under review. */
export interface JudgeRenderCall {
  toolName: string
  input: unknown
  /** Tool risk (`'unknown'` when none). */
  risk?: string
  /** Tool kind (`shell`, `fetch`, …) when known. */
  kind?: string
  /** The command of a shell tool or the URL of a fetch tool, when there is one. */
  summary?: string
  /** Name of the (sub)agent making the call, when known. */
  agent?: string
}

/**
 * True when {@link renderCall} would cut the input (or the summary is longer than
 * `maxSummaryChars`): the judge would not see all of it, so the caller must not trust an `allow`.
 */
export function callTruncated(
  call: Pick<JudgeRenderCall, 'input' | 'summary'>,
  maxChars: number,
  maxSummaryChars: number,
): boolean {
  return (
    canonicalJson(call.input).length > Math.max(64, Math.floor(maxChars)) ||
    (call.summary?.length ?? 0) > maxSummaryChars
  )
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
export function renderCall(call: JudgeRenderCall, maxChars: number): string {
  return JSON.stringify(
    {
      toolName: call.toolName,
      ...(call.kind === undefined ? {} : { kind: call.kind }),
      ...(call.risk === undefined ? {} : { risk: call.risk }),
      ...(call.agent === undefined ? {} : { agent: call.agent }),
      ...(call.summary === undefined ? {} : { summary: call.summary }),
      input: boundedInput(call.input, Math.max(64, Math.floor(maxChars))),
    },
    null,
    2,
  )
}

/** Wrap text in a prompt block; the frame tags inside the text are neutralised. */
function block(tag: string, text: string): string {
  return `<${tag}>\n${neutralizeTags(text, BLOCK_TAGS)}\n</${tag}>`
}

/** The whole user prompt of one judge call: optional policy and environment, transcript, action. */
export function renderPrompt(values: {
  policy?: string
  environment?: string
  transcript: string
  call: string
}): string {
  const sections: string[] = []
  if (values.policy !== undefined && values.policy.trim() !== '') {
    sections.push(block('policy', values.policy.trim()))
  }
  if (values.environment !== undefined && values.environment.trim() !== '') {
    sections.push(block('environment', values.environment.trim()))
  }
  sections.push(block('transcript', values.transcript), block('action', values.call))
  return sections.join('\n\n')
}
