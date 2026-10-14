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
  type ApprovalActor,
  definePlugin,
  errorText,
  externalTool,
  type HarnessContext,
  type HarnessPlugin,
  type PendingExternal,
  type ResolveWaitResult,
  type SendOptions,
  type WaitStart,
} from '../index.ts'
import type {
  HandoffAnswer,
  HandoffInput,
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

/** Arguments of {@link startHandoff}. */
export interface StartHandoffArgs {
  store: HandoffStore
  /** Called once, only when the request was newly created (a retried start does not notify). */
  notify?: (request: HandoffRequest, ctx: HarnessContext) => void | Promise<void>
  /** The request expires (and the wait times out) this long after creation. Default: never. */
  defaultExpiryMs?: number
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
  sessionId: string
  /** From the `start` event of `externalTool()`. */
  waitId: string
  toolCallId: string
  ctx: HarnessContext
  /** The request itself. `id` defaults to `<sessionId>:<waitId>`; `expiresAt` overrides the default expiry. */
  request: Omit<HandoffInput, 'id' | 'sessionId' | 'toolCallId' | 'waitId' | 'createdAt'> & {
    id?: string
  }
}

/**
 * What the plugin's external tool does in `start`: idempotent create in the store, notify once,
 * and return the wait descriptor (`correlationId`, `payload.handoffId`, and `timeoutAt` with an
 * `onTimeout` output when the request expires). Call it from your own `externalTool()` to park
 * through handoff with your own input schema, category or attribution.
 *
 * @see docs/specs/32-handoff.md#3-the-plugin
 */
export async function startHandoff(args: StartHandoffArgs): Promise<WaitStart> {
  const createdAt = (args.now ?? Date.now)()
  const { id, ...rest } = args.request
  const expiresAt =
    rest.expiresAt ??
    (args.defaultExpiryMs === undefined ? undefined : createdAt + args.defaultExpiryMs)
  const { request, created } = await args.store.create({
    ...rest,
    id: id ?? `${args.sessionId}:${args.waitId}`,
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    waitId: args.waitId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    createdAt,
  })
  if (created && args.notify !== undefined) {
    try {
      await args.notify(request, args.ctx)
    } catch (error) {
      args.ctx.log.warn(`handoff: notify failed for ${request.id}: ${errorText(error)}`)
    }
  }
  return {
    correlationId: request.id,
    payload: { handoffId: request.id },
    ...(request.expiresAt === undefined
      ? {}
      : { timeoutAt: request.expiresAt, onTimeout: { output: HANDOFF_EXPIRED_TEXT } }),
  }
}

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
            start: (input, { waitId, toolCallId, ctx: callCtx }) =>
              startHandoff({
                store: options.store,
                ...(options.notify === undefined ? {} : { notify: options.notify }),
                ...(options.defaultExpiryMs === undefined
                  ? {}
                  : { defaultExpiryMs: options.defaultExpiryMs }),
                now,
                sessionId,
                waitId,
                toolCallId,
                ctx: callCtx,
                request: {
                  kind: (input.kind ?? 'decision') as HandoffKind,
                  title: input.title,
                  body: input.body,
                  ...(input.options === undefined ? {} : { options: input.options }),
                  ...(input.audience === undefined ? {} : { audience: input.audience }),
                  ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
                },
              }),
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
      options?: HandoffResumeOptions,
    ): Promise<ResolveWaitResult>
  }
}

/** What `session.resolveWait` accepts as its third argument (`send` options and `actor`). */
export type HandoffResumeOptions = SendOptions & { actor?: ApprovalActor }

/** {@link HandoffSessions} whose sessions also list their pending waits (for {@link redeliverHandoff}). */
export interface HandoffRedeliverSessions {
  session(id: string): {
    resolveWait(
      waitId: string,
      result: { output: unknown } | { errorText: string },
      options?: HandoffResumeOptions,
    ): Promise<ResolveWaitResult>
    pendingWaits(): Promise<PendingExternal[]>
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
      /**
       * Answered before (by this call's loser race or earlier). Nothing was delivered: use
       * {@link redeliverHandoff} for crash recovery. `wait` is set only by that function.
       */
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
  resume?: HandoffResumeOptions,
): Promise<ResolveWaitResult> {
  const session = sessions.session(request.sessionId)
  return resume === undefined
    ? session.resolveWait(request.waitId, result)
    : session.resolveWait(request.waitId, result, resume)
}

/**
 * Answer a request from anywhere: compare-and-set the store, then resolve the session's wait with
 * a text the model reads. The same assistant message continues (`wait.status === 'continued'`).
 * An unknown option id is `invalid` and changes nothing. A second answer gets `already-answered`
 * and delivers nothing (no race with the winner); {@link redeliverHandoff} recovers a crashed
 * delivery. `output` shapes what the parked tool call receives (default
 * {@link formatHandoffAnswer}); `resume` is forwarded to `session.resolveWait`; `metadata` is
 * applied by the winner in the same compare-and-set.
 *
 * @see docs/specs/32-handoff.md#4-resolving
 */
export async function resolveHandoff(args: {
  store: HandoffStore
  sessions: HandoffSessions
  id: string
  answer: HandoffAnswerInput
  /** What the parked tool call receives. Default: {@link formatHandoffAnswer} text. */
  output?: (request: HandoffRequest, answer: HandoffAnswer) => unknown
  /** Options of the continuation, forwarded to `session.resolveWait`. */
  resume?: HandoffResumeOptions
  /** Metadata patch stored with the answer (winner only). */
  metadata?: Record<string, unknown>
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
  const done: HandoffTransition = await store.answer(
    id,
    answer,
    args.metadata === undefined ? undefined : { metadata: args.metadata },
  )
  if (done.ok) {
    const wait = await deliver(
      sessions,
      done.request,
      { output: (args.output ?? formatHandoffAnswer)(done.request, answer) },
      args.resume,
    )
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
 * Crash recovery: deliver the stored answer of an `answered` request, but only while the session
 * still waits for it (`pendingWaits()` lists the wait). Returns `resolved` with the delivery, or
 * `already-answered` without `wait` when nothing is pending any more (already delivered, timed
 * out, or the session is gone). Never racing a live `resolveHandoff`: call it from a sweeper,
 * after the answer is old enough that its delivery cannot be in flight.
 */
export async function redeliverHandoff(args: {
  store: HandoffStore
  sessions: HandoffRedeliverSessions
  id: string
  output?: (request: HandoffRequest, answer: HandoffAnswer) => unknown
  resume?: HandoffResumeOptions
}): Promise<HandoffResolution> {
  const request = await args.store.get(args.id)
  if (request === undefined) return { status: 'not-found' }
  if (request.status === 'expired' || request.status === 'cancelled') {
    return { status: 'closed', reason: request.status, request }
  }
  if (request.status !== 'answered' || request.answer === undefined) {
    return { status: 'invalid', error: 'The request is not answered.' }
  }
  const session = args.sessions.session(request.sessionId)
  const pending = await session.pendingWaits()
  if (!pending.some((w) => w.waitId === request.waitId)) {
    return { status: 'already-answered', request }
  }
  const wait = await deliver(
    args.sessions,
    request,
    { output: (args.output ?? formatHandoffAnswer)(request, request.answer) },
    args.resume,
  )
  return { status: 'resolved', request, wait }
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
