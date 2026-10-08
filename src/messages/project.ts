/**
 * Projection of stored `UIMessage`s to the `ModelMessage`s the model sees (internal).
 *
 * @see docs/specs/03-messages.md#6-projection-to-the-model
 */
import {
  convertToModelMessages,
  type FilePart,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolSet,
  type UIMessage,
} from 'ai'
import { providerOf } from '../internal/model.ts'
import { kindOf } from './kinds.ts'
import type { MessageRegistry } from './registry.ts'
import { sanitizeModelMessages } from './sanitize.ts'
import { INTERRUPTED_UNKNOWN } from './texts.ts'
import { answerDanglingToolParts, isToolPart } from './tool-parts.ts'
import type {
  CompactionPayload,
  HarnessUIMessage,
  InputPartData,
  PendingState,
  ProjectionContext,
} from './types.ts'

type AnyUIMessage = UIMessage<unknown>
type AnyPart = AnyUIMessage['parts'][number]

/** Options of {@link project}. */
export interface ProjectOptions {
  /** Data part and kind registry of the agent. */
  registry: MessageRegistry
  /** Session id, passed to data part and kind projections. */
  sessionId: string
  /** Turn tool set, for tool output conversion (`toModelOutput`). */
  tools?: ToolSet
  /** Model of the step; assistant messages of another provider lose reasoning and provider metadata. */
  model?: LanguageModel
  /** Pending approvals: their `approval-requested` parts are left untouched. */
  pending?: PendingState | null
  /** Id of the message a `respond()` continues: its `approval-responded` parts are kept. */
  continuing?: string
}

/**
 * Project an assembled view (`[boundary?] + visible messages`, id order) to model messages.
 *
 * Steps, in order (spec 03 §6): `partial` trimming · kinds · interrupted tool calls · split at
 * `data-eh.input` · foreign reasoning · `convertToModelMessages` · sanitize.
 *
 * Deterministic: no I/O besides AI SDK's async conversion. The input is not mutated.
 */
export async function project(
  view: readonly HarnessUIMessage[],
  options: ProjectOptions,
): Promise<ModelMessage[]> {
  const { registry } = options
  const boundary = newestBoundary(view as readonly AnyUIMessage[], registry)
  const messages = trimPartial(view as readonly AnyUIMessage[], boundary)
  const targetProvider = providerOf(options.model)
  const pendingApprovals = new Set(
    options.pending?.approvals.map((a) => a.toolCallId) ?? ([] as string[]),
  )
  const pendingMessageId = options.pending?.messageId

  const wire: ModelMessage[] = []
  for (const original of messages) {
    const ctx: ProjectionContext = {
      message: original as HarnessUIMessage,
      sessionId: options.sessionId,
    }

    // 2. kinds
    const kind = kindOf(original)
    if (kind !== undefined) {
      // only the newest boundary counts (older markers are normally removed by the loader)
      if (registry.kind(kind)?.def.boundary === true && original !== boundary) continue
      const projected = projectKind(original, kind, ctx, registry)
      if (projected !== undefined) wire.push(projected)
      continue
    }
    if (original.role === 'system') continue // never inside `messages` (spec 02 §5)

    // 3. interrupted tool calls
    let message = answerDanglingToolParts(original, INTERRUPTED_UNKNOWN, (part) => {
      if (part.state === 'approval-requested') {
        return original.id === pendingMessageId && pendingApprovals.has(part.toolCallId)
      }
      return part.state === 'approval-responded' && original.id === options.continuing
    })

    // 5. foreign reasoning (independent of the split, applied to the whole message)
    if (message.role === 'assistant' && targetProvider !== undefined) {
      const stored = storedModel(message)
      const storedProvider = providerOf(stored)
      if (storedProvider !== undefined && storedProvider !== targetProvider) {
        message = stripProviderSpecific(message)
      }
    }

    // 4. split at data-eh.input
    for (const piece of splitAtInput(message)) {
      // 6. convert
      const converted = await convertToModelMessages([stripReasoningTiming(piece)], {
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        ignoreIncompleteToolCalls: true,
        convertDataPart: (part) =>
          convertDataPart(part as { type: string; data: unknown }, ctx, registry),
      })
      wire.push(...converted)
    }
  }

  // 7. sanitize
  return sanitizeModelMessages(wire)
}

/** The boundary kind message with the highest id, if any. */
function newestBoundary(
  view: readonly AnyUIMessage[],
  registry: MessageRegistry,
): AnyUIMessage | undefined {
  let newest: AnyUIMessage | undefined
  for (const message of view) {
    const kind = kindOf(message)
    if (kind === undefined || registry.kind(kind)?.def.boundary !== true) continue
    if (newest === undefined || message.id > newest.id) newest = message
  }
  return newest
}

/** 1. `partial`: drop the steps of `partial.messageId` before `partial.fromStep`. */
function trimPartial(
  view: readonly AnyUIMessage[],
  boundary: AnyUIMessage | undefined,
): readonly AnyUIMessage[] {
  const data = (boundary?.parts[0] as { data?: unknown } | undefined)?.data
  const candidate = (data as { partial?: unknown } | undefined)?.partial
  const partial =
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { messageId?: unknown }).messageId === 'string' &&
    typeof (candidate as { fromStep?: unknown }).fromStep === 'number'
      ? (candidate as NonNullable<CompactionPayload['partial']>)
      : undefined
  if (partial === undefined) return view
  const { messageId, fromStep } = partial
  return view.map((message) => {
    if (message.id !== messageId) return message
    let seen = -1
    let start = message.parts.length
    for (const [index, part] of message.parts.entries()) {
      if (part.type !== 'step-start') continue
      seen++
      if (seen === fromStep) {
        start = index
        break
      }
    }
    return { ...message, parts: message.parts.slice(start) }
  })
}

function projectKind(
  message: AnyUIMessage,
  kind: string,
  ctx: ProjectionContext,
  registry: MessageRegistry,
): ModelMessage | undefined {
  const eharness = (message.metadata as { eharness?: { deliveredIn?: unknown } } | undefined)
    ?.eharness
  if (typeof eharness?.deliveredIn === 'string') return undefined // delivered inline already
  const registered = registry.kind(kind)
  const model = registered?.def.model
  if (registered === undefined || model === undefined || model === 'omit') return undefined
  const part = message.parts[0] as { type: string; data?: unknown } | undefined
  if (part?.type !== `data-${kind}`) return undefined
  const result = model(part.data, ctx)
  if (result === null) return undefined
  if (typeof result === 'string' && result.length === 0) return undefined
  if (typeof result !== 'string' && result.length === 0) return undefined
  // Plugin / app kinds are tagged so the restricted transcript (spec 11 §3.4) can tell them from a
  // person's text. Core `eh.*` kinds stay untagged: their wire is frozen (goldens) and the core's
  // own text prefixes already identify them.
  const tag = kind.startsWith('eh.') ? {} : { providerOptions: { eharness: { core: true } } }
  return registered.def.role === 'user'
    ? { role: 'user', content: result, ...tag }
    : { role: 'assistant', content: result, ...tag }
}

function convertDataPart(
  part: { type: string; data: unknown },
  ctx: ProjectionContext,
  registry: MessageRegistry,
): TextPart | FilePart | undefined {
  const registered = registry.dataPart(part.type)
  if (registered === undefined || registered.def.transient === true) return undefined
  const model = registered.def.model
  if (model === undefined || model === 'omit') return undefined
  if (model === 'text') {
    return {
      type: 'text',
      text: `<data type="${registered.name}">${JSON.stringify(part.data)}</data>`,
    }
  }
  return model(part.data, ctx)
}

function storedModel(message: AnyUIMessage): string | undefined {
  const model = (message.metadata as { eharness?: { model?: unknown } } | undefined)?.eharness
    ?.model
  return typeof model === 'string' ? model : undefined
}

/** Drop reasoning parts and provider metadata (signatures and item ids are provider-specific). */
function stripProviderSpecific(message: AnyUIMessage): AnyUIMessage {
  const parts: AnyPart[] = []
  for (const part of message.parts) {
    if (part.type === 'reasoning' || part.type === 'reasoning-file') continue
    if (isToolPart(part)) {
      const { callProviderMetadata: _c, resultProviderMetadata: _r, ...rest } = part
      parts.push(rest as unknown as AnyPart)
      continue
    }
    if ('providerMetadata' in part) {
      const { providerMetadata: _p, ...rest } = part
      parts.push(rest as AnyPart)
      continue
    }
    parts.push(part)
  }
  return { ...message, parts }
}

/**
 * Drop `providerMetadata.eharness` (the reasoning duration, spec 04 §2) from reasoning parts: it
 * is UI-only and must not reach the provider wire.
 */
function stripReasoningTiming(message: AnyUIMessage): AnyUIMessage {
  if (message.role !== 'assistant') return message
  let changed = false
  const parts = message.parts.map((part): AnyPart => {
    if (part.type !== 'reasoning') return part
    const metadata = (part as { providerMetadata?: Record<string, unknown> }).providerMetadata
    if (metadata === undefined || !('eharness' in metadata)) return part
    changed = true
    const { eharness: _e, ...rest } = metadata
    const { providerMetadata: _p, ...without } = part as { providerMetadata?: unknown }
    return (
      Object.keys(rest).length === 0 ? without : { ...without, providerMetadata: rest }
    ) as AnyPart
  })
  return changed ? { ...message, parts } : message
}

/** 4. Split an assistant message at every `data-eh.input` part. */
function splitAtInput(message: AnyUIMessage): AnyUIMessage[] {
  if (message.role !== 'assistant') return [message]
  if (!message.parts.some((part) => part.type === 'data-eh.input')) return [message]
  const pieces: AnyUIMessage[] = []
  let current: AnyPart[] = []
  for (const part of message.parts) {
    if (part.type !== 'data-eh.input') {
      current.push(part)
      continue
    }
    if (current.length > 0) pieces.push({ ...message, parts: current })
    current = []
    const data = (part as { data: InputPartData }).data
    const userParts: AnyPart[] = [{ type: 'text', text: data.text }]
    for (const file of data.files ?? []) userParts.push(file)
    pieces.push({ id: message.id, role: 'user', parts: userParts })
  }
  if (current.length > 0) pieces.push({ ...message, parts: current })
  return pieces
}
