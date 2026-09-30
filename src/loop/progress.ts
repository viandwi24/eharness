/**
 * Progress tracking of a turn (internal): detects a model that repeats itself (the same call with
 * the same result) or keeps failing, and measures whether steps still produce something new —
 * used to stop stuck turns and to bound `turn.beforeEnd` continuations by progress instead of by
 * a fixed count.
 *
 * @see docs/specs/05-session-and-storage.md#32-progress-guard-normative
 */
import type { ModelMessage } from 'ai'
import type { ProgressConfig } from '../agent/types.ts'

/** Defaults of {@link ProgressConfig}. */
export const DEFAULT_PROGRESS = {
  repeats: 3,
  window: 20,
  errorStreak: 5,
  nudges: 1,
} as const

/** Why a turn looks stuck. */
export type StuckReason =
  | { kind: 'repeat'; toolName: string; count: number }
  | { kind: 'errors'; count: number }

/** Progress state of one turn. */
export interface ProgressTracker {
  /** Record one finished step (its response messages). Returns why the turn looks stuck, if it does. */
  observe(response: readonly ModelMessage[]): StuckReason | undefined
  /** Number of calls so far whose (call, result) had not been seen in the window and did not fail. */
  readonly novel: number
  /** Forget the window and the error streak (after a nudge the model gets a fresh chance). */
  reset(): void
}

/** JSON with sorted object keys, so equal values give equal strings. */
function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

/** 32-bit FNV-1a: the window keeps short keys instead of whole inputs and outputs. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

interface Call {
  key: string
  toolName: string
  error: boolean
}

function callsOf(response: readonly ModelMessage[], ignore: ReadonlySet<string>): Call[] {
  const inputs = new Map<string, { toolName: string; input: unknown }>()
  const calls: Call[] = []
  for (const message of response) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        inputs.set(part.toolCallId, { toolName: part.toolName, input: part.input })
      } else if (part.type === 'tool-result') {
        const call = inputs.get(part.toolCallId)
        const toolName = call?.toolName ?? part.toolName
        if (ignore.has(toolName)) continue
        const output = part.output as { type?: string; value?: unknown } | undefined
        if (output?.type === 'execution-denied') continue // a decision, not the model's doing
        calls.push({
          key: hash(`${toolName}\u0000${stable(call?.input)}\u0000${stable(output)}`),
          toolName,
          error: output?.type === 'error-text' || output?.type === 'error-json',
        })
      }
    }
  }
  return calls
}

/** Create the progress tracker of one turn. */
export function createProgressTracker(config: ProgressConfig = {}): ProgressTracker {
  const repeats = Math.max(2, config.repeats ?? DEFAULT_PROGRESS.repeats)
  const window = Math.max(1, config.window ?? DEFAULT_PROGRESS.window)
  const errorStreak = Math.max(1, config.errorStreak ?? DEFAULT_PROGRESS.errorStreak)
  const ignore = new Set(config.ignoreTools ?? [])
  /** Keys of the calls of the last `window` steps that called tools. */
  let steps: string[][] = []
  let failing = 0
  let novel = 0

  return {
    get novel() {
      return novel
    },
    observe(response) {
      const calls = callsOf(response, ignore)
      if (calls.length === 0) return undefined
      const seen = new Map<string, number>()
      for (const keys of steps) for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1)
      let stuck: StuckReason | undefined
      for (const call of calls) {
        const count = (seen.get(call.key) ?? 0) + 1
        seen.set(call.key, count)
        if (count === 1 && !call.error) novel++
        if (count >= repeats && stuck === undefined) {
          stuck = { kind: 'repeat', toolName: call.toolName, count }
        }
      }
      steps.push(calls.map((c) => c.key))
      if (steps.length > window) steps = steps.slice(-window)
      failing = calls.every((c) => c.error) ? failing + 1 : 0
      if (stuck === undefined && failing >= errorStreak) stuck = { kind: 'errors', count: failing }
      return stuck
    },
    reset() {
      steps = []
      failing = 0
    },
  }
}
