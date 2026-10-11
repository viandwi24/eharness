/**
 * The attention queue: everything that waits for a person across a set of sessions and their
 * children, and an idempotent way to answer one item on the session that owns it, from any
 * instance. Reads go through `SessionPeek` (no hooks, no resume); answers open the owning session
 * and use `respond()` / `resolveWait()`.
 *
 * @see docs/specs/25-activity.md#5-the-attention-queue
 */
import {
  type ApprovalActor,
  HarnessError,
  type HarnessErrorCode,
  isHarnessError,
  isUuidV7,
  type PendingExternal,
  type PendingResponse,
  type PendingState,
  type ResolveWaitResult,
  type SendOptions,
  type SessionPeek,
  type ToolRisk,
  type TurnResult,
} from '../index.ts'
import type { ActivityStore } from './types.ts'

/** What kind of answer an item needs. */
export type AttentionKind = 'approval' | 'client-tool' | 'wait'

/** One item that waits for an answer. */
export interface AttentionItem {
  /** `approvalId`, `toolCallId` (client tool) or `waitId` (external wait): unique within `sessionId`. */
  id: string
  kind: AttentionKind
  /** The session that owns the item: answer it there (never through its parent). */
  sessionId: string
  /** The session this one is a child of; `null` for a root. */
  parentSessionId: string | null
  /** The root of the walk this item was found under. */
  rootSessionId: string
  /** Catalog key of the agent that runs the session (from the child index, or the root info). */
  agent?: string
  /** Name / description the launcher gave a child. */
  name?: string
  description?: string
  toolCallId: string
  toolName: string
  /** The (refined) input of the call, when the state carries it. */
  input: unknown
  /** Approvals only. */
  risk: ToolRisk | null
  /** The assistant message that holds the item. */
  messageId: string
  /**
   * Epoch ms of the assistant message that raised the item (decoded from its UUIDv7 id); `null`
   * for a message id that is not a UUIDv7.
   */
  createdAt: number | null
  /** Waits only: `payload` / `correlationId` / `timeoutAt` of the external wait. */
  waitId?: string
  payload?: unknown
  correlationId?: string
  /** Client tools with a timeout and waits: epoch ms after which the item takes its timeout result. */
  timeoutAt?: number
  /**
   * Items of the same session that were answered by a partial `respond()` and wait for the others
   * of their batch (they are not listed; this is their count).
   */
  answeredWaiting: number
}

/** How to open a session of the walk for reading. */
export type AttentionPeekFn = (
  sessionId: string,
  info: { agent?: string; parentSessionId: string | null },
) => SessionPeek | undefined | Promise<SessionPeek | undefined>

/** Options of {@link listAttention}. */
export interface ListAttentionOptions {
  /** Sessions to start from (a lead's session, task sessions); children are walked. */
  roots: ReadonlyArray<string | { sessionId: string; agent?: string }>
  /** A read handle of a session (`agent.peek(id)` of the agent that runs it). */
  peek: AttentionPeekFn
  /**
   * Include external waits (`kind: 'wait'`): `true`, or a predicate that picks the waits a person
   * can act on. Default `false`: a parent parked on a subagent is an external wait too, and nobody
   * can answer that one.
   */
  waits?: boolean | ((wait: PendingExternal) => boolean)
  /** Walk children this deep (0 = the roots only). Default 8. */
  maxDepth?: number
}

/** UUIDv7 timestamp of an id, or `null`. */
function idTime(id: string): number | null {
  if (!isUuidV7(id)) return null
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
}

function itemsOf(
  pending: PendingState,
  base: Pick<
    AttentionItem,
    'sessionId' | 'parentSessionId' | 'rootSessionId' | 'agent' | 'name' | 'description'
  >,
  waits: boolean | ((wait: PendingExternal) => boolean),
): AttentionItem[] {
  const out: AttentionItem[] = []
  const answeredWaiting =
    pending.approvals.filter((a) => a.answer !== undefined || a.granted === true).length +
    pending.clientTools.filter((c) => c.answer !== undefined).length
  const common = {
    ...base,
    messageId: pending.messageId,
    createdAt: idTime(pending.messageId),
    answeredWaiting,
  }
  for (const a of pending.approvals) {
    if (a.answer !== undefined || a.granted === true) continue
    out.push({
      ...common,
      id: a.approvalId,
      kind: 'approval',
      toolCallId: a.toolCallId,
      toolName: a.toolName,
      input: a.input ?? null,
      risk: a.risk ?? null,
    })
  }
  for (const c of pending.clientTools) {
    if (c.answer !== undefined || c.result !== undefined) continue
    out.push({
      ...common,
      id: c.toolCallId,
      kind: 'client-tool',
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input ?? null,
      risk: null,
      ...(c.timeoutAt === undefined ? {} : { timeoutAt: c.timeoutAt }),
    })
  }
  if (waits !== false) {
    for (const e of pending.externals ?? []) {
      if (e.result !== undefined) continue
      if (typeof waits === 'function' && !waits(e)) continue
      out.push({
        ...common,
        id: e.waitId,
        kind: 'wait',
        waitId: e.waitId,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        input: null,
        risk: null,
        ...(e.payload === undefined ? {} : { payload: e.payload }),
        ...(e.correlationId === undefined ? {} : { correlationId: e.correlationId }),
        ...(e.timeoutAt === undefined ? {} : { timeoutAt: e.timeoutAt }),
      })
    }
  }
  return out
}

/**
 * Everything that waits for an answer in the roots and their children (recursively), oldest
 * session first as walked. Reads stored state only, so it works in any instance and never resumes
 * a parked parent.
 */
export async function listAttention(options: ListAttentionOptions): Promise<AttentionItem[]> {
  const waits = options.waits ?? false
  const maxDepth = options.maxDepth ?? 8
  const out: AttentionItem[] = []
  const seen = new Set<string>()

  const walk = async (
    sessionId: string,
    info: { agent?: string; name?: string; description?: string; parentSessionId: string | null },
    rootSessionId: string,
    depth: number,
  ): Promise<void> => {
    if (seen.has(sessionId)) return
    seen.add(sessionId)
    const peek = await options.peek(sessionId, {
      ...(info.agent === undefined ? {} : { agent: info.agent }),
      parentSessionId: info.parentSessionId,
    })
    if (peek === undefined) return
    const pending = await peek.pending()
    if (pending !== null) {
      out.push(
        ...itemsOf(
          pending,
          {
            sessionId,
            parentSessionId: info.parentSessionId,
            rootSessionId,
            ...(info.agent === undefined ? {} : { agent: info.agent }),
            ...(info.name === undefined ? {} : { name: info.name }),
            ...(info.description === undefined ? {} : { description: info.description }),
          },
          waits,
        ),
      )
    }
    if (depth >= maxDepth) return
    for (const child of await peek.children()) {
      await walk(
        child.sessionId,
        {
          ...(child.agent === undefined ? {} : { agent: child.agent }),
          ...(child.name === undefined ? {} : { name: child.name }),
          ...(child.description === undefined ? {} : { description: child.description }),
          parentSessionId: sessionId,
        },
        rootSessionId,
        depth + 1,
      )
    }
  }

  for (const root of options.roots) {
    const sessionId = typeof root === 'string' ? root : root.sessionId
    const agent = typeof root === 'string' ? undefined : root.agent
    await walk(
      sessionId,
      { ...(agent === undefined ? {} : { agent }), parentSessionId: null },
      sessionId,
      0,
    )
  }
  return out
}

// ─── answering ─────────────────────────────────────────────────────────────────────────────────

/** The answer to an item; `kind` must match the item (else `EH_INVALID_INPUT`, `reason: 'wrong-kind'`). */
export type AttentionAnswer =
  | {
      kind: 'approval'
      approved: boolean
      reason?: string
      note?: string
      remember?: 'once' | 'session'
      /** `respond({ endTurn })`: end the turn after the answers without a model call. */
      endTurn?: 'after-answers' | 'if-denied'
    }
  | { kind: 'client-tool'; output: unknown }
  | { kind: 'client-tool'; errorText: string }
  | { kind: 'wait'; output: unknown }
  | { kind: 'wait'; errorText: string }

/** What {@link answerAttention} needs of a live session. */
export interface AttentionSession {
  respond(
    response: PendingResponse,
    options?: SendOptions,
  ): { result: Promise<TurnResult<unknown>> }
  resolveWait(
    waitId: string,
    result: { output: unknown } | { errorText: string },
    options?: SendOptions & { actor?: ApprovalActor },
  ): Promise<
    | ResolveWaitResult<never>
    | { status: string; run?: { result: Promise<TurnResult<unknown>> }; remaining?: number }
  >
}

/** Options of {@link answerAttention}. */
export interface AnswerAttentionOptions {
  /** The session that owns the item (`AttentionItem.sessionId`). The answer goes there. */
  sessionId: string
  answer: AttentionAnswer
  /** Open the live session (`agent.session(id)` of the agent that runs it). */
  open: (sessionId: string) => AttentionSession | Promise<AttentionSession>
  /** A read handle (`agent.peek(id)`). */
  peek: (sessionId: string) => SessionPeek
  /** Who answers (audit, `approval.decided`). */
  actor?: ApprovalActor
  /** Emits an `attention-answered` event when given. */
  store?: ActivityStore
  /** Agent id the event carries. */
  agentId?: string
  /** `SendOptions` of the continuation (`runtime`, ...). */
  sendOptions?: SendOptions
  /** How long to wait for a run to fail fast before reporting `resumed` (ms). Default 250. */
  settleMs?: number
  /** Re-checks of a busy session before the item counts as answered elsewhere. Default 6 x 60 ms. */
  busyChecks?: number
  log?: { warn(message: string): void }
}

/** Outcome of {@link answerAttention}. */
export interface AnswerAttentionResult {
  /**
   * - `resumed`: the answer completed the batch and the session continues (in the background of
   *   this call; see `done`).
   * - `recorded`: stored; `remaining` items of the batch still wait. Nothing ran.
   * - `already-answered`: the item was answered before (by another tab, the classifier, another
   *   instance): the call did nothing. Safe to repeat.
   * - `not-found`: no such item, now or in the recent history of the session.
   */
  status: 'resumed' | 'recorded' | 'already-answered' | 'not-found'
  id: string
  sessionId: string
  kind?: AttentionKind
  /** Items of the batch still waiting (`recorded` only). */
  remaining?: number
  /** `resumed`: settles with the result of the continuation turn, never rejects. */
  done?: Promise<TurnResult<unknown> | undefined>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Located = { kind: AttentionKind; answered: boolean }

function locate(pending: PendingState | null, id: string): Located | undefined {
  if (pending === null) return undefined
  const a = pending.approvals.find((x) => x.approvalId === id)
  if (a !== undefined)
    return { kind: 'approval', answered: a.answer !== undefined || a.granted === true }
  const c = pending.clientTools.find((x) => x.toolCallId === id)
  if (c !== undefined)
    return { kind: 'client-tool', answered: c.answer !== undefined || c.result !== undefined }
  const e = (pending.externals ?? []).find((x) => x.waitId === id)
  if (e !== undefined) return { kind: 'wait', answered: e.result !== undefined }
  return undefined
}

function unanswered(pending: PendingState | null): number {
  if (pending === null) return 0
  return (
    pending.approvals.filter((a) => a.answer === undefined && a.granted !== true).length +
    pending.clientTools.filter((c) => c.answer === undefined && c.result === undefined).length +
    (pending.externals ?? []).filter((e) => e.result === undefined).length
  )
}

/** The item left the pending state: did it exist in the recent history (answered) or not at all? */
async function inHistory(peek: SessionPeek, id: string): Promise<boolean> {
  let messages: Awaited<ReturnType<SessionPeek['messages']>>
  try {
    messages = await peek.messages({ limit: 40 })
  } catch {
    return false
  }
  const toolCallId = id.startsWith('w_') ? id.slice(2) : id
  for (const m of messages) {
    for (const part of m.parts) {
      const p = part as { type: string; toolCallId?: string; approval?: { id?: string } }
      if (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool') continue
      if (p.approval?.id === id || p.toolCallId === id || p.toolCallId === toolCallId) return true
    }
  }
  return false
}

function rejected(error: NonNullable<TurnResult['error']>): HarnessError {
  return new HarnessError(
    (error.code as HarnessErrorCode | undefined) ?? 'EH_INVALID_INPUT',
    error.message,
    {
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  )
}

/**
 * Answer one item on the session that owns it. Idempotent and safe from any instance: a second
 * answer to the same item reports `already-answered` and changes nothing.
 *
 * Errors: a wrong kind or an invalid answer throws `EH_INVALID_INPUT`; `EH_SESSION_CLOSED` and
 * storage errors propagate; a run that fails for another reason throws its `EH_*` error. A busy
 * session (a turn of the same session runs, e.g. the same item is being answered right now)
 * becomes `already-answered` once the item is gone, else `EH_SESSION_BUSY` propagates.
 */
export async function answerAttention(
  id: string,
  options: AnswerAttentionOptions,
): Promise<AnswerAttentionResult> {
  const { sessionId, answer } = options
  const peek = options.peek(sessionId)
  const base = { id, sessionId }

  const emit = async (r: AnswerAttentionResult): Promise<AnswerAttentionResult> => {
    if (options.store !== undefined) {
      try {
        await options.store.append({
          type: 'attention-answered',
          sessionId,
          agentId: options.agentId ?? null,
          payload: {
            id,
            kind: r.kind ?? answer.kind,
            status: r.status,
            ...(r.remaining === undefined ? {} : { remaining: r.remaining }),
            ...(answer.kind === 'approval' ? { approved: answer.approved } : {}),
            ...(options.actor === undefined ? {} : { actor: options.actor.id }),
          },
        })
      } catch (error) {
        options.log?.warn(`activity: appending attention-answered failed: ${String(error)}`)
      }
    }
    return r
  }

  const before = await peek.pending()
  const found = locate(before, id)
  if (found === undefined) {
    return emit({ ...base, status: (await inHistory(peek, id)) ? 'already-answered' : 'not-found' })
  }
  if (found.answered) return emit({ ...base, kind: found.kind, status: 'already-answered' })
  if (found.kind !== answer.kind) {
    throw new HarnessError(
      'EH_INVALID_INPUT',
      `${id} is a ${found.kind}: answer it with a ${found.kind} answer.`,
      { details: { reason: 'wrong-kind', id, expected: found.kind } },
    )
  }
  const kind = found.kind
  const predicted = Math.max(0, unanswered(before) - 1)

  /** The item still waits for an answer; polls briefly so a first answer in flight can finish. */
  const waitsStill = async (): Promise<boolean> => {
    for (let i = 0; i < (options.busyChecks ?? 6); i++) {
      const state = locate(await peek.pending(), id)
      if (state === undefined || state.answered) return false
      await sleep(60)
    }
    return true
  }

  const session = await options.open(sessionId)
  const actor = options.actor
  let result: Promise<TurnResult<unknown> | undefined>

  try {
    if (answer.kind === 'wait') {
      const r = await session.resolveWait(
        id,
        'output' in answer ? { output: answer.output } : { errorText: answer.errorText },
        { ...(options.sendOptions ?? {}), ...(actor === undefined ? {} : { actor }) },
      )
      if (r.status === 'already-resolved' || r.status === 'not-pending') {
        return emit({ ...base, kind, status: 'already-answered' })
      }
      if (r.status === 'recorded') {
        return emit({
          ...base,
          kind,
          status: 'recorded',
          remaining: (r as { remaining: number }).remaining,
        })
      }
      const run = (r as { run?: { result: Promise<TurnResult<unknown>> } }).run
      result = (run?.result ?? Promise.resolve(undefined)).catch(() => undefined)
    } else {
      const response: PendingResponse =
        answer.kind === 'approval'
          ? {
              approvals: [
                {
                  id,
                  approved: answer.approved,
                  ...(answer.reason === undefined ? {} : { reason: answer.reason }),
                  ...(answer.note === undefined ? {} : { note: answer.note }),
                  ...(answer.remember === undefined ? {} : { remember: answer.remember }),
                  ...(actor === undefined ? {} : { actor }),
                },
              ],
            }
          : {
              toolOutputs: [
                'output' in answer
                  ? { toolCallId: id, output: answer.output }
                  : { toolCallId: id, errorText: answer.errorText },
              ],
            }
      const sendOptions: SendOptions = {
        ...(options.sendOptions ?? {}),
        ...(answer.kind === 'approval' && answer.endTurn !== undefined
          ? { endTurn: answer.endTurn }
          : {}),
      }
      const run = session.respond(response, sendOptions)
      result = run.result.catch(() => undefined)
    }
  } catch (error) {
    // busy because the same item is being answered right now (a second tab, another instance):
    // once the first answer consumed it, this one is just late
    if (isHarnessError(error, 'EH_SESSION_BUSY') && !(await waitsStill())) {
      return emit({ ...base, kind, status: 'already-answered' })
    }
    throw error
  }

  // `respond` throws only busy / closed; a stale or invalid answer is an error stop of the run.
  // Give it a moment to fail fast, then let the continuation run on in the background.
  const settled = await Promise.race([result, sleep(options.settleMs ?? 250).then(() => undefined)])
  if (settled !== undefined && settled.stop === 'error' && settled.error !== undefined) {
    const code = settled.error.code
    const reason = (settled.error.details as { reason?: string } | undefined)?.reason
    // answered elsewhere (a tab, the Auto classifier, another instance) or the message moved on
    if (reason === 'unknown-id' || reason === 'stale' || reason === 'conflict') {
      return emit({ ...base, kind, status: 'already-answered' })
    }
    if (code === 'EH_SESSION_BUSY' && !(await waitsStill())) {
      return emit({ ...base, kind, status: 'already-answered' })
    }
    throw rejected(settled.error)
  }
  if (settled?.partial === true) {
    return emit({
      ...base,
      kind,
      status: 'recorded',
      remaining: unanswered(settled.pending ?? null),
    })
  }
  if (settled === undefined && predicted > 0) {
    return emit({ ...base, kind, status: 'recorded', remaining: predicted })
  }
  return emit({ ...base, kind, status: 'resumed', done: result })
}
