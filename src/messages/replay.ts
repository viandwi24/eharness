/**
 * `messageToChunks`: the UI message chunks that rebuild a stored message in AI SDK's stream
 * processor (the replay prefix of a resumed continuation).
 *
 * @see docs/specs/04-streaming.md#63-resume-replay-of-a-continuation
 */
import type { UIMessage, UIMessageChunk } from 'ai'

type Json = Record<string, unknown>

const has = (value: unknown): boolean => value !== undefined && value !== null

/**
 * The chunks that rebuild `message` when applied to an empty message state: `start` (same
 * `messageId` and `messageMetadata`), then one group of chunks per part, in order: `step-start` as
 * `start-step` / `finish-step`, `text` / `reasoning` as `*-start` · `*-delta` · `*-end` (with
 * their `providerMetadata`), `file` / `reasoning-file`, `source-url` / `source-document`,
 * `custom`, persistent `data-*` parts (with `id`), and tool parts as `tool-input-start` /
 * `tool-input-available`, `tool-approval-request` / `tool-approval-response`, then
 * `tool-output-available` / `tool-output-error` / `tool-output-denied` according to their state.
 * No `finish` is emitted. Transient data parts are never stored, so they are never replayed.
 *
 * Used for the resume replay of a `respond()` continuation (ADR-0045); exported for adapters and
 * tests that need the same projection.
 */
export function messageToChunks(message: UIMessage): UIMessageChunk[] {
  const out: UIMessageChunk[] = [
    {
      type: 'start',
      messageId: message.id,
      ...(message.metadata === undefined
        ? {}
        : { messageMetadata: structuredClone(message.metadata) }),
    } as UIMessageChunk,
  ]
  let stepOpen = false
  let n = 0
  const push = (chunk: Json): void => {
    out.push(structuredClone(chunk) as unknown as UIMessageChunk)
  }
  const closeStep = (): void => {
    if (stepOpen) push({ type: 'finish-step' })
    stepOpen = false
  }
  for (const raw of message.parts) {
    const part = raw as Json & { type: string }
    const type = part.type
    const meta = has(part.providerMetadata) ? { providerMetadata: part.providerMetadata } : {}
    if (type === 'step-start') {
      closeStep()
      push({ type: 'start-step' })
      stepOpen = true
    } else if (type === 'text' || type === 'reasoning') {
      const id = typeof part.id === 'string' ? part.id : `replay-${n++}`
      push({ type: `${type}-start`, id, ...meta })
      if (typeof part.text === 'string' && part.text !== '') {
        push({ type: `${type}-delta`, id, delta: part.text })
      }
      push({ type: `${type}-end`, id, ...meta })
    } else if (type === 'file' || type === 'reasoning-file') {
      push({ type, url: part.url, mediaType: part.mediaType, ...meta })
    } else if (type === 'source-url') {
      push({
        type,
        sourceId: part.sourceId,
        url: part.url,
        ...(has(part.title) ? { title: part.title } : {}),
        ...meta,
      })
    } else if (type === 'source-document') {
      push({
        type,
        sourceId: part.sourceId,
        mediaType: part.mediaType,
        title: part.title,
        ...(has(part.filename) ? { filename: part.filename } : {}),
        ...meta,
      })
    } else if (type === 'custom') {
      push({ type, kind: part.kind, ...meta })
    } else if (type.startsWith('data-')) {
      if (part.data !== undefined) {
        push({ type, ...(part.id === undefined ? {} : { id: part.id }), data: part.data })
      }
    } else if (type === 'dynamic-tool' || type.startsWith('tool-')) {
      toolChunks(part, push)
    }
  }
  closeStep()
  return out
}

function toolChunks(part: Json & { type: string }, push: (chunk: Json) => void): void {
  const dynamic = part.type === 'dynamic-tool'
  const toolCallId = String(part.toolCallId)
  const toolName = dynamic ? String(part.toolName) : part.type.slice('tool-'.length)
  const state = String(part.state)
  const common = {
    toolCallId,
    ...(dynamic ? { dynamic: true } : {}),
    ...(part.providerExecuted === true ? { providerExecuted: true } : {}),
    ...(has(part.toolMetadata) ? { toolMetadata: part.toolMetadata } : {}),
  }
  if (state === 'input-streaming') {
    push({
      type: 'tool-input-start',
      toolName,
      ...common,
      ...(has(part.title) ? { title: part.title } : {}),
    })
    return
  }
  push({
    type: 'tool-input-available',
    toolName,
    input: part.input,
    ...common,
    ...(has(part.title) ? { title: part.title } : {}),
    ...(has(part.callProviderMetadata) ? { providerMetadata: part.callProviderMetadata } : {}),
  })
  const approval = part.approval as
    | {
        id: string
        approved?: boolean
        reason?: string
        descriptor?: unknown
        inputSchemaInput?: unknown
        requestReason?: string
        isAutomatic?: boolean
        signature?: string
      }
    | undefined
  if (approval !== undefined) {
    push({
      type: 'tool-approval-request',
      approvalId: approval.id,
      toolCallId,
      ...(has(approval.descriptor) ? { approvalDescriptor: approval.descriptor } : {}),
      ...(Object.hasOwn(approval, 'inputSchemaInput')
        ? { inputSchemaInput: approval.inputSchemaInput }
        : {}),
      ...(has(approval.requestReason) ? { reason: approval.requestReason } : {}),
      ...(approval.isAutomatic === true ? { isAutomatic: true } : {}),
      ...(has(approval.signature) ? { signature: approval.signature } : {}),
    })
    if (typeof approval.approved === 'boolean') {
      push({
        type: 'tool-approval-response',
        approvalId: approval.id,
        approved: approval.approved,
        ...(has(approval.reason) ? { reason: approval.reason } : {}),
      })
    }
  }
  const resultMeta = has(part.resultProviderMetadata)
    ? { providerMetadata: part.resultProviderMetadata }
    : {}
  if (state === 'output-available') {
    push({ type: 'tool-output-available', output: part.output, ...common, ...resultMeta })
  } else if (state === 'output-error') {
    push({
      type: 'tool-output-error',
      errorText: String(part.errorText),
      ...common,
      ...resultMeta,
    })
  } else if (state === 'output-denied') {
    push({ type: 'tool-output-denied', toolCallId })
  }
}
