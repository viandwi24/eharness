/**
 * Tool output limits (internal): every final output of a wrapped tool is limited before it
 * reaches the model, the stream and storage. Strategies `truncate` (head + tail around
 * `TOOL_OUTPUT_TRUNCATED`) and `evict` (full text into the `toolOutputs` service, preview to the
 * model; falls back to `truncate` without the service).
 *
 * @see docs/specs/09-tools-and-mcp.md#4-tool-output-limits
 */
import type { ToolOutputConfig } from '../agent/types.ts'
import { truncateMiddle } from '../compaction/truncate.ts'
import type { HarnessWarning } from '../errors.ts'

/** Default `toolOutput.maxChars`. */
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 50_000

/** Minimal shape of the `toolOutputs` service (declared by the filesystem plugin, spec 08 §2). */
export interface ToolOutputSink {
  put(toolCallId: string, text: string): Promise<string>
}

/** A structured output that was over budget (spec 09 §4). */
export interface LimitedOutput {
  truncated: true
  /** Truncated JSON serialization of the original output. */
  preview: string
  /** JSON-serialized length of the original output. */
  originalChars: number
  /** `evict` only: where the full output was saved and how to read it. */
  note?: string
}

/** Dependencies of {@link limitToolOutput}. */
export interface OutputLimitDeps {
  config: ToolOutputConfig | undefined
  /** The session's `toolOutputs` service, when a plugin provides it. */
  toolOutputs: ToolOutputSink | undefined
  warn(warning: HarnessWarning, key?: string): void
}

/** Budget of one tool (`undefined` = unlimited). */
export function toolOutputBudget(
  config: ToolOutputConfig | undefined,
  toolName: string,
): number | undefined {
  const perTool = config?.perTool
  if (perTool !== undefined && Object.hasOwn(perTool, toolName)) {
    const value = perTool[toolName]
    if (value === false) return undefined
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  }
  const max = config?.maxChars
  if (typeof max === 'number' && Number.isFinite(max)) return Math.max(0, max)
  return DEFAULT_TOOL_OUTPUT_MAX_CHARS
}

/** True for the `{ truncated: true, preview, originalChars }` form produced by the limits. */
export function isLimitedOutput(value: unknown): value is LimitedOutput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<LimitedOutput>
  return (
    v.truncated === true && typeof v.preview === 'string' && typeof v.originalChars === 'number'
  )
}

function serialize(output: unknown): string {
  try {
    return JSON.stringify(output) ?? ''
  } catch {
    return String(output)
  }
}

/** Characters JSON escaping adds to `text` (quotes excluded). */
function escapeCost(text: string): number {
  return JSON.stringify(text).length - 2 - text.length
}

/**
 * Head + tail preview of a serialized output whose kept characters **plus** the JSON escaping
 * they need (the preview is a string inside the structured output) fit `budget` (the marker is
 * not counted, like in `truncateMiddle`). Binary search on the kept length.
 */
function escapedPreview(text: string, budget: number): string {
  let preview = truncateMiddle(text, budget)
  const marker = (p: string, kept: number) => p.length - kept
  if (escapeCost(preview) === 0) return preview
  let low = 0
  let high = budget
  preview = truncateMiddle(text, 0)
  while (low <= high) {
    const kept = Math.floor((low + high) / 2)
    const candidate = truncateMiddle(text, kept)
    const cost = JSON.stringify(candidate).length - 2 - marker(candidate, kept)
    if (cost <= budget) {
      preview = candidate
      low = kept + 1
    } else {
      high = kept - 1
    }
  }
  return preview
}

function evictNote(path: string): string {
  return `Full output saved to ${path}; use read_file with offset/limit to see more.`
}

/**
 * Apply the output limit of `toolName` to a final output. Returns the output unchanged when it
 * is within budget. Strings are measured by length, other values by their JSON serialization.
 */
export async function limitToolOutput(
  toolName: string,
  toolCallId: string,
  output: unknown,
  deps: OutputLimitDeps,
): Promise<unknown> {
  const budget = toolOutputBudget(deps.config, toolName)
  if (budget === undefined) return output
  const isText = typeof output === 'string'
  const text = isText ? output : serialize(output)
  if (text.length <= budget) return output

  let strategy: 'truncate' | 'evict' = 'truncate'
  let note: string | undefined
  if (deps.config?.strategy === 'evict' && deps.toolOutputs !== undefined) {
    try {
      const full = isText ? text : (JSON.stringify(output, null, 2) ?? text)
      note = evictNote(await deps.toolOutputs.put(toolCallId, full))
      strategy = 'evict'
    } catch {
      // the service failed: fall back to truncate (spec 09 §4)
    }
  }
  deps.warn(
    {
      code: 'W_TOOL_OUTPUT_LIMITED',
      message: `Output of tool '${toolName}' had ${text.length} characters (limit ${budget}) and was ${strategy === 'evict' ? 'evicted' : 'truncated'}.`,
      details: {
        tool: toolName,
        toolCallId,
        originalChars: text.length,
        maxChars: budget,
        strategy,
      },
    },
    toolCallId,
  )
  if (isText) {
    const preview = truncateMiddle(text, budget)
    return note === undefined ? preview : `${preview}\n\n${note}`
  }
  const preview = escapedPreview(text, budget)
  const limited: LimitedOutput = { truncated: true, preview, originalChars: text.length }
  if (note !== undefined) limited.note = note
  return limited
}
