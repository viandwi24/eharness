/**
 * Model call observation: an AI SDK language model middleware that records one
 * {@link ModelCallRecord} per provider call (`doStream` / `doGenerate`).
 *
 * @see docs/specs/12-models-and-cost.md#7-model-call-observation
 */
import {
  gateway,
  type LanguageModel,
  type LanguageModelMiddleware,
  type LanguageModelUsage,
  wrapLanguageModel,
} from 'ai'
import { uuidv7 } from '../messages/ids.ts'

/** What made a model call. */
export type ModelCallKind = 'step' | 'compaction' | 'flush' | 'other'

/** One tool call the model asked for in a call. */
export interface ModelCallToolCall {
  toolCallId: string
  toolName: string
  /** The parsed JSON input; the raw string when it is not valid JSON. */
  input: unknown
}

/**
 * One observed model call, without session context: what {@link observeModel} reports. Every value
 * is JSON-serializable (binary data is replaced by a placeholder, headers are redacted).
 *
 * Bodies can be large (the request holds the whole prompt): the application decides what to keep.
 */
export interface ModelCallRecord {
  /** UUIDv7 of the call (sorts by time). */
  id: string
  model: { provider: string; modelId: string }
  /** ISO 8601 timestamp of the call start. */
  startedAt: string
  /** Time from the start to the first stream part with content; unset for `generate` calls. */
  firstChunkMs?: number
  durationMs: number
  /** `aborted`: the call's signal fired or the stream was cancelled before it finished. */
  status: 'ok' | 'error' | 'aborted'
  /** Unified finish reason (`stop`, `length`, `tool-calls`, `content-filter`, `error`, `other`). */
  finishReason?: string
  usage: LanguageModelUsage
  request: {
    /** Provider-agnostic call options: prompt, tools, tool choice, settings, provider options. */
    options: unknown
    /** The body the provider sent over the wire, when the provider reports it. */
    body?: unknown
  }
  response: {
    id?: string
    modelId?: string
    timestamp?: string
    /** Response headers without `set-cookie` and credential-like headers. */
    headers?: Record<string, string>
    /** The raw response body (`generate` calls, when the provider reports it). */
    body?: unknown
  }
  /** The assembled output of the call. */
  output: { text: string; reasoning: string; toolCalls: ModelCallToolCall[] }
  providerMetadata?: Record<string, unknown>
  error?: { name: string; message: string }
}

/**
 * Event of the `model.call` hook: a {@link ModelCallRecord} plus the session context.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface ModelCallEvent extends ModelCallRecord {
  kind: ModelCallKind
  sessionId: string
  turnId?: string
  /** `kind: 'step'`: index of the step in the turn (0-based). */
  stepIndex?: number
  /** `kind: 'step'`: id of the assistant message the step belongs to. */
  messageId?: string
  /** USD cost from the agent's `models` catalog; unset when the model has no pricing. */
  costUsd?: number
}

const EMPTY_USAGE: LanguageModelUsage = {
  inputTokens: undefined,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: undefined,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: undefined,
}

interface V4Usage {
  inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }
  outputTokens?: { total?: number; text?: number; reasoning?: number }
  raw?: unknown
}

/** Provider usage (spec v4) to AI SDK `LanguageModelUsage`. */
function toUsage(usage: V4Usage | undefined): LanguageModelUsage {
  if (usage === undefined) return structuredClone(EMPTY_USAGE)
  const input = usage.inputTokens?.total
  const output = usage.outputTokens?.total
  const out: LanguageModelUsage = {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens?.noCache,
      cacheReadTokens: usage.inputTokens?.cacheRead,
      cacheWriteTokens: usage.inputTokens?.cacheWrite,
    },
    outputTokens: output,
    outputTokenDetails: {
      textTokens: usage.outputTokens?.text,
      reasoningTokens: usage.outputTokens?.reasoning,
    },
    totalTokens:
      input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0),
  }
  if (usage.raw !== undefined) out.raw = jsonSafe(usage.raw) as NonNullable<typeof out.raw>
  return out
}

const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie|credential/i

/** Copy headers without `set-cookie` and credential-like names. */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!SECRET_HEADER.test(name)) out[name] = String(value)
  }
  return out
}

/**
 * A JSON-safe deep copy: binary data becomes a placeholder string, `URL`/`Date` become strings,
 * functions, symbols and `undefined` are dropped, cycles and very deep values are cut.
 */
export function jsonSafe(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
    default:
      break
  }
  const obj = value as object
  if (obj instanceof Uint8Array) return `[binary ${obj.byteLength} bytes]`
  if (obj instanceof ArrayBuffer) return `[binary ${obj.byteLength} bytes]`
  if (obj instanceof URL) return obj.toString()
  if (obj instanceof Date) return obj.toISOString()
  if (obj instanceof Error) return { name: obj.name, message: obj.message }
  if (depth > 40) return '[too deep]'
  if (seen.has(obj)) return '[circular]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => jsonSafe(item, depth + 1, seen) ?? null)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(obj)) {
      const safe = jsonSafe(item, depth + 1, seen)
      if (safe !== undefined) out[key] = safe
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return jsonSafe(input)
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function errorOf(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  if (typeof error === 'string') return { name: 'Error', message: error }
  const safe = jsonSafe(error)
  return { name: 'Error', message: typeof safe === 'object' ? JSON.stringify(safe) : String(safe) }
}

/** Call options without the abort signal, as plain JSON. */
function optionsOf(params: Record<string, unknown>): unknown {
  const { abortSignal: _signal, headers, ...rest } = params
  const out = jsonSafe(rest) as Record<string, unknown>
  const redacted = redactHeaders(headers as Record<string, string> | undefined)
  if (redacted !== undefined && Object.keys(redacted).length > 0) out.headers = redacted
  return out
}

interface Draft {
  model: { provider: string; modelId: string }
  startedAt: number
  params: Record<string, unknown>
  firstChunkAt?: number
  requestBody?: unknown
  response: ModelCallRecord['response']
  text: string
  reasoning: string
  toolCalls: ModelCallToolCall[]
  finishReason?: string
  usage?: V4Usage
  providerMetadata?: unknown
  error?: unknown
  aborted: boolean
}

function finalize(draft: Draft): ModelCallRecord {
  const signal = draft.params.abortSignal as AbortSignal | undefined
  const aborted = draft.aborted || (draft.error !== undefined && signal?.aborted === true)
  const record: ModelCallRecord = {
    id: uuidv7(),
    model: draft.model,
    startedAt: new Date(draft.startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - draft.startedAt),
    status: aborted ? 'aborted' : draft.error === undefined ? 'ok' : 'error',
    usage: toUsage(draft.usage),
    request: { options: optionsOf(draft.params) },
    response: draft.response,
    output: { text: draft.text, reasoning: draft.reasoning, toolCalls: draft.toolCalls },
  }
  if (draft.firstChunkAt !== undefined) {
    record.firstChunkMs = Math.max(0, draft.firstChunkAt - draft.startedAt)
  }
  if (draft.requestBody !== undefined) record.request.body = jsonSafe(draft.requestBody)
  if (draft.finishReason !== undefined) record.finishReason = draft.finishReason
  if (draft.providerMetadata !== undefined) {
    record.providerMetadata = jsonSafe(draft.providerMetadata) as Record<string, unknown>
  }
  if (draft.error !== undefined && !aborted) record.error = errorOf(draft.error)
  return record
}

type Report = (record: ModelCallRecord) => void | Promise<void>

/** Fire the report without letting a failure or a slow listener reach the call. */
function emit(report: Report, draft: Draft): void {
  try {
    const out = report(finalize(draft))
    if (out !== undefined) Promise.resolve(out).catch(() => {})
  } catch {
    // observation never affects the call
  }
}

type StreamPart = { type: string } & Record<string, unknown>

/** Fold one stream part into the draft. */
function absorb(draft: Draft, part: StreamPart): void {
  switch (part.type) {
    case 'text-delta':
      draft.text += String(part.delta ?? '')
      break
    case 'reasoning-delta':
      draft.reasoning += String(part.delta ?? '')
      break
    case 'tool-call':
      draft.toolCalls.push({
        toolCallId: String(part.toolCallId),
        toolName: String(part.toolName),
        input: parseInput(part.input),
      })
      break
    case 'response-metadata':
      if (typeof part.id === 'string') draft.response.id = part.id
      if (typeof part.modelId === 'string') draft.response.modelId = part.modelId
      if (part.timestamp instanceof Date) draft.response.timestamp = part.timestamp.toISOString()
      break
    case 'finish': {
      const reason = part.finishReason as { unified?: string } | undefined
      if (reason?.unified !== undefined) draft.finishReason = reason.unified
      draft.usage = part.usage as V4Usage
      if (part.providerMetadata !== undefined) draft.providerMetadata = part.providerMetadata
      break
    }
    case 'error':
      draft.error ??= part.error
      break
    default:
      break
  }
}

/** The middleware behind {@link observeModel}. */
export function modelCallMiddleware(report: Report): LanguageModelMiddleware {
  const start = (model: { provider: string; modelId: string }, params: unknown): Draft => ({
    model: { provider: model.provider, modelId: model.modelId },
    startedAt: Date.now(),
    params: params as Record<string, unknown>,
    response: {},
    text: '',
    reasoning: '',
    toolCalls: [],
    aborted: false,
  })
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const draft = start(model, params)
      try {
        const result = await doGenerate()
        const r = result as unknown as {
          content: Array<{ type: string } & Record<string, unknown>>
          finishReason?: { unified?: string }
          usage?: V4Usage
          providerMetadata?: unknown
          request?: { body?: unknown }
          response?: {
            id?: string
            modelId?: string
            timestamp?: Date
            headers?: Record<string, string>
            body?: unknown
          }
        }
        for (const part of r.content) {
          if (part.type === 'text') draft.text += String(part.text ?? '')
          else if (part.type === 'reasoning') draft.reasoning += String(part.text ?? '')
          else if (part.type === 'tool-call') absorb(draft, part)
        }
        draft.finishReason = r.finishReason?.unified
        draft.usage = r.usage
        draft.providerMetadata = r.providerMetadata
        draft.requestBody = r.request?.body
        if (r.response?.id !== undefined) draft.response.id = r.response.id
        if (r.response?.modelId !== undefined) draft.response.modelId = r.response.modelId
        if (r.response?.timestamp instanceof Date) {
          draft.response.timestamp = r.response.timestamp.toISOString()
        }
        const headers = redactHeaders(r.response?.headers)
        if (headers !== undefined) draft.response.headers = headers
        if (r.response?.body !== undefined) draft.response.body = jsonSafe(r.response.body)
        emit(report, draft)
        return result
      } catch (error) {
        draft.error = error
        emit(report, draft)
        throw error
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      const draft = start(model, params)
      let result: Awaited<ReturnType<typeof doStream>>
      try {
        result = await doStream()
      } catch (error) {
        draft.error = error
        emit(report, draft)
        throw error
      }
      draft.requestBody = result.request?.body
      const headers = redactHeaders(result.response?.headers as Record<string, string> | undefined)
      if (headers !== undefined) draft.response.headers = headers
      const reader = result.stream.getReader()
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        emit(report, draft)
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              finish()
              controller.close()
              return
            }
            const part = next.value as unknown as StreamPart
            if (draft.firstChunkAt === undefined && part.type !== 'stream-start') {
              draft.firstChunkAt = Date.now()
            }
            absorb(draft, part)
            controller.enqueue(next.value)
          } catch (error) {
            draft.error = error
            finish()
            controller.error(error)
          }
        },
        async cancel(reason) {
          draft.aborted = true
          finish()
          await reader.cancel(reason)
        },
      })
      return { ...result, stream } as typeof result
    },
  }
}

/**
 * Wrap `model` so every provider call is reported as a {@link ModelCallRecord} (an AI SDK
 * language model middleware, `wrapLanguageModel`). The report runs after the call ended (success,
 * error or abort), is never awaited by the call and cannot affect it: errors it throws are
 * swallowed. A plain gateway string is resolved through the default provider; an unresolvable
 * model is returned unchanged.
 *
 * Use it for model calls a plugin makes itself so they show up next to the core's calls (see
 * `ctx.observeModel` for the session-aware variant that fires the `model.call` hook).
 *
 * @example
 * ```ts
 * const judge = observeModel(cheapModel, (record) => log.push(record))
 * await generateText({ model: judge, prompt })
 * ```
 * @see docs/specs/12-models-and-cost.md#7-model-call-observation
 */
export function observeModel(
  model: LanguageModel,
  report: (record: ModelCallRecord) => void | Promise<void>,
): LanguageModel {
  let resolved = model
  if (typeof model === 'string') {
    try {
      const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway
      resolved = provider.languageModel(model) as LanguageModel
    } catch {
      return model
    }
  }
  return wrapLanguageModel({
    model: resolved as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: modelCallMiddleware(report),
  }) as LanguageModel
}
