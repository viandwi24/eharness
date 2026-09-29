/**
 * Prompt layout per step (internal): two stable system blocks, turn/step reminders, Anthropic
 * prompt caching.
 *
 * @see docs/specs/02-context-registry.md#5-prompt-layout-per-step-normative
 * @see docs/specs/02-context-registry.md#6-prompt-caching-normative
 */
import type { LanguageModel, ModelMessage, SystemModelMessage, Tool, ToolSet } from 'ai'
import type { CacheConfig } from '../agent/types.ts'
import type { ProviderOptions } from '../internal/ai-types.ts'

/** Wrap volatile text as a `<system-reminder>` user message (never stored, never in the UI). */
export function reminderMessage(text: string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
  }
}

/** System blocks 1 (static) and 2 (session-refresh); empty blocks are omitted. */
export function systemBlocks(
  block1: string | undefined,
  block2: string | undefined,
): SystemModelMessage[] {
  const out: SystemModelMessage[] = []
  if (block1 !== undefined) out.push({ role: 'system', content: block1 })
  if (block2 !== undefined) out.push({ role: 'system', content: block2 })
  return out
}

/**
 * Insert the turn reminder directly before the current turn's first message (`turnStart`) and
 * append the step reminder at the very end. Returns the messages and the index of the last
 * stable message (the one before the step reminder), or -1.
 */
export function layoutMessages(
  wire: readonly ModelMessage[],
  turnStart: number,
  turnReminder: string | undefined,
  stepReminder: string | undefined,
): { messages: ModelMessage[]; lastStable: number } {
  const messages = [...wire]
  if (turnReminder !== undefined) {
    const at = Math.min(Math.max(turnStart, 0), messages.length)
    messages.splice(at, 0, reminderMessage(turnReminder))
  }
  const lastStable = messages.length - 1
  if (stepReminder !== undefined) messages.push(reminderMessage(stepReminder))
  return { messages, lastStable }
}

/** True for Anthropic models: provider id `anthropic…`, or a gateway id `anthropic/…`. */
export function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === 'string') return model.startsWith('anthropic/')
  return model.provider.startsWith('anthropic')
}

/** Deep-merge plain objects (`b` wins; arrays and other values are replaced). */
export function deepMerge<T extends Record<string, unknown>>(
  a: T | undefined,
  b: T | undefined,
): T | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const previous = out[key]
    out[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous as Record<string, unknown>, value as Record<string, unknown>)
        : value
  }
  return out as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cacheControl(config: CacheConfig): { type: 'ephemeral'; ttl?: '5m' | '1h' } {
  return config.ttl === undefined ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: config.ttl }
}

function withCacheControl<T extends { providerOptions?: ProviderOptions }>(
  value: T,
  control: ReturnType<typeof cacheControl>,
): T {
  return {
    ...value,
    providerOptions: deepMerge(value.providerOptions, { anthropic: { cacheControl: control } }),
  }
}

function contentBlocks(message: ModelMessage): number {
  return typeof message.content === 'string' ? 1 : message.content.length
}

/** Blocks between explicit breakpoints in long tool loops (Anthropic looks back 20 blocks). */
export const BREAKPOINT_BLOCKS = 15

/** Input and output of {@link applyCache}. */
export interface CachedPrompt {
  system: SystemModelMessage[]
  messages: ModelMessage[]
  tools: ToolSet
  providerOptions: ProviderOptions | undefined
}

/**
 * Apply prompt caching for Anthropic models (spec 02 §6.1); a no-op for other providers and for
 * `cache: false`.
 *
 * - `'auto'`: call-level `providerOptions.anthropic.cacheControl`.
 * - `'breakpoints'`: `cacheControl` on system block 1, the last static tool, the last stable
 *   message, and one more message every {@link BREAKPOINT_BLOCKS} content blocks back; at most 4.
 */
export function applyCache(args: {
  config: CacheConfig | false | undefined
  model: LanguageModel
  prompt: CachedPrompt
  lastStable: number
  lastStaticTool: string | undefined
}): CachedPrompt {
  const { config, prompt } = args
  if (config === false || !isAnthropicModel(args.model)) return prompt
  const mode = config?.mode ?? 'auto'
  const control = cacheControl(config ?? {})
  if (mode === 'auto') {
    return {
      ...prompt,
      providerOptions: deepMerge(prompt.providerOptions, {
        anthropic: { cacheControl: control },
      }),
    }
  }
  let budget = 4
  const system = [...prompt.system]
  if (system[0] !== undefined) {
    system[0] = withCacheControl(system[0], control)
    budget--
  }
  let tools = prompt.tools
  const lastTool = args.lastStaticTool
  if (lastTool !== undefined && tools[lastTool] !== undefined) {
    tools = { ...tools, [lastTool]: withCacheControl(tools[lastTool] as Tool, control) }
    budget--
  }
  const messages = [...prompt.messages]
  let index = args.lastStable
  let blocks = 0
  let first = true
  while (index >= 0 && budget > 0) {
    const message = messages[index] as ModelMessage
    if (first || blocks >= BREAKPOINT_BLOCKS) {
      if (message.role !== 'system') {
        messages[index] = withCacheControl(message, control)
        budget--
        blocks = 0
        first = false
      }
    }
    blocks += contentBlocks(message)
    index--
  }
  return { system, messages, tools, providerOptions: prompt.providerOptions }
}
