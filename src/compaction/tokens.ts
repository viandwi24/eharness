/**
 * Token accounting (internal): the default counter, estimates of model messages, UI messages and
 * tool definitions, the per-message cache (`metadata.eharness.tokens`), calibration from provider
 * usage and the window / limit resolution.
 *
 * @see docs/specs/06-compaction.md#2-token-accounting
 */
import { asSchema, type LanguageModel, type ModelMessage, type Tool, type ToolResultPart } from 'ai'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
import { project } from '../messages/project.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { ContextStats, HarnessUIMessage } from '../messages/types.ts'
import { lookupModel } from '../models/catalog.ts'

/** A token counter: text → tokens. */
export type CountTokens = (text: string) => number

/** Default context window when none is configured (spec 06 §1). */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default `compaction.summarizeAt`. */
export const DEFAULT_SUMMARIZE_AT = 0.75

/** Default `guard.maxContextRatio`. */
export const DEFAULT_MAX_CONTEXT_RATIO = 0.9

/** Share of the window used as `reserveTokens` when neither it nor `maxOutputTokens` is set. */
const DEFAULT_RESERVE_SHARE = 0.08

/** Fixed estimate of one file / image part (real costs depend on the provider). */
export const FILE_TOKENS = 1_500

/** Fixed per-message overhead (role, separators). */
const MESSAGE_OVERHEAD = 4

/** Calibration bounds and smoothing (spec 06 §2). */
const MIN_FACTOR = 0.5
const MAX_FACTOR = 2
const SMOOTHING = 0.3

/** Default token counter: `ceil(chars / 4)`. */
export function defaultCountTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function json(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

type LoosePart = { type?: unknown; [key: string]: unknown }

/** Tool result output variants (AI SDK): a new variant is a compile error below. */
type ToolOutput = ToolResultPart['output']

function outputTokens(output: unknown, count: CountTokens): number {
  if (typeof output !== 'object' || output === null) return count(json(output))
  // stored data: typed as AI SDK's union, but every access stays defensive
  const o = output as ToolOutput
  switch (o.type) {
    case 'text':
    case 'error-text':
      return count(typeof o.value === 'string' ? o.value : json(o.value))
    case 'json':
    case 'error-json':
      return count(json(o.value))
    case 'execution-denied':
      return count(typeof o.reason === 'string' ? o.reason : '') + 2
    case 'content': {
      let n = 0
      for (const item of Array.isArray(o.value) ? o.value : []) {
        n += item.type === 'text' ? count(String(item.text ?? '')) : FILE_TOKENS
      }
      return n
    }
    default:
      o satisfies never
      return count(json(output))
  }
}

function partTokens(part: LoosePart, count: CountTokens): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return count(typeof part.text === 'string' ? part.text : '')
    case 'file':
    case 'image':
    case 'reasoning-file':
      return FILE_TOKENS
    case 'tool-call':
      return count(String(part.toolName ?? '')) + count(json(part.input))
    case 'tool-result':
      return count(String(part.toolName ?? '')) + outputTokens(part.output, count)
    case 'tool-approval-request':
    case 'tool-approval-response':
      return 8
    default:
      return count(json(part))
  }
}

/** Uncalibrated estimate of one model message. */
export function modelMessageTokens(message: ModelMessage, count: CountTokens): number {
  if (typeof message.content === 'string') return MESSAGE_OVERHEAD + count(message.content)
  let n = MESSAGE_OVERHEAD
  for (const part of message.content as LoosePart[]) n += partTokens(part, count)
  return n
}

/** Uncalibrated estimate of a list of model messages. */
export function wireTokens(messages: readonly ModelMessage[], count: CountTokens): number {
  let n = 0
  for (const message of messages) n += modelMessageTokens(message, count)
  return n
}

/**
 * Uncalibrated estimate of one stored message: its cached `metadata.eharness.tokens`, or the
 * estimate of its projection (spec 06 §2).
 */
export async function messageTokens(
  message: HarnessUIMessage,
  registry: MessageRegistry,
  count: CountTokens,
): Promise<number> {
  const cached = message.metadata?.eharness?.tokens
  if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) return cached
  return projectedTokens(message, registry, count)
}

/** Estimate of a message's projection (ignores the cached value). */
export async function projectedTokens(
  message: HarnessUIMessage,
  registry: MessageRegistry,
  count: CountTokens,
): Promise<number> {
  try {
    return wireTokens(await project([message], { registry, sessionId: '' }), count)
  } catch {
    return count(json(message.parts))
  }
}

/**
 * Return a copy of `message` with `metadata.eharness.tokens` set to the estimate of its
 * projection. Messages without `metadata.eharness` are returned unchanged.
 */
export async function withTokens(
  message: HarnessUIMessage,
  registry: MessageRegistry,
  count: CountTokens,
): Promise<HarnessUIMessage> {
  const eharness = message.metadata?.eharness
  if (eharness === undefined) return message
  const tokens = await projectedTokens(message, registry, count)
  return { ...message, metadata: { ...message.metadata, eharness: { ...eharness, tokens } } }
}

/** Per counter (agents may configure different `countTokens`), per tool object. */
const toolCache = new WeakMap<CountTokens, WeakMap<Tool, number>>()

/** Uncalibrated estimate of one tool definition (name, description, input schema). Cached. */
export async function toolTokens(name: string, tool: Tool, count: CountTokens): Promise<number> {
  let cache = toolCache.get(count)
  if (cache === undefined) {
    cache = new WeakMap()
    toolCache.set(count, cache)
  }
  const cached = cache.get(tool)
  if (cached !== undefined) return cached + count(name)
  let schema = ''
  try {
    const input = (tool as { inputSchema?: unknown }).inputSchema
    if (input !== undefined) {
      schema = json(await asSchema(input as Parameters<typeof asSchema>[0]).jsonSchema)
    }
  } catch {
    schema = ''
  }
  const description = typeof tool.description === 'string' ? tool.description : ''
  const n = 10 + count(description) + count(schema)
  cache.set(tool, n)
  return n + count(name)
}

/** Uncalibrated estimate of a tool set. */
export async function toolSetTokens(
  tools: Readonly<Record<string, Tool>>,
  count: CountTokens,
): Promise<number> {
  let n = 0
  for (const [name, tool] of Object.entries(tools)) n += await toolTokens(name, tool, count)
  return n
}

/**
 * Calibration factor `k` (spec 06 §2): `clamp(actual / estimate, 0.5, 2)` smoothed with an
 * exponential moving average; every estimate is multiplied by `k`. In memory, per session.
 */
export interface Calibration {
  /** Current factor. */
  readonly factor: number
  /** Multiply an uncalibrated estimate by `k` (rounded up). */
  apply(tokens: number): number
  /** Record provider-reported input tokens for a request whose uncalibrated estimate is known. */
  observe(estimate: number, actual: number | undefined): void
  /**
   * The provider rejected a request as too long (spec 06 §7): `k = actual / estimate` when the
   * provider reported the count (unclamped for the rest of the session), otherwise `k × 1.25`.
   */
  overflow(estimate: number, actual: number | undefined): void
}

/** Create a calibration (k = 1). */
export function createCalibration(): Calibration {
  let factor = 1
  let unclamped = false
  const clamp = (value: number) =>
    unclamped ? value : Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value))
  return {
    get factor() {
      return factor
    },
    apply: (tokens) => Math.ceil(tokens * factor),
    observe(estimate, actual) {
      if (actual === undefined || !(actual > 0) || !(estimate > 0)) return
      const ratio = clamp(actual / estimate)
      factor = clamp(factor * (1 - SMOOTHING) + ratio * SMOOTHING)
    },
    overflow(estimate, actual) {
      if (actual !== undefined && actual > 0 && estimate > 0) {
        unclamped = true
        factor = actual / estimate
      } else {
        factor = factor * 1.25
      }
    },
  }
}

/**
 * Resolve the context window of a model: `config.contextWindow` (number or function), else the
 * `config.models` entry, else {@link DEFAULT_CONTEXT_WINDOW} with a `W_DEFAULT_CONTEXT_WINDOW`
 * warning (via `warn`).
 */
export function resolveWindow(
  config: Pick<HarnessAgentConfig, 'contextWindow' | 'models'>,
  model: LanguageModel,
  warn?: (warning: HarnessWarning, key?: string) => void,
): number {
  const configured = config.contextWindow
  let window: number | undefined
  if (typeof configured === 'number') window = configured
  else if (typeof configured === 'function') {
    try {
      window = configured(model)
    } catch {
      window = undefined
    }
  }
  if (window !== undefined && window > 0 && Number.isFinite(window)) return window
  const known = lookupModel(config.models, model)?.contextWindow
  if (known !== undefined && known > 0 && Number.isFinite(known)) return known
  warn?.(
    {
      code: 'W_DEFAULT_CONTEXT_WINDOW',
      message: `No contextWindow configured for model '${describeModel(model)}'; using ${DEFAULT_CONTEXT_WINDOW}.`,
      details: { model: describeModel(model) },
    },
    `window:${describeModel(model)}`,
  )
  return DEFAULT_CONTEXT_WINDOW
}

/** Absolute limits of one window (spec 06 §1, §6). */
export interface ContextLimits {
  window: number
  /** Absolute tokens. */
  summarizeAt: number
  /** Absolute tokens: `window × maxContextRatio − reserveTokens`. */
  hardLimit: number
}

/** Compute the limits of a window; `ratioFactor` tightens `maxContextRatio` (overflow, §7). */
export function contextLimits(
  config: Pick<HarnessAgentConfig, 'compaction' | 'guard' | 'settings'>,
  window: number,
  options: { maxOutputTokens?: number; ratioFactor?: number } = {},
): ContextLimits {
  const summarizeAt =
    config.compaction === false || config.compaction === undefined
      ? DEFAULT_SUMMARIZE_AT
      : (config.compaction.summarizeAt ?? DEFAULT_SUMMARIZE_AT)
  const ratio =
    (config.guard?.maxContextRatio ?? DEFAULT_MAX_CONTEXT_RATIO) * (options.ratioFactor ?? 1)
  const reserve =
    config.guard?.reserveTokens ??
    options.maxOutputTokens ??
    config.settings?.maxOutputTokens ??
    Math.floor(window * DEFAULT_RESERVE_SHARE)
  return {
    window,
    summarizeAt: Math.floor(window * summarizeAt),
    hardLimit: Math.floor(window * ratio - reserve),
  }
}

/** Build `ContextStats` from uncalibrated parts. */
export function buildStats(
  calibration: Calibration,
  limits: ContextLimits,
  raw: { instructions: number; tools: number; messages: number },
  lastCompaction?: ContextStats['lastCompaction'],
  pruned?: ContextStats['pruned'],
  split?: Pick<ContextStats, 'instructionBlocks' | 'toolSources'>,
): ContextStats {
  const instructions = calibration.apply(raw.instructions)
  const tools = calibration.apply(raw.tools)
  const messages = calibration.apply(raw.messages)
  const stats: ContextStats = {
    window: limits.window,
    tokens: instructions + tools + messages,
    instructions,
    tools,
    messages,
    summarizeAt: limits.summarizeAt,
    hardLimit: limits.hardLimit,
  }
  if (lastCompaction !== undefined) stats.lastCompaction = lastCompaction
  if (pruned !== undefined) stats.pruned = pruned
  if (split?.instructionBlocks !== undefined) stats.instructionBlocks = split.instructionBlocks
  if (split?.toolSources !== undefined) stats.toolSources = split.toolSources
  return stats
}
