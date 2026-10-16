/**
 * Session reads: `GET /health`, `/sessions`, `/sessions/:id`, `/sessions/:id/messages`,
 * `/sessions/:id/messages/:messageId`.
 *
 * @see docs/specs/26-http.md#2-routes
 */
import type { PendingState } from '../index.ts'
import { clipMessages, parseClip } from './clip.ts'
import { httpError, jsonResponse } from './errors.ts'
import type { HttpCall, HttpEnv } from './types.ts'
import type {
  HealthResponse,
  MessagesPage,
  PendingSnapshot,
  SessionListResponse,
  SessionSnapshot,
} from './wire.ts'

/** Parse `?limit=` into `1..max`; `undefined` for an invalid value. */
export function parseLimit(raw: string | null, fallback: number, max: number): number | undefined {
  if (raw === null || raw === '') return fallback
  if (!/^\d{1,6}$/.test(raw)) return undefined
  const n = Number(raw)
  return n >= 1 && n <= max ? n : undefined
}

export async function handleHealth<P>(env: HttpEnv<P>): Promise<Response> {
  const body: HealthResponse = { ok: true, boot: env.boot }
  return jsonResponse(body)
}

export async function handleSessionList<P>(env: HttpEnv<P>, call: HttpCall<P>): Promise<Response> {
  const sessions = env.options.sessions
  if (sessions === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const url = new URL(call.request.url)
  const limit = parseLimit(url.searchParams.get('limit'), 50, 200)
  if (limit === undefined) {
    return httpError('EH_INVALID_INPUT', 'limit must be 1 to 200.', { reason: 'limit' })
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  const page = await sessions.list({
    principal: call.principal,
    request: call.request,
    query: { ...(cursor === undefined || cursor === '' ? {} : { cursor }), limit },
  })
  const body: SessionListResponse = {
    sessions: page.sessions,
    ...(page.next === undefined ? {} : { next: page.next }),
  }
  return jsonResponse(body)
}

function pendingSnapshot(pending: PendingState | null): PendingSnapshot | null {
  if (pending === null) return null
  return {
    messageId: pending.messageId,
    approvals: pending.approvals.map((a) => ({
      approvalId: a.approvalId,
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      ...(a.input === undefined ? {} : { input: a.input }),
      answered: a.answer !== undefined || a.granted === true,
    })),
    clientTools: pending.clientTools.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      ...(c.input === undefined ? {} : { input: c.input }),
      ...(c.timeoutAt === undefined ? {} : { timeoutAt: c.timeoutAt }),
      answered: c.answer !== undefined || c.result !== undefined,
    })),
    externals: (pending.externals ?? []).map((e) => ({
      waitId: e.waitId,
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      ...(e.timeoutAt === undefined ? {} : { timeoutAt: e.timeoutAt }),
      resolved: e.result !== undefined,
    })),
  }
}

export async function handleSessionRead<P>(env: HttpEnv<P>, call: HttpCall<P>): Promise<Response> {
  const id = call.params.id as string
  const peek = await env.peek?.(id, call)
  if (peek === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const [stats, busy] = await Promise.all([peek.stats(), peek.busy()])
  const info = await env.options.sessions?.describe?.(id, {
    principal: call.principal,
    request: call.request,
  })
  const body: SessionSnapshot = {
    id,
    running: busy !== null,
    busy,
    activeTurn: stats.activeTurn,
    pending: pendingSnapshot(stats.pending),
    usage: stats.usage,
    ...(info === undefined ? {} : { info }),
  }
  return jsonResponse(body)
}

export async function handleSessionMessages<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const id = call.params.id as string
  const peek = await env.peek?.(id, call)
  if (peek === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const url = new URL(call.request.url)
  const limit = parseLimit(url.searchParams.get('limit'), 50, 200)
  if (limit === undefined) {
    return httpError('EH_INVALID_INPUT', 'limit must be 1 to 200.', { reason: 'limit' })
  }
  const before = url.searchParams.get('before') ?? undefined
  if (before !== undefined && (before === '' || before.length > 256)) {
    return httpError('EH_INVALID_INPUT', 'before is not a message id.', { reason: 'before' })
  }
  const clip = parseClip(url.searchParams.get('clip'))
  if (clip === undefined) {
    return httpError('EH_INVALID_INPUT', 'clip must be 200 to 100000.', { reason: 'clip' })
  }
  const found = await peek.messages({
    limit: limit + 1,
    ...(before === undefined ? {} : { beforeId: before }),
  })
  const more = found.length > limit
  const messages = more ? found.slice(found.length - limit) : found
  const first = messages[0]
  const body: MessagesPage = {
    messages: clip === null ? messages : clipMessages(messages, clip),
    ...(more && first !== undefined ? { nextBefore: first.id } : {}),
  }
  return jsonResponse(body)
}

/** `GET /sessions/:id/messages/:messageId`: one stored message, never clipped. */
export async function handleSessionMessage<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const id = call.params.id as string
  const messageId = call.params.messageId as string
  const peek = await env.peek?.(id, call)
  if (peek === undefined || messageId === '' || messageId.length > 256) {
    return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  }
  // `before` is exclusive and ids sort as strings: `id + '~'` is the first key after `id`.
  const found = await peek.messages({ limit: 1, beforeId: `${messageId}~` })
  const message = found.at(-1)
  if (message === undefined || message.id !== messageId) {
    return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  }
  return jsonResponse(message)
}
