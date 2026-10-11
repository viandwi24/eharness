/**
 * The chat routes: `POST /sessions/:id/chat`, `GET /sessions/:id/chat/stream` and
 * `POST /sessions/:id/interrupt`.
 *
 * @see docs/specs/26-http.md#8-chat-routes
 */
import type { UIMessage } from 'ai'
import { type ChatRequestOptions, handleChatRequest, handleResumeRequest } from '../index.ts'
import { denialOf } from './authorize.ts'
import { readJsonBody } from './body.ts'
import { httpError, jsonResponse } from './errors.ts'
import { type ChatKind, classifyChatBody, sanitizeChatBody } from './sanitize.ts'
import type { HttpCall, HttpEnv, SessionCtx } from './types.ts'
import type { ChatQueued, InterruptResult } from './wire.ts'

const KEY = /^[A-Za-z0-9_.:-]{1,128}$/
const IF_BUSY = new Set(['reject', 'steer', 'wait'])

/** Is this a valid idempotency key (`[A-Za-z0-9_.:-]{1,128}`)? */
export function isIdempotencyKey(value: string): boolean {
  return KEY.test(value)
}

const streamHeaders = (sessionId: string, turnId?: string): Headers => {
  const h = new Headers({
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    'x-eharness-session-id': sessionId,
  })
  if (turnId !== undefined) h.set('x-eharness-turn-id', turnId)
  return h
}

/** Ids of the decisions a respond message carries (approval ids and tool call ids). */
function responseIds(message: UIMessage | undefined): string[] {
  const ids: string[] = []
  for (const raw of message?.parts ?? []) {
    const p = raw as { state?: string; toolCallId?: string; approval?: { id?: string } }
    if (p.state === 'approval-responded' && typeof p.approval?.id === 'string')
      ids.push(p.approval.id)
    else if (typeof p.toolCallId === 'string') ids.push(p.toolCallId)
  }
  return ids
}

interface Meta {
  clientId?: string
  turnId?: string
  collected?: Array<{ clientId?: string }>
}

/** The stored message (of the last 40) that carries the client id `key`, with the turn it belongs to. */
function findByClientId(
  messages: UIMessage[],
  key: string,
): { messageId: string; turnId?: string } | undefined {
  for (const m of messages) {
    const meta = ((m.metadata as { eharness?: Meta } | undefined)?.eharness ?? {}) as Meta
    if (m.role === 'user') {
      if (meta.clientId === key || meta.collected?.some((c) => c.clientId === key) === true) {
        return { messageId: m.id, ...(meta.turnId === undefined ? {} : { turnId: meta.turnId }) }
      }
    } else {
      for (const part of m.parts) {
        const p = part as { type: string; data?: { clientId?: string } }
        if (p.type === 'data-eh.input' && p.data?.clientId === key) {
          return { messageId: m.id, ...(meta.turnId === undefined ? {} : { turnId: meta.turnId }) }
        }
      }
    }
  }
  return undefined
}

export async function handleChat<P>(env: HttpEnv<P>, call: HttpCall<P>): Promise<Response> {
  const { request } = call
  const sessionId = call.params.id as string
  const chat = env.options.chat ?? {}

  const read = await readJsonBody(request, env.maxBodyBytes)
  if (!read.ok) return read.response
  const clean = sanitizeChatBody(read.value, {
    sessionId,
    ...(chat.maxParts === undefined ? {} : { maxParts: chat.maxParts }),
    ...(chat.maxTextBytes === undefined ? {} : { maxTextBytes: chat.maxTextBytes }),
    clientTools: chat.clientTools !== undefined && chat.clientTools !== false,
    pageContext: chat.pageContext !== undefined && chat.pageContext !== false,
  })
  if (!clean.ok) return httpError(clean.code, clean.message, clean.details)
  const { body } = clean
  const kind: ChatKind = classifyChatBody(body)

  const url = new URL(request.url)
  const askedBusy = url.searchParams.get('ifBusy')
  const allowed = new Set<string>(chat.ifBusy ?? ['reject'])
  if (askedBusy !== null && (!IF_BUSY.has(askedBusy) || !allowed.has(askedBusy))) {
    return httpError('EH_INVALID_INPUT', 'This ifBusy policy is not accepted.', {
      reason: 'if-busy',
      allowed: [...allowed],
    })
  }
  const policy = (askedBusy ?? chat.defaultIfBusy ?? 'reject') as 'reject' | 'steer' | 'wait'

  let key: string | undefined
  const header = request.headers.get('idempotency-key')
  if (header !== null) {
    if (!KEY.test(header)) {
      return httpError('EH_HTTP_INVALID_BODY', 'Invalid Idempotency-Key.', {
        reason: 'idempotency-key',
      })
    }
    key = header
  } else if (clean.clientId !== undefined && KEY.test(clean.clientId)) {
    key = clean.clientId
  }

  if (chat.authorizeKind !== undefined) {
    const result = await chat.authorizeKind({
      principal: call.principal,
      kind,
      sessionId,
      request,
    })
    const denied = result === undefined ? undefined : denialOf(result)
    if (denied !== undefined) return denied
  }

  const ctx: SessionCtx<P> = { principal: call.principal, request, action: call.action }
  const session = await env.session?.(sessionId, ctx)
  if (session === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const peek = await env.peek?.(sessionId, ctx)
  const last = body.messages.at(-1)

  // a stale answer (answered in another tab, by a classifier, or consumed already) is a 409, not a turn
  if (kind === 'respond' && peek !== undefined) {
    const ids = responseIds(last)
    if (ids.length > 0) {
      const pending = await peek.pending()
      const waiting = new Set<string>()
      for (const a of pending?.approvals ?? []) {
        if (a.answer === undefined && a.granted !== true) waiting.add(a.approvalId)
      }
      for (const c of pending?.clientTools ?? []) {
        if (c.answer === undefined && c.result === undefined) waiting.add(c.toolCallId)
      }
      for (const e of pending?.externals ?? []) if (e.result === undefined) waiting.add(e.waitId)
      if (!ids.some((id) => waiting.has(id))) {
        return httpError('EH_HTTP_ALREADY_ANSWERED', 'These answers were given already.', { ids })
      }
    }
  }

  let ifBusy: ChatRequestOptions['ifBusy']
  if (kind === 'send') {
    // a steer into a turn of another instance is an inbox item: `enqueue({ id })` dedupes it
    if (policy === 'steer' && last !== undefined) {
      const busy = await peek?.busy()
      if (busy !== null && busy !== undefined && busy.scope === 'remote') {
        const queued = await session.enqueue(last, {
          mode: 'steer',
          ...(key === undefined ? {} : { id: key }),
        })
        const out: ChatQueued = {
          inboxId: queued.inboxId,
          delivered: 'steer',
          target: queued.target,
          ...(queued.duplicate === true ? { duplicate: true as const } : {}),
        }
        return jsonResponse(out, 202)
      }
    }
    if (key !== undefined && peek !== undefined) {
      const duplicate = findByClientId(await peek.messages({ limit: 40 }), key)
      if (duplicate !== undefined) {
        const busy = await peek.busy()
        const active =
          busy !== null && duplicate.turnId !== undefined && busy.turnId === duplicate.turnId
        return httpError('EH_HTTP_DUPLICATE_REQUEST', 'This message was received already.', {
          messageId: duplicate.messageId,
          ...(duplicate.turnId === undefined ? {} : { turnId: duplicate.turnId }),
          active,
        })
      }
    }
    if (policy === 'steer') ifBusy = 'steer'
    else if (policy === 'wait') ifBusy = 'wait'
  }

  const actor = chat.actorOf?.(call.principal)
  const options: ChatRequestOptions = {
    ...(chat.sendOptions?.(ctx) ?? {}),
    ...(ifBusy === undefined ? {} : { ifBusy }),
    ...(actor === undefined ? {} : { actor }),
    ...(chat.clientTools === undefined ? {} : { clientTools: chat.clientTools }),
    ...(chat.pageContext === undefined ? {} : { pageContext: chat.pageContext }),
  }
  const run = handleChatRequest(session, body, options)
  return await run.toHttpResponse({ headers: streamHeaders(sessionId, run.turnId) })
}

export async function handleResume<P>(env: HttpEnv<P>, call: HttpCall<P>): Promise<Response> {
  const sessionId = call.params.id as string
  const ctx: SessionCtx<P> = {
    principal: call.principal,
    request: call.request,
    action: call.action,
  }
  const session = await env.session?.(sessionId, ctx)
  if (session === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  return await handleResumeRequest(session, call.request, { headers: streamHeaders(sessionId) })
}

export async function handleInterrupt<P>(env: HttpEnv<P>, call: HttpCall<P>): Promise<Response> {
  const sessionId = call.params.id as string
  const read = await readJsonBody(call.request, Math.min(env.maxBodyBytes, 4096), true)
  if (!read.ok) return read.response
  const value = read.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return httpError('EH_HTTP_INVALID_BODY', 'The body must be a JSON object.')
  }
  const reason = (value as { reason?: unknown }).reason
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
    return httpError('EH_INVALID_INPUT', 'reason must be a string of at most 200 characters.', {
      reason: 'reason',
    })
  }
  const ctx: SessionCtx<P> = {
    principal: call.principal,
    request: call.request,
    action: call.action,
  }
  const session = await env.session?.(sessionId, ctx)
  if (session === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const result: InterruptResult = await session.requestAbort(reason)
  return jsonResponse({ target: result.target })
}
