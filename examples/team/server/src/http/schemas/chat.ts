import { z } from '@hono/zod-openapi'

/** A UI message (AI SDK `UIMessage`): JSON data, the part shapes are the AI SDK's (ADR-0001). */
export const ChatToolsSchema = z
  .object({
    connectors: z.array(
      z.object({
        connectionId: z.string(),
        connectorId: z.string().openapi({ example: 'github' }),
        name: z.string().openapi({ example: 'GitHub' }),
        icon: z.string().optional(),
        label: z.string(),
        accountLabel: z.string().optional(),
        source: z.enum(['builtin', 'curated', 'custom']),
        status: z.enum(['connected', 'needs-auth', 'error']),
        on: z.boolean().openapi({ description: 'Offered to the model in this chat.' }),
        tools: z.number().int().openapi({ description: 'Tools it contributes.' }),
      }),
    ),
    offCount: z.number().int(),
  })
  .openapi('ChatTools')

export const ChatToolsPutSchema = z
  .object({
    off: z.array(z.string()).max(200).openapi({
      description: 'Connection ids switched off in this chat (replaces the previous list).',
    }),
  })
  .openapi('ChatToolsPut')

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
    duplicate: z.literal(true).optional().openapi({
      description: 'The same `Idempotency-Key` was delivered before: nothing was added.',
    }),
  })
  .openapi('ChatQueued', {
    description:
      'A turn of this chat runs on another instance: the message was stored in the durable inbox and is steered into it. Follow the turn with `GET /sessions/{id}/chat/stream`.',
  })

/** The documented body of an SSE response: the chunks are the AI SDK UI message stream protocol. */
export const EventStreamSchema = z.string().openapi({
  description: 'Server-sent events: AI SDK UI message stream chunks, ending with `data: [DONE]`.',
  example: 'data: {"type":"start","messageId":"…"}\n\ndata: [DONE]\n\n',
})

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
    model: z
      .object({
        id: z.string(),
        profileId: z
          .string()
          .optional()
          .openapi({ description: 'The provider profile the model is reached through.' }),
        contextWindow: z.number().optional(),
        maxOutputTokens: z.number().optional(),
        pricing: z
          .object({
            input: z.number(),
            output: z.number(),
            cacheRead: z.number().optional(),
            cacheWrite: z.number().optional(),
          })
          .optional()
          .openapi({ description: 'USD per 1M tokens, from the model catalog.' }),
      })
      .openapi({ description: 'The model of the agent; no pricing = unknown to the catalog.' }),
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
