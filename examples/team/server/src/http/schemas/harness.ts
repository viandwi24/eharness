/**
 * Documentation-only schemas of the routes `eharness/http` serves (spec 26): they are not used to
 * validate anything (the library does), they exist so the OpenAPI document, and the types the web
 * generates from it, describe those routes.
 */
import { z } from '@hono/zod-openapi'
import { UiMessageSchema } from './chat.ts'

const Busy = z
  .object({
    scope: z.enum(['local', 'remote']),
    turnId: z.string(),
    owner: z.string().optional(),
    heartbeatAt: z.number().optional(),
  })
  .openapi('SessionBusy')

const ActiveTurn = z
  .object({
    turnId: z.string(),
    kind: z.string(),
    messageId: z.string(),
    userMessageId: z.string().optional(),
    owner: z.string(),
    startedAt: z.number(),
    heartbeatAt: z.number(),
  })
  .openapi('ActiveTurn')

export const SessionSnapshotSchema = z
  .object({
    id: z.string(),
    running: z.boolean().openapi({ description: 'A turn runs, on any instance.' }),
    busy: Busy.nullable(),
    activeTurn: ActiveTurn.nullable(),
    pending: z
      .object({
        messageId: z.string(),
        approvals: z.array(
          z.object({
            approvalId: z.string(),
            toolCallId: z.string(),
            toolName: z.string(),
            input: z.unknown().optional(),
            answered: z.boolean(),
          }),
        ),
        clientTools: z.array(
          z.object({
            toolCallId: z.string(),
            toolName: z.string(),
            input: z.unknown().optional(),
            timeoutAt: z.number().optional(),
            answered: z.boolean(),
          }),
        ),
        externals: z.array(
          z.object({
            waitId: z.string(),
            toolCallId: z.string(),
            toolName: z.string(),
            timeoutAt: z.number().optional(),
            resolved: z.boolean(),
          }),
        ),
      })
      .nullable(),
    usage: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      turns: z.number(),
      costUsd: z.number().optional(),
    }),
  })
  .openapi('SessionSnapshot', { description: 'The stored state of a session (`eharness/http`).' })

export const SessionMessagesPageSchema = z
  .object({
    messages: z.array(UiMessageSchema).openapi({ description: 'Oldest first.' }),
    nextBefore: z
      .string()
      .optional()
      .openapi({ description: 'Pass as `before` to read older messages; absent = the start.' }),
  })
  .openapi('SessionMessagesPage')

export const InterruptRequestSchema = z
  .object({ reason: z.string().max(200).optional() })
  .openapi('InterruptRequest')

export const InterruptResultSchema = z
  .object({
    target: z.enum(['local', 'remote', 'idle', 'unsupported']).openapi({
      description:
        '`local`: a turn of this instance was aborted; `remote`: the request was written for the instance running it; `idle`: nothing runs.',
    }),
  })
  .openapi('InterruptResult')

export const AttentionItemSchema = z
  .object({
    id: z.string().openapi({
      description:
        '`approvalId`, `toolCallId` (client tool, e.g. a question) or `waitId`: the `{id}` of `POST /attention/{id}/answer`.',
    }),
    kind: z.enum(['approval', 'client-tool', 'wait']),
    sessionId: z.string(),
    parentSessionId: z.string().nullable(),
    rootSessionId: z.string(),
    agent: z
      .string()
      .optional()
      .openapi({ description: 'Slug of the agent that runs the session.' }),
    name: z.string().optional(),
    description: z.string().optional(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    risk: z.enum(['read', 'write', 'external', 'unknown']).nullable(),
    messageId: z.string(),
    createdAt: z.number().nullable(),
    answeredWaiting: z.number().int(),
  })
  .openapi('AttentionItem')

export const AttentionListSchema = z
  .object({ items: z.array(AttentionItemSchema) })
  .openapi('AttentionList', {
    description:
      'The library queue, without the app fields of `GET /approvals` (agent name, task, question texts).',
  })

export const AttentionAnswerSchema = z
  .object({
    sessionId: z.string().openapi({ description: 'The `sessionId` of the item.' }),
    answer: z
      .union([
        z.object({
          kind: z.literal('approval'),
          approved: z.boolean(),
          reason: z
            .string()
            .max(2000)
            .optional()
            .openapi({ description: 'Shown to the model when denied.' }),
          note: z.string().max(4000).optional().openapi({
            description:
              'A free-text note about this call: the model reads it right after the result (approved) or as part of the reason (denied).',
          }),
          remember: z.literal('session').optional().openapi({
            description:
              'With `approved: true`: also allow this tool without asking for the rest of the session (and answer the other waiting calls of the same tool in this session at once). With `approved: false`: never allow it in this session.',
          }),
          scope: z.enum(['session', 'agent', 'all']).optional().openapi({
            description:
              'With `approved: true`: how far "always allow" reaches. `session` (default with `remember`): this session. `agent`: a saved rule of this agent, all its sessions. `all`: a saved rule of every agent. Tools a connector pins to ask (writes of third-party connectors) still ask.',
          }),
        }),
        z.object({
          kind: z.literal('question'),
          answers: z
            .array(
              z.object({
                selected: z.array(z.string()).optional(),
                other: z.string().optional(),
                notes: z.string().optional(),
              }),
            )
            .nullable()
            .openapi({
              description: 'One answer per question, in order; null dismisses the questions.',
            }),
        }),
      ])
      .openapi({ description: 'An approval decision, or the answer of an `ask_user_question`.' }),
  })
  .openapi('AttentionAnswer')

export const AttentionAnsweredSchema = z
  .object({
    status: z.enum(['resumed', 'recorded', 'already-answered']).openapi({
      description:
        '`recorded`: stored, others of the batch still wait (`remaining`). `resumed`: it was the last one and the session continues server side. `already-answered`: answered elsewhere first (refresh quietly).',
    }),
    id: z.string(),
    sessionId: z.string(),
    kind: z.enum(['approval', 'client-tool', 'wait']).optional(),
    remaining: z.number().int().optional(),
  })
  .openapi('AttentionAnswered')
