/**
 * `handleChatRequest`: maps a `useChat` request body onto the session operations (spec 11 §7).
 *
 * @see docs/specs/11-interaction.md#7-handlechatrequest-usechat-adapter
 */
import type { UIMessage } from 'ai'
import type {
  HarnessRun,
  HarnessSession,
  PendingResponse,
  SendOptions,
} from '../agent/session-types.ts'
import { isHarnessError } from '../errors.ts'
import { uuidv7 } from '../messages/ids.ts'
import { isToolPart } from '../messages/tool-parts.ts'
import { RESPOND_IGNORE_UNKNOWN } from '../session/interaction/pending.ts'
import { failedRun } from './run.ts'

/**
 * The request body `useChat` sends (`DefaultChatTransport`): `{ id, messages, trigger,
 * messageId }`. Only `messages`, `trigger` and `messageId` are read.
 */
export interface ChatRequestBody {
  messages: UIMessage[]
  trigger?: 'submit-message' | 'regenerate-message'
  messageId?: string
}

/**
 * The decision fields of a client's assistant message (spec 11 §7): `approval.id / approved /
 * reason` of parts in `approval-responded`, and `toolCallId` / `output` / `errorText` of tool
 * parts in `output-available` / `output-error`. Nothing else of the client message is read.
 */
export function extractResponses(message: UIMessage): PendingResponse {
  const approvals: NonNullable<PendingResponse['approvals']> = []
  const toolOutputs: NonNullable<PendingResponse['toolOutputs']> = []
  const parts = Array.isArray(message?.parts) ? (message.parts as unknown[]) : []
  for (const raw of parts) {
    if (typeof raw !== 'object' || raw === null) continue
    const part = raw as {
      type?: unknown
      state?: unknown
      toolCallId?: unknown
      output?: unknown
      errorText?: unknown
      preliminary?: unknown
      approval?: { id?: unknown; approved?: unknown; reason?: unknown }
    }
    if (typeof part.type !== 'string' || !isToolPart({ type: part.type })) continue
    if (part.state === 'approval-responded') {
      const approval = part.approval
      if (typeof approval?.id !== 'string' || typeof approval.approved !== 'boolean') continue
      approvals.push({
        id: approval.id,
        approved: approval.approved,
        ...(typeof approval.reason === 'string' ? { reason: approval.reason } : {}),
      })
    } else if (typeof part.toolCallId === 'string') {
      if (part.state === 'output-available' && part.preliminary !== true) {
        toolOutputs.push({ toolCallId: part.toolCallId, output: part.output })
      } else if (part.state === 'output-error' && typeof part.errorText === 'string') {
        toolOutputs.push({ toolCallId: part.toolCallId, errorText: part.errorText })
      }
    }
  }
  return { approvals, toolOutputs }
}

/**
 * Handle a `useChat` request: dispatch synchronously on the request body only (the server never
 * trusts client history; everything that needs stored data is checked inside the run):
 *
 * 1. `trigger: 'regenerate-message'` → `regenerate({ messageId })`;
 * 2. last message `role: 'assistant'` → `respond()` with its decision fields (answers that are
 *    not pending are ignored; a pending item without an answer → `EH_INVALID_INPUT`);
 * 3. `messageId` set and last message `role: 'user'` → `edit(messageId, last)`;
 * 4. otherwise → `send(last)`.
 *
 * Throws only `EH_SESSION_CLOSED`. A busy session (`EH_SESSION_BUSY`) is returned as a failed run
 * (`stop: 'error'`, `error.code: 'EH_SESSION_BUSY'`) whose `toResponse()` / `pipeTo()` answer
 * **409** with `{ error: { code, message } }`; pass `{ ifBusy: 'wait' }` to wait instead (send and
 * respond only).
 *
 * @example
 * ```ts
 * export async function POST(req: Request) {
 *   const body = await req.json()
 *   const session = agent.session(body.id, { runtime: { userId } })
 *   return handleChatRequest(session, body).toResponse()
 * }
 * ```
 * @see docs/specs/11-interaction.md#7-handlechatrequest-usechat-adapter
 */
export function handleChatRequest<
  M extends UIMessage,
  Kinds extends Record<string, unknown> = Record<string, unknown>,
>(
  session: HarnessSession<M, Kinds>,
  body: ChatRequestBody,
  options: SendOptions = {},
): HarnessRun<M> {
  const messages: unknown[] = Array.isArray(body?.messages) ? body.messages : []
  const last = messages.at(-1) as UIMessage | undefined
  const messageId = typeof body?.messageId === 'string' ? body.messageId : undefined
  let kind: 'send' | 'respond' | 'regenerate' | 'edit' = 'send'
  try {
    if (body?.trigger === 'regenerate-message') {
      kind = 'regenerate'
      return session.regenerate({ ...options, ...(messageId === undefined ? {} : { messageId }) })
    }
    if (last?.role === 'assistant') {
      kind = 'respond'
      return session.respond(extractResponses(last), {
        ...options,
        [RESPOND_IGNORE_UNKNOWN]: true,
      } as SendOptions)
    }
    if (messageId !== undefined && last?.role === 'user') {
      kind = 'edit'
      return session.edit(messageId, last, options)
    }
    // no message at all: an empty user message, rejected by input normalization as a run error
    return session.send(last ?? ({ role: 'user', parts: [] } as unknown as UIMessage), options)
  } catch (error) {
    // a busy session is an answer, not an exception: 409 with a JSON body (spec 11 §7)
    if (!isHarnessError(error, 'EH_SESSION_BUSY')) throw error
    return failedRun(kind, uuidv7, error, 409) as unknown as HarnessRun<M>
  }
}
