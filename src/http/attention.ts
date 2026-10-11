/**
 * The attention routes: `GET /attention` and `POST /attention/:id/answer`.
 *
 * @see docs/specs/26-http.md#7-attention-routes
 */
import { type AttentionAnswer, answerAttention, listAttention } from '../activity/index.ts'
import { HarnessError, isRecord } from '../index.ts'
import { denialOf } from './authorize.ts'
import { readJsonBody } from './body.ts'
import { httpError, jsonResponse } from './errors.ts'
import type { AttentionTarget, HttpAttentionOptions, HttpCall, HttpEnv } from './types.ts'
import type { AnswerResponse, AttentionItemWire, AttentionListResponse } from './wire.ts'

const invalid = (
  message: string,
  reason: string,
): { problem: { message: string; reason: string } } => ({
  problem: { message, reason },
})

/** The answer of a wire body, whitelisted (`endTurn` is never read). `string` = the problem. */
function parseWireAnswer<P>(
  raw: unknown,
  options: HttpAttentionOptions<P>,
): AttentionAnswer | { problem: { message: string; reason: string } } {
  if (!isRecord(raw)) return invalid('answer must be an object.', 'answer')
  if (raw.kind === 'approval') {
    if (typeof raw.approved !== 'boolean') {
      return invalid('approved must be a boolean.', 'approved')
    }
    if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 2000)) {
      return invalid('reason must be a string of at most 2000 characters.', 'reason')
    }
    const maxNote = options.maxNoteChars ?? 2000
    if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > maxNote)) {
      return invalid(`note must be a string of at most ${maxNote} characters.`, 'note')
    }
    if (raw.remember !== undefined) {
      if (options.allowRemember !== true) {
        return invalid('remember is not accepted.', 'remember-not-allowed')
      }
      if (raw.remember !== 'once' && raw.remember !== 'session') {
        return invalid('remember must be once or session.', 'remember')
      }
    }
    return {
      kind: 'approval',
      approved: raw.approved,
      ...(raw.reason === undefined ? {} : { reason: raw.reason as string }),
      ...(raw.note === undefined ? {} : { note: raw.note as string }),
      ...(raw.remember === undefined ? {} : { remember: raw.remember as 'once' | 'session' }),
    }
  }
  if (raw.kind === 'client-tool' || raw.kind === 'wait') {
    if (typeof raw.errorText === 'string')
      return { kind: raw.kind, errorText: raw.errorText } as AttentionAnswer
    if ('output' in raw) return { kind: raw.kind, output: raw.output } as AttentionAnswer
    return invalid('Give output or errorText.', 'answer')
  }
  return invalid('Unknown answer kind.', 'kind')
}

export async function handleAttentionList<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const attention = env.options.attention
  if (attention === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const roots = await attention.roots({ principal: call.principal, request: call.request })
  const items = await listAttention({
    roots: [...roots],
    peek: attention.peek,
    ...(attention.waits === undefined ? {} : { waits: attention.waits }),
    ...(attention.maxDepth === undefined ? {} : { maxDepth: attention.maxDepth }),
  })
  const who = { principal: call.principal, request: call.request }
  const decorate = attention.decorate
  const out: AttentionItemWire[] = []
  if (decorate === undefined) out.push(...items)
  else {
    const extras = await Promise.all(items.map((item) => decorate(item, who)))
    items.forEach((item, i) => {
      const extra = extras[i]
      if (extra === null) return
      out.push(extra === undefined ? item : { ...item, extra })
    })
  }
  const body: AttentionListResponse = { items: out }
  return jsonResponse(body)
}

const MAX_DEPTH = 8

/** Is `sessionId` one of the roots or a descendant of one? Walks `parentInfo()` up. */
async function underRoots(
  attention: HttpAttentionOptions<never>,
  rootIds: Set<string>,
  sessionId: string,
): Promise<boolean> {
  let current = sessionId
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (rootIds.has(current)) return true
    const peek = await attention.peek(current, { parentSessionId: null })
    if (peek === undefined) return false
    const parent = await peek.parentInfo()
    if (parent === undefined) return false
    current = parent.sessionId
  }
  return false
}

export async function handleAttentionAnswer<P>(
  env: HttpEnv<P>,
  call: HttpCall<P>,
): Promise<Response> {
  const attention = env.options.attention
  if (attention === undefined) return httpError('EH_HTTP_NOT_FOUND', 'Not found.')
  const id = call.params.id as string
  const read = await readJsonBody(call.request, env.maxBodyBytes)
  if (!read.ok) return read.response
  const body = read.value
  if (!isRecord(body) || typeof body.sessionId !== 'string' || body.sessionId === '') {
    return httpError('EH_HTTP_INVALID_BODY', 'sessionId is required.', { reason: 'session-id' })
  }
  const sessionId = body.sessionId
  const who = { principal: call.principal, request: call.request }

  let allowed: boolean | Response
  if (attention.canAnswer !== undefined) {
    const result = await attention.canAnswer({ ...who, sessionId, attentionId: id })
    allowed = typeof result === 'boolean' ? result : (denialOf(result) ?? false)
  } else {
    const roots = await attention.roots(who)
    const ids = new Set(roots.map((r) => (typeof r === 'string' ? r : r.sessionId)))
    allowed = await underRoots(attention as HttpAttentionOptions<never>, ids, sessionId)
  }
  if (allowed instanceof Response) return allowed
  // outside the principal's roots reads as "no such item": it does not reveal that the session exists
  if (!allowed) return httpError('EH_HTTP_NOT_FOUND', 'No such attention item.')

  const peek = await attention.peek(sessionId, { parentSessionId: null })
  if (peek === undefined) return httpError('EH_HTTP_NOT_FOUND', 'No such attention item.')

  const defaultParse = (): AttentionAnswer => {
    const parsed = parseWireAnswer(body.answer, attention)
    if ('problem' in parsed) {
      throw new HarnessError('EH_INVALID_INPUT', parsed.problem.message, {
        details: { reason: parsed.problem.reason },
      })
    }
    return parsed
  }
  let answer: AttentionAnswer | undefined
  if (attention.parseAnswer !== undefined) {
    const pending = await peek.pending()
    const item = locate(pending, id, sessionId)
    answer = await attention.parseAnswer({
      ...(item === undefined ? {} : { item }),
      body,
      defaultParse,
    })
  }
  answer ??= defaultParse()

  const actor = env.options.chat?.actorOf?.(call.principal)
  const agentId =
    typeof attention.agentId === 'function' ? attention.agentId(sessionId) : attention.agentId
  const result = await answerAttention(id, {
    sessionId,
    answer,
    open: (sid) => attention.open(sid, who),
    peek: () => peek,
    ...(actor === undefined ? {} : { actor }),
    ...(attention.store === undefined ? {} : { store: attention.store }),
    ...(agentId === undefined ? {} : { agentId }),
  })
  if (result.status === 'not-found')
    return httpError('EH_HTTP_NOT_FOUND', 'No such attention item.')
  if (
    result.status === 'resumed' &&
    attention.onSettled !== undefined &&
    result.done !== undefined
  ) {
    const onSettled = attention.onSettled
    const kind = result.kind ?? 'approval'
    void result.done
      .then((turn) => onSettled({ id, sessionId, kind, result: turn, principal: call.principal }))
      .catch((error: unknown) =>
        env.options.onFailure?.(error, { request: call.request, action: call.action }),
      )
  }
  const out: AnswerResponse = {
    status: result.status,
    id: result.id,
    sessionId: result.sessionId,
    ...(result.kind === undefined ? {} : { kind: result.kind }),
    ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
  }
  return jsonResponse(out)
}

function locate(
  pending: Awaited<ReturnType<import('../index.ts').SessionPeek['pending']>>,
  id: string,
  sessionId: string,
): AttentionTarget | undefined {
  if (pending === null) return undefined
  const a = pending.approvals.find((x) => x.approvalId === id)
  if (a !== undefined) {
    return {
      id,
      kind: 'approval',
      sessionId,
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      input: a.input ?? null,
    }
  }
  const c = pending.clientTools.find((x) => x.toolCallId === id)
  if (c !== undefined) {
    return {
      id,
      kind: 'client-tool',
      sessionId,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input ?? null,
    }
  }
  const e = (pending.externals ?? []).find((x) => x.waitId === id)
  if (e !== undefined) {
    return {
      id,
      kind: 'wait',
      sessionId,
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      input: null,
    }
  }
  return undefined
}
