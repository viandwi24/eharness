/**
 * Message kinds: messages the model did not generate (compaction markers, notices, events,
 * rewinds), stored as ordinary `UIMessage`s with one `data-<kind>` part.
 *
 * @see docs/specs/03-messages.md#5-message-kinds-custom-messages
 */
import type { FilePart, FlexibleSchema, InferSchema, TextPart } from 'ai'
import { z } from 'zod/v4'
import { escapeAttribute, neutralizeTags } from './framing.ts'
import { uuidv7 } from './ids.ts'
import type {
  CompactionPayload,
  EventPayload,
  FlushPayload,
  HarnessUIMessage,
  NoticePayload,
  ProjectionContext,
  RewindPayload,
} from './types.ts'

/**
 * Definition of a message kind.
 *
 * @see docs/specs/03-messages.md#51-definition
 */
export interface MessageKindDef<S extends FlexibleSchema = FlexibleSchema> {
  /** Role used when stored and projected. */
  role: 'user' | 'assistant'
  /** Schema of the payload (`data` of the single part). */
  schema: S
  /**
   * Projection to the model. Default `'omit'`.
   * A function returns text/parts for a single model message with `role`, or `null` to omit.
   */
  model?:
    | 'omit'
    | ((data: InferSchema<S>, ctx: ProjectionContext) => string | Array<TextPart | FilePart> | null)
  /** A boundary starts the model context (only the newest boundary counts). Default false. */
  boundary?: boolean
  /** Upgrade old stored data before validation (schema evolution). */
  upgrade?: (data: unknown) => unknown
}

/**
 * Define a message kind. Declare it under `messageKinds` of the agent (app namespace) or of a
 * plugin (`<plugin>.<key>`). A kind is also registered as a persistent data part of the same name.
 *
 * @example
 * ```ts
 * const reminder = defineMessageKind({
 *   role: 'user',
 *   schema: z.object({ text: z.string() }),
 *   model: (d) => `<reminder>${d.text}</reminder>`,
 * })
 * defineHarnessAgent({ model, messageKinds: { reminder } })
 * ```
 * @see docs/specs/03-messages.md#51-definition
 */
export function defineMessageKind<const S extends FlexibleSchema>(
  def: MessageKindDef<S>,
): MessageKindDef<S> {
  return def
}

const compactionSchema = z.looseObject({
  summary: z.string(),
  resumeFromId: z.string().nullable(),
  partial: z.looseObject({ messageId: z.string(), fromStep: z.number().int().min(0) }).optional(),
  tokens: z.looseObject({ before: z.number(), after: z.number() }),
  trigger: z.enum(['auto', 'manual', 'turn']),
  model: z.string().optional(),
})

const noticeSchema = z.looseObject({
  level: z.enum(['info', 'warning', 'error']),
  code: z.string().optional(),
  message: z.string(),
})

const eventSchema = z.looseObject({
  name: z.string(),
  text: z.string(),
  data: z.unknown().optional(),
})

const rewindSchema = z.looseObject({
  afterId: z.string().nullable(),
  reason: z.enum(['regenerate', 'edit', 'revert']),
})

const flushSchema = z.looseObject({
  trigger: z.enum(['auto', 'manual', 'turn', 'overflow']),
  prompt: z.string(),
  model: z.string().optional(),
  steps: z.number().int().min(0),
  toolCalls: z.array(
    z.looseObject({ toolName: z.string(), status: z.enum(['output', 'error', 'denied']) }),
  ),
  usage: z.looseObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
  }),
  costUsd: z.number().optional(),
  error: z.string().optional(),
})

/**
 * Frame tags neutralised inside kind payload text (spec 03 §5.3). `agent-message` is not in the
 * list: `eharness/subagent` frames agent messages itself inside event text and neutralises that
 * tag in the bodies it carries (agent messages, subagent reports).
 */
const FRAME_TAGS = ['event', 'system-reminder', 'untrusted-content'] as const

/**
 * Core message kinds (`eh.*`).
 *
 * @see docs/specs/03-messages.md#53-core-kinds
 */
export const coreMessageKinds: {
  readonly 'eh.compaction': MessageKindDef<FlexibleSchema<CompactionPayload>>
  readonly 'eh.notice': MessageKindDef<FlexibleSchema<NoticePayload>>
  readonly 'eh.event': MessageKindDef<FlexibleSchema<EventPayload>>
  readonly 'eh.rewind': MessageKindDef<FlexibleSchema<RewindPayload>>
  readonly 'eh.flush': MessageKindDef<FlexibleSchema<FlushPayload>>
} = {
  'eh.compaction': {
    role: 'user',
    schema: compactionSchema as FlexibleSchema<CompactionPayload>,
    boundary: true,
    model: (data) =>
      `<conversation-summary>${neutralizeTags(data.summary, [...FRAME_TAGS, 'conversation-summary'])}</conversation-summary>`,
  },
  'eh.notice': { role: 'assistant', schema: noticeSchema as FlexibleSchema<NoticePayload> },
  'eh.event': {
    role: 'user',
    schema: eventSchema as FlexibleSchema<EventPayload>,
    model: (data) =>
      `<event name="${escapeAttribute(data.name)}">${neutralizeTags(data.text, FRAME_TAGS)}</event>`,
  },
  'eh.rewind': { role: 'user', schema: rewindSchema as FlexibleSchema<RewindPayload> },
  // audit record of a pre-compaction flush: never projected (spec 06 §5.2a)
  'eh.flush': { role: 'assistant', schema: flushSchema as FlexibleSchema<FlushPayload> },
}

/** Options of {@link createKindMessage}. */
export interface CreateKindMessageOptions {
  /**
   * Stored role. Must equal the kind definition's `role`. Default: the role of the core kind
   * (`eh.*`), otherwise `'user'`.
   */
  role?: 'user' | 'assistant'
  /** Message id. Default: a new UUIDv7. */
  id?: string
  /** Epoch ms. Default: `Date.now()`. */
  createdAt?: number
  turnId?: string
  parentId?: string | null
  deliveredIn?: string
  /** Id of the single data part (optional). */
  partId?: string
}

/**
 * Build a kind message in the normative stored shape (does not validate `data`; `session.inject`
 * does).
 *
 * @example
 * ```ts
 * const event = createKindMessage('eh.event', { name: 'deploy', text: 'Deploy finished' })
 * ```
 * @see docs/specs/03-messages.md#52-stored-shape-normative
 */
export function createKindMessage(
  kind: string,
  data: unknown,
  options: CreateKindMessageOptions = {},
): HarnessUIMessage {
  const role =
    options.role ??
    (Object.hasOwn(coreMessageKinds, kind)
      ? coreMessageKinds[kind as keyof typeof coreMessageKinds].role
      : 'user')
  const eharness: NonNullable<NonNullable<HarnessUIMessage['metadata']>['eharness']> = {
    v: 1,
    createdAt: options.createdAt ?? Date.now(),
    kind,
  }
  if (options.turnId !== undefined) eharness.turnId = options.turnId
  if (options.parentId !== undefined) eharness.parentId = options.parentId
  if (options.deliveredIn !== undefined) eharness.deliveredIn = options.deliveredIn
  const part = { type: `data-${kind}`, data } as HarnessUIMessage['parts'][number]
  if (options.partId !== undefined) (part as { id?: string }).id = options.partId
  return { id: options.id ?? uuidv7(), role, metadata: { eharness }, parts: [part] }
}

/**
 * Check whether a message is a kind message (optionally of `kind`): `metadata.eharness.kind` is
 * set and the message has exactly one part, of type `data-<kind>`.
 *
 * @see docs/specs/03-messages.md#52-stored-shape-normative
 */
export function isKindMessage(
  message: { metadata?: unknown; parts: readonly { type: string }[] },
  kind?: string,
): boolean {
  const actual = kindOf(message)
  if (actual === undefined) return false
  if (kind !== undefined && actual !== kind) return false
  return message.parts.length === 1 && message.parts[0]?.type === `data-${actual}`
}

/** `metadata.eharness.kind` of a message, if set. */
export function kindOf(message: { metadata?: unknown }): string | undefined {
  const metadata = message.metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const eharness = (metadata as { eharness?: unknown }).eharness
  if (typeof eharness !== 'object' || eharness === null) return undefined
  const kind = (eharness as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : undefined
}
