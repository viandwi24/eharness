/**
 * The prune stage of compaction (internal): old, large tool outputs of completed turns are
 * replaced by a short placeholder in the request only — before the summarizer runs. View-only and
 * deterministic: stored messages never change, the same view gives the same wire.
 *
 * @see docs/specs/06-compaction.md#50-prune
 */
import type { ModelMessage, ToolResultPart } from 'ai'
import type { CompactionConfig, PruneConfig } from '../agent/types.ts'
import { TOOL_OUTPUT_PRUNED } from '../messages/texts.ts'
import { asMediaRef, FILE_TOKENS } from './tokens.ts'

/** Default `prune.keepTurns`. */
export const DEFAULT_PRUNE_KEEP_TURNS = 2
/** Default `prune.minChars`. */
export const DEFAULT_PRUNE_MIN_CHARS = 2_000

/** `compaction.prune` with defaults applied. */
export interface ResolvedPrune {
  keepTurns: number
  minChars: number
  exclude: ReadonlySet<string>
  replaceWith: ((part: ToolResultPart) => string) | undefined
}

/** What prune replaced: number of outputs and characters saved (original − placeholder). */
export interface PruneStats {
  outputs: number
  chars: number
}

/** Resolve `compaction.prune`; `undefined` when pruning is off (default). */
export function resolvePrune(
  compaction: CompactionConfig | false | undefined,
): ResolvedPrune | undefined {
  if (compaction === false || compaction === undefined) return undefined
  const config: PruneConfig | false | undefined = compaction.prune
  if (config === undefined || config === false) return undefined
  return {
    keepTurns: config.keepTurns ?? DEFAULT_PRUNE_KEEP_TURNS,
    minChars: config.minChars ?? DEFAULT_PRUNE_MIN_CHARS,
    exclude: new Set(config.exclude ?? []),
    replaceWith: config.replaceWith,
  }
}

function json(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

type ToolOutput = ToolResultPart['output']

/**
 * Size, in characters, counted for one non-text item of a `content` output (an image or file:
 * `FILE_TOKENS × 4`). Fixed, so base64 data does not inflate `stats.chars`.
 */
export const PRUNE_MEDIA_CHARS: number = FILE_TOKENS * 4

/**
 * Projected size of a tool output in characters, or `undefined` when the output is never pruned
 * (errors and `execution-denied`: short and meaningful).
 */
export function prunableChars(output: unknown): number | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  // stored data: typed as AI SDK's union, but every access stays defensive
  const o = output as ToolOutput
  switch (o.type) {
    case 'text':
      return typeof o.value === 'string' ? o.value.length : json(o.value).length
    case 'json': {
      const ref = asMediaRef(o.value)
      if (ref !== undefined) return ref.text.length + PRUNE_MEDIA_CHARS
      return json(o.value).length
    }
    case 'content': {
      let n = 0
      for (const item of Array.isArray(o.value) ? o.value : []) {
        n += item.type === 'text' ? String(item.text ?? '').length : PRUNE_MEDIA_CHARS
      }
      return n
    }
    case 'error-text':
    case 'error-json':
    case 'execution-denied':
      return undefined
    default:
      o satisfies never
      return undefined
  }
}

/** The default placeholder ({@link TOOL_OUTPUT_PRUNED}). */
export function prunedText(toolName: string, chars: number): string {
  return TOOL_OUTPUT_PRUNED.replace('{tool}', toolName).replace('{n}', String(chars))
}

function placeholder(part: ToolResultPart, chars: number, prune: ResolvedPrune): string {
  if (prune.replaceWith !== undefined) {
    try {
      const text = prune.replaceWith(part)
      if (typeof text === 'string') return text
    } catch {
      // a failing replaceWith falls back to the default placeholder (deterministic either way)
    }
  }
  return prunedText(part.toolName, chars)
}

/**
 * Prune the tool outputs of model messages (one or more completed turns). Only the `output` of
 * `tool-result` parts in `tool` messages is replaced: calls, ids, names and inputs stay, so pairs
 * are never split. Provider-executed results (inside assistant messages) are left alone. The
 * input is not mutated; unchanged messages are returned as is.
 */
export function pruneMessages(
  messages: readonly ModelMessage[],
  prune: ResolvedPrune,
): { messages: ModelMessage[]; stats: PruneStats } {
  const stats: PruneStats = { outputs: 0, chars: 0 }
  const out = messages.map((message) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result' || prune.exclude.has(part.toolName)) return part
      const chars = prunableChars(part.output)
      if (chars === undefined || chars <= prune.minChars) return part
      const value = placeholder(part, chars, prune)
      changed = true
      stats.outputs++
      stats.chars += Math.max(0, chars - value.length)
      return { ...part, output: { type: 'text' as const, value } }
    })
    return changed ? { ...message, content } : message
  })
  return { messages: out, stats }
}

/**
 * Prune the completed turns of a turn wire (`turns` oldest first, each the projection of one
 * turn): every turn except the newest `keepTurns` is pruned. The current turn is never passed in.
 */
export function pruneTurns(
  turns: readonly ModelMessage[][],
  prune: ResolvedPrune,
): { turns: ModelMessage[][]; stats: PruneStats } {
  const stats: PruneStats = { outputs: 0, chars: 0 }
  const cut = turns.length - prune.keepTurns
  const out = turns.map((turn, index) => {
    if (index >= cut) return turn
    const pruned = pruneMessages(turn, prune)
    stats.outputs += pruned.stats.outputs
    stats.chars += pruned.stats.chars
    return pruned.messages
  })
  return { turns: out, stats }
}
