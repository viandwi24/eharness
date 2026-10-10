import { z } from '@hono/zod-openapi'

/** A UI message (AI SDK `UIMessage`): JSON data, the part shapes are the AI SDK's (ADR-0001). */
export const UiMessageSchema = z
  .looseObject({
    id: z.string().optional(),
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(z.looseObject({ type: z.string() })),
    metadata: z.unknown().optional(),
  })
  .openapi('UiMessage', {
    description:
      'An AI SDK `UIMessage`. Stored messages carry `metadata.eharness` (turn id, stop reason, usage, pending approvals).',
  })

export const ChatRequestSchema = z
  .object({
    id: z
      .string()
      .optional()
      .openapi({ description: 'Chat id of `useChat`; ignored (the chat is the agent DM).' }),
    messages: z.array(UiMessageSchema).max(1000).openapi({
      description:
        'Only the **last** message is read: a user message (send), or the assistant message with `approval-responded` / `output-available` tool parts (answers a pending approval; the continuation streams into the same message). Ids, metadata and history of the client are never trusted.',
    }),
    trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
    messageId: z
      .string()
      .optional()
      .openapi({ description: 'With a user message: replace that message and answer it (edit).' }),
  })
  .openapi('ChatRequest', {
    description: 'The `useChat` request body (`DefaultChatTransport`).',
  })

export const ChatQueuedSchema = z
  .object({
    inboxId: z.string(),
    delivered: z.literal('steer'),
    target: z.enum(['local', 'remote']),
  })
  .openapi('ChatQueued', {
    description:
      'A turn of this chat runs on another instance: the message was stored in the durable inbox and is steered into it. Follow the turn with `GET /agents/{id}/chat/stream`.',
  })

/** The documented body of an SSE response: the chunks are the AI SDK UI message stream protocol. */
export const EventStreamSchema = z.string().openapi({
  description: 'Server-sent events: AI SDK UI message stream chunks, ending with `data: [DONE]`.',
  example: 'data: {"type":"start","messageId":"…"}\n\ndata: [DONE]\n\n',
})

export const MessagesPageSchema = z
  .object({
    messages: z.array(UiMessageSchema).openapi({ description: 'Chronological (oldest first).' }),
    nextBefore: z
      .string()
      .nullable()
      .openapi({ description: 'Pass as `before` to load older messages; null = no more.' }),
  })
  .openapi('MessagesPage')

export const AbortResultSchema = z
  .object({
    target: z.enum(['local', 'remote', 'idle', 'unsupported']).openapi({
      description:
        '`local`: a turn of this instance was aborted; `remote`: the request was written for the instance running it; `idle`: nothing runs.',
    }),
  })
  .openapi('AbortResult')

export const AbortRequestSchema = z
  .object({ reason: z.string().max(500).optional() })
  .openapi('AbortRequest')

export const CompactResultSchema = z
  .object({
    compacted: z.boolean(),
    message: UiMessageSchema.nullable().openapi({
      description: 'The summary (kind) message; null when there was nothing to compact.',
    }),
  })
  .openapi('CompactResult')

export const ChatStatsSchema = z
  .object({
    running: z.boolean().openapi({ description: 'A turn runs in this process.' }),
    context: z.object({
      window: z.number(),
      tokens: z.number(),
      instructions: z.number(),
      tools: z.number(),
      messages: z.number(),
      summarizeAt: z.number(),
      hardLimit: z.number(),
      lastCompaction: z
        .object({ markerId: z.string(), before: z.number(), after: z.number(), at: z.number() })
        .optional(),
    }),
    activeTurn: z
      .object({
        turnId: z.string(),
        kind: z.string(),
        messageId: z.string(),
        owner: z.string(),
        startedAt: z.number(),
        heartbeatAt: z.number(),
      })
      .nullable()
      .openapi({ description: 'The turn running anywhere (any instance), or null.' }),
    pending: z
      .object({
        messageId: z.string(),
        approvals: z.array(
          z.object({
            approvalId: z.string(),
            toolCallId: z.string(),
            toolName: z.string(),
            input: z.unknown().optional(),
            risk: z.string().optional(),
          }),
        ),
        clientTools: z.number().int(),
        externals: z.number().int(),
      })
      .nullable()
      .openapi({ description: 'Approvals and questions waiting for the user.' }),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
      costUsd: z.number(),
      turns: z.number().int().openapi({ description: 'Turns that ran at least one model step.' }),
    }),
  })
  .openapi('ChatStats')

export const UploadFormSchema = z.object({
  file: z
    .instanceof(File)
    .openapi({ type: 'string', format: 'binary', description: 'The file (max 10 MB).' }),
})

export const UploadResultSchema = z
  .object({
    path: z.string().openapi({ example: '/uploads/2026-10-10/0198f0a2-report.pdf' }),
    name: z.string(),
    mediaType: z.string(),
    size: z.number().int(),
    version: z.string(),
    url: z.string().openapi({
      example: 'library:///uploads/2026-10-10/0198f0a2-report.pdf',
      description:
        'Use as the `url` of a `file` part of the next user message; the server resolves it to the file content.',
    }),
  })
  .openapi('Upload')
