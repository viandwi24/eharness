/**
 * Typed custom data parts (`data-<name>`) and the core `eh.*` parts.
 *
 * @see docs/specs/03-messages.md#4-data-parts
 */
import type { FilePart, FlexibleSchema, InferSchema, TextPart, UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import type {
  ContextStats,
  InputPartData,
  OutputPartData,
  ProjectionContext,
  StatusPartData,
  UsagePartData,
  WarningPartData,
} from './types.ts'

/**
 * Definition of a data part.
 *
 * @see docs/specs/03-messages.md#41-definition
 */
export interface DataPartDef<S extends FlexibleSchema = FlexibleSchema> {
  /** Schema of `data` (zod, Standard Schema, or `jsonSchema()`). Used for types and load validation. */
  schema: S
  /** Transient parts are streamed but never persisted or projected. Default false. */
  transient?: boolean
  /**
   * How a persisted part appears to the model. Default `'omit'`.
   * - `'text'` → `JSON.stringify(data)` wrapped as `<data type="…">…</data>`.
   * - function → return a `TextPart`/`FilePart`, or `undefined` to omit.
   */
  model?:
    | 'omit'
    | 'text'
    | ((data: InferSchema<S>, ctx: ProjectionContext) => TextPart | FilePart | undefined)
  /** Upgrade old stored data before validation (schema evolution). */
  upgrade?: (data: unknown) => unknown
}

/**
 * Define a data part. Declare it under `dataParts` of the agent (app namespace, `data-<key>`) or
 * of a plugin (`data-<plugin>.<key>`).
 *
 * @example
 * ```ts
 * const invoice = defineDataPart({
 *   schema: z.object({ id: z.string(), total: z.number() }),
 *   model: 'text',
 * })
 * defineHarnessAgent({ model, dataParts: { invoice } }) // part type 'data-invoice'
 * ```
 * @see docs/specs/03-messages.md#41-definition
 */
export function defineDataPart<const S extends FlexibleSchema>(
  def: DataPartDef<S>,
): DataPartDef<S> {
  return def
}

/**
 * A data-part chunk as written to the UI message stream: AI SDK's data chunk (`data-<name>`,
 * `id?`, `data`, `transient?`), which `ai` does not export by name.
 */
export type DataChunk = Extract<UIMessageChunk, { type: `data-${string}` }>

/** Local names of app data parts/kinds and plugin keys: `^[a-z][a-zA-Z0-9-]*$`, not `eh…`. */
export const LOCAL_NAME_PATTERN: RegExp = /^[a-z][a-zA-Z0-9-]*$/

/** Returns an error text when `name` is not a valid app/plugin data part or kind name. */
export function invalidLocalName(name: string): string | undefined {
  if (!LOCAL_NAME_PATTERN.test(name)) return `must match ${String(LOCAL_NAME_PATTERN)}`
  if (name.startsWith('eh')) return "must not start with 'eh' (reserved for core parts)"
  return undefined
}

const fileUIPartSchema = z.looseObject({
  type: z.literal('file'),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
})

const statusSchema = z.looseObject({
  state: z.enum(['thinking', 'tool', 'compacting', 'idle']),
  step: z.number().optional(),
  tool: z.string().optional(),
})

const usageSchema = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  steps: z.number(),
})

const contextSchema = z.looseObject({
  window: z.number(),
  tokens: z.number(),
  instructions: z.number(),
  tools: z.number(),
  messages: z.number(),
  summarizeAt: z.number(),
  hardLimit: z.number(),
  lastCompaction: z
    .looseObject({ markerId: z.string(), before: z.number(), after: z.number(), at: z.number() })
    .optional(),
  pruned: z.looseObject({ outputs: z.number(), chars: z.number() }).optional(),
})

const warningSchema = z.looseObject({ code: z.string(), message: z.string() })

const inputSchema = z.looseObject({
  source: z.union([
    z.literal('user'),
    z.literal('event'),
    z.templateLiteral(['plugin:', z.string()]),
  ]),
  text: z.string(),
  files: z.array(fileUIPartSchema).optional(),
  clientId: z.string().optional(),
})

const outputSchema = z.looseObject({
  value: z.unknown(),
  mode: z.enum(['tool', 'native']),
  attempts: z.number(),
})

/**
 * Core data parts (`data-eh.*`) that are not message kinds.
 *
 * @see docs/specs/03-messages.md#43-core-data-parts
 */
export const coreDataParts: {
  readonly 'eh.status': DataPartDef<FlexibleSchema<StatusPartData>>
  readonly 'eh.usage': DataPartDef<FlexibleSchema<UsagePartData>>
  readonly 'eh.context': DataPartDef<FlexibleSchema<ContextStats>>
  readonly 'eh.warning': DataPartDef<FlexibleSchema<WarningPartData>>
  readonly 'eh.input': DataPartDef<FlexibleSchema<InputPartData>>
  readonly 'eh.output': DataPartDef<FlexibleSchema<OutputPartData>>
} = {
  'eh.status': { schema: statusSchema as FlexibleSchema<StatusPartData>, transient: true },
  'eh.usage': { schema: usageSchema as FlexibleSchema<UsagePartData>, transient: true },
  'eh.context': { schema: contextSchema as FlexibleSchema<ContextStats>, transient: true },
  'eh.warning': { schema: warningSchema as FlexibleSchema<WarningPartData>, transient: true },
  // projected by splitting the assistant message (spec 03 §6 step 4), not via `model`
  'eh.input': { schema: inputSchema as unknown as FlexibleSchema<InputPartData> },
  // the validated final answer of a turn with SendOptions.output (spec 05 §3.3); never projected
  'eh.output': { schema: outputSchema as unknown as FlexibleSchema<OutputPartData>, model: 'omit' },
}
