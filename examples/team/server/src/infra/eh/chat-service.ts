/**
 * The DM chat of an agent on eharness sessions (docs/plans/P32-team-example.md §5.2): one session
 * `dm:<agentId>` per agent, built per request from the cached agent of the definition version.
 *
 * Busy policy for `send` (a plain user message):
 * - a turn runs in **this** process: `ifBusy: 'steer'` (the message joins the turn at its next
 *   step boundary; the response follows that turn);
 * - a turn runs in **another** instance (`stats().activeTurn` fresh, no local turn): the message
 *   is stored in the durable inbox as a steer and the route answers `202 { inboxId }`;
 * - `ifBusy: 'reject'` (query parameter): 409 `EH_SESSION_BUSY` instead of steering.
 * `respond`, `regenerate` and `edit` never steer: a busy session answers 409 (core behaviour).
 */
import {
  type ChatRequestBody,
  type HarnessSession,
  type HarnessUIMessage,
  handleChatRequest,
  handleResumeRequest,
} from 'eharness'
import type { ChatMessage, ChatPort, ChatStats, Deps } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { dmSessionId } from '../../domain/chat.ts'
import { conflict } from '../../domain/errors.ts'
import type { AgentFactory } from './agent-factory.ts'

/** A turn whose heartbeat is older than this is treated as dead (core default `recovery.staleMs`). */
const STALE_TURN_MS = 120_000

const asMessage = (m: HarnessUIMessage): ChatMessage => m as unknown as ChatMessage

export function createChatService(
  factory: AgentFactory,
  deps: Pick<Deps, 'workspaceId'>,
): ChatPort {
  const sessionFor = (def: AgentDef): HarnessSession =>
    factory.agentFor(def).session(dmSessionId(def.id), {
      lock: factory.lock,
      runtime: { workspaceId: deps.workspaceId, agentId: def.id },
    }) as HarnessSession

  return {
    async chat(def, input, { actor, ifBusy }) {
      const session = sessionFor(def)
      const body = input as unknown as ChatRequestBody
      const last = input.messages.at(-1)
      const isSend =
        input.trigger !== 'regenerate-message' &&
        last?.role === 'user' &&
        input.messageId === undefined

      // A turn on another instance: the core reports a lock conflict as an error chunk inside a
      // 200 stream, so the route decides here and answers with a status (request R14).
      if (!session.running) {
        const { activeTurn } = await session.stats()
        if (activeTurn !== null && Date.now() - activeTurn.heartbeatAt < STALE_TURN_MS) {
          if (!isSend || ifBusy !== 'steer') {
            throw conflict(`A turn of this chat is running on another instance.`, 'EH_SESSION_BUSY')
          }
          const queued = await session.enqueue(last as unknown as HarnessUIMessage, {
            mode: 'steer',
          })
          return { kind: 'queued', inboxId: queued.inboxId, target: queued.target }
        }
      }
      const run = handleChatRequest(session, body, {
        actor,
        ...(isSend && ifBusy === 'steer' ? { ifBusy: 'steer' as const } : {}),
      })
      return { kind: 'stream', response: run.toResponse() }
    },

    resume: (def, request) => handleResumeRequest(sessionFor(def), request),

    abort: (def, reason) => sessionFor(def).requestAbort(reason),

    async messages(def, { before, limit }) {
      const page = await sessionFor(def).messages({
        ...(before === undefined ? {} : { beforeId: before }),
        limit: limit + 1,
      })
      const more = page.length > limit
      const messages = (more ? page.slice(page.length - limit) : page).map(asMessage)
      return { messages, nextBefore: more ? (messages[0]?.id ?? null) : null }
    },

    async compact(def) {
      const message = await sessionFor(def).compact()
      return { compacted: message !== null, message: message === null ? null : asMessage(message) }
    },

    async stats(def): Promise<ChatStats> {
      const session = sessionFor(def)
      const [stats, history] = await Promise.all([
        session.stats(),
        session.messages({ limit: 5000 }),
      ])
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        messages: 0,
      }
      for (const m of history) {
        const u = m.metadata?.eharness?.usage
        if (u === undefined) continue
        usage.messages++
        usage.inputTokens += u.inputTokens ?? 0
        usage.outputTokens += u.outputTokens ?? 0
        usage.totalTokens += u.totalTokens ?? 0
        usage.cachedInputTokens += u.cachedInputTokens ?? 0
        usage.costUsd += u.costUsd ?? 0
      }
      const { pending, activeTurn, ...context } = stats
      return {
        running: session.running,
        context: {
          window: context.window,
          tokens: context.tokens,
          instructions: context.instructions,
          tools: context.tools,
          messages: context.messages,
          summarizeAt: context.summarizeAt,
          hardLimit: context.hardLimit,
          ...(context.lastCompaction === undefined
            ? {}
            : { lastCompaction: context.lastCompaction }),
        },
        activeTurn:
          activeTurn === null
            ? null
            : {
                turnId: activeTurn.turnId,
                kind: activeTurn.kind,
                messageId: activeTurn.messageId,
                owner: activeTurn.owner,
                startedAt: activeTurn.startedAt,
                heartbeatAt: activeTurn.heartbeatAt,
              },
        pending:
          pending === null
            ? null
            : {
                messageId: pending.messageId,
                approvals: pending.approvals.map((a) => ({
                  approvalId: a.approvalId,
                  toolCallId: a.toolCallId,
                  toolName: a.toolName,
                  ...(a.input === undefined ? {} : { input: a.input }),
                  ...(a.risk === undefined ? {} : { risk: a.risk }),
                })),
                clientTools: pending.clientTools.length,
                externals: pending.externals?.length ?? 0,
              },
        usage,
      }
    },
  }
}
