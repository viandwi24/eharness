/**
 * The `handoff()` plugin (spec 32): `ask_person`, an `externalTool()` that hands a question or
 * decision to a person and parks the turn until someone answers from anywhere.
 *
 * Built only with the public core API (ADR-0008).
 *
 * @see docs/specs/32-handoff.md
 */

import { z } from 'zod/v4'
import {
  definePlugin,
  errorText,
  externalTool,
  type HarnessContext,
  type HarnessPlugin,
  type ResolveWaitResult,
} from '../index.ts'
import type {
  HandoffAnswer,
  HandoffKind,
  HandoffRequest,
  HandoffStore,
  HandoffTransition,
} from './types.ts'

/** Default tool name. */
export const HANDOFF_TOOL = 'ask_person'

/** Result the model reads when a request expired without an answer. */
export const HANDOFF_EXPIRED_TEXT: string =
  'The request expired and nobody answered. Proceed with your best judgment, or tell the user that you could not get an answer.'

/** Result the model reads when a request was cancelled. */
export const HANDOFF_CANCELLED_TEXT: string =
  'The request was cancelled and will not be answered. Proceed with your best judgment.'

/** Model-facing description (internal wording: may change in any release). */
export const HANDOFF_DESCRIPTION: string =
  'Hand a question or a decision to a person and wait for the answer. Use it when you need a ' +
  'human to approve something, choose between options, supply information you cannot get ' +
  'yourself, or take over the conversation. The answer comes back as the tool result. Give a ' +
  'short `title`, put everything the person needs to decide in `body`, and list `options` when ' +
  'the answer is a choice.'

/** Options of {@link handoff}. */
export interface HandoffOptions {
  store: HandoffStore
  /**
   * Called once when a request is created (not again for a retried start): post a card to a chat
   * or the web. A throwing `notify` is logged; the request stays open and the turn stays parked.
   */
  notify?: (request: HandoffRequest, ctx: HarnessContext) => void | Promise<void>
  /** Default `'ask_person'`. */
  toolName?: string
  /** Requests expire this long after creation (and the wait times out then). Default: never. */
  defaultExpiryMs?: number
  /** Replaces the model-facing tool description. */
  describe?: string
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
}

const inputSchema = z.object({
  kind: z
    .enum(['decision', 'question', 'takeover'])
    .optional()
    .describe(
      'decision: approve or choose; question: free text; takeover: a human should continue',
    ),
  title: z.string().min(1).describe('A short title'),
  body: z.string().describe('What the person needs to know to answer'),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
    .min(1)
    .max(8)
    .optional()
    .describe('The choices, when the answer is a choice'),
  audience: z
    .array(z.string())
    .optional()
    .describe('Roles or people who should answer; leave out for anyone'),
  urgency: z.enum(['low', 'normal', 'high']).optional(),
})

/** The `ask_person` plugin. @see docs/specs/32-handoff.md */
export function handoff(options: HandoffOptions): HarnessPlugin<'handoff'> {
  const toolName = options.toolName ?? HANDOFF_TOOL
  const now = options.now ?? Date.now
  return definePlugin({
    name: 'handoff',
    session(ctx) {
      const sessionId = ctx.session.id
      return {
        tools: {
          [toolName]: externalTool({
            description: options.describe ?? HANDOFF_DESCRIPTION,
            inputSchema,
            outputSchema: z.string(),
            metadata: { risk: 'write', idempotent: true },
            start: async (input, { waitId, toolCallId, ctx: callCtx }) => {
              const createdAt = now()
              const expiresAt =
                options.defaultExpiryMs === undefined
                  ? undefined
                  : createdAt + options.defaultExpiryMs
              const { request, created } = await options.store.create({
                id: `${sessionId}:${waitId}`,
                sessionId,
                toolCallId,
                waitId,
                kind: (input.kind ?? 'decision') as HandoffKind,
                title: input.title,
                body: input.body,
                ...(input.options === undefined ? {} : { options: input.options }),
                ...(input.audience === undefined ? {} : { audience: input.audience }),
                ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
                ...(expiresAt === undefined ? {} : { expiresAt }),
                createdAt,
              })
              if (created && options.notify !== undefined) {
                try {
                  await options.notify(request, callCtx)
                } catch (error) {
                  callCtx.log.warn(`handoff: notify failed for ${request.id}: ${errorText(error)}`)
                }
              }
              return {
                correlationId: request.id,
                payload: { handoffId: request.id },
                ...(request.expiresAt === undefined
                  ? {}
                  : { timeoutAt: request.expiresAt, onTimeout: { output: HANDOFF_EXPIRED_TEXT } }),
              }
            },
          }),
        },
      }
    },
  })
}

/** The part of an agent (or any session source) the resolvers need. */
export interface HandoffSessions {
  session(id: string): {
    resolveWait(
      waitId: string,
      result: { output: unknown } | { errorText: string },
    ): Promise<ResolveWaitResult>
  }
}

/** The answer given to {@link resolveHandoff}. */
export interface HandoffAnswerInput {
  optionId?: string
  text?: string
  by: string
  /** Default `Date.now()`. */
  at?: number
}

/** Outcome of the resolvers. */
export type HandoffResolution =
  | {
      status: 'resolved'
      request: HandoffRequest
      /** What `session.resolveWait` returned (`continued` carries the run). */
      wait: ResolveWaitResult
    }
  | {
      /** Answered before: the stored answer was delivered again (idempotent crash recovery). */
      status: 'already-answered'
      request: HandoffRequest
      wait?: ResolveWaitResult
    }
  | { status: 'closed'; request?: HandoffRequest; reason: 'expired' | 'cancelled' }
  | { status: 'not-found' }
  | { status: 'invalid'; error: string }

/** The text the model reads for an answer. */
export function formatHandoffAnswer(request: HandoffRequest, answer: HandoffAnswer): string {
  const label =
    answer.optionId === undefined
      ? undefined
      : (request.options?.find((o) => o.id === answer.optionId)?.label ?? answer.optionId)
  const text = answer.text?.trim()
  const head =
    request.kind === 'takeover'
      ? `${answer.by} took over`
      : label === undefined
        ? `${answer.by} answered`
        : `${answer.by} chose ${label}`
  return text ? `${head}: ${text}` : head
}

async function deliver(
  sessions: HandoffSessions,
  request: HandoffRequest,
  result: { output: unknown } | { errorText: string },
): Promise<ResolveWaitResult> {
  return sessions.session(request.sessionId).resolveWait(request.waitId, result)
}

/**
 * Answer a request from anywhere: compare-and-set the store, then resolve the session's wait with
 * a text the model reads. The same assistant message continues (`wait.status === 'continued'`).
 * An unknown option id is `invalid` and changes nothing. A second answer gets `already-answered`
 * and the first answer is delivered again, which is a no-op unless the first delivery failed.
 *
 * @see docs/specs/32-handoff.md#4-resolving
 */
export async function resolveHandoff(args: {
  store: HandoffStore
  sessions: HandoffSessions
  id: string
  answer: HandoffAnswerInput
}): Promise<HandoffResolution> {
  const { store, sessions, id } = args
  const current = await store.get(id)
  if (current === undefined) return { status: 'not-found' }
  const { optionId, text } = args.answer
  if (current.status === 'open') {
    if (current.options !== undefined && optionId !== undefined) {
      if (!current.options.some((o) => o.id === optionId)) {
        return {
          status: 'invalid',
          error: `Unknown option "${optionId}". Options: ${current.options.map((o) => o.id).join(', ')}`,
        }
      }
    }
    if (optionId === undefined && (text === undefined || text.trim() === '')) {
      return { status: 'invalid', error: 'An answer needs an option or text.' }
    }
  }
  const answer: HandoffAnswer = {
    ...(optionId === undefined ? {} : { optionId }),
    ...(text === undefined ? {} : { text }),
    by: args.answer.by,
    at: args.answer.at ?? Date.now(),
  }
  const done: HandoffTransition = await store.answer(id, answer)
  if (done.ok) {
    const wait = await deliver(sessions, done.request, {
      output: formatHandoffAnswer(done.request, answer),
    })
    return { status: 'resolved', request: done.request, wait }
  }
  if (done.reason === 'not-found') return { status: 'not-found' }
  if (done.reason === 'expired' || done.reason === 'cancelled') {
    return {
      status: 'closed',
      reason: done.reason,
      ...(done.request === undefined ? {} : { request: done.request }),
    }
  }
  const request = done.request as HandoffRequest
  const first = request.answer
  const wait =
    first === undefined
      ? undefined
      : await deliver(sessions, request, { output: formatHandoffAnswer(request, first) })
  return { status: 'already-answered', request, ...(wait === undefined ? {} : { wait }) }
}

/**
 * Cancel an open request and resolve its wait with a cancelled result (never leave a tool call
 * without a result, ADR-0014).
 */
export async function cancelHandoff(args: {
  store: HandoffStore
  sessions: HandoffSessions
  id: string
}): Promise<HandoffResolution> {
  const done = await args.store.cancel(args.id)
  if (done.ok) {
    const wait = await deliver(args.sessions, done.request, { output: HANDOFF_CANCELLED_TEXT })
    return { status: 'resolved', request: done.request, wait }
  }
  if (done.reason === 'not-found') return { status: 'not-found' }
  if (done.reason === 'expired' || done.reason === 'cancelled') {
    return {
      status: 'closed',
      reason: done.reason,
      ...(done.request === undefined ? {} : { request: done.request }),
    }
  }
  return { status: 'already-answered', request: done.request as HandoffRequest }
}

/**
 * Expire every open request that is due and resolve each wait with an "expired, no answer"
 * result. Run it from a sweeper (a schedule). The wait's own timeout (set at start from
 * `defaultExpiryMs`) does the same for the wait; this also closes the stored request.
 */
export async function expireHandoffs(args: {
  store: HandoffStore
  sessions: HandoffSessions
  /** Default `Date.now()`. */
  now?: number
}): Promise<Array<{ request: HandoffRequest; wait?: ResolveWaitResult; error?: string }>> {
  const expired = await args.store.expire(args.now ?? Date.now())
  const out: Array<{ request: HandoffRequest; wait?: ResolveWaitResult; error?: string }> = []
  for (const request of expired) {
    try {
      out.push({
        request,
        wait: await deliver(args.sessions, request, { output: HANDOFF_EXPIRED_TEXT }),
      })
    } catch (error) {
      out.push({ request, error: errorText(error) })
    }
  }
  return out
}
