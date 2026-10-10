/**
 * The DM chat of an agent on eharness sessions (docs/plans/P32-team-example.md §5.2): one session
 * `dm:<agentId>` per agent, built per request from the cached agent of the definition version.
 *
 * Busy policy for `send` (a plain user message):
 * - a turn runs in **this** process: `ifBusy: 'steer'` (the message joins the turn at its next
 *   step boundary; the response follows that turn);
 * - a turn runs in **another** instance (`session.busy()` says `remote`): the message is stored in
 *   the durable inbox as a steer and the route answers `202 { inboxId }`;
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
import { ALREADY_ANSWERED, conflict } from '../../domain/errors.ts'
import type { AgentFactory } from './agent-factory.ts'

/** Ids a posted assistant message answers: approval ids in `approval-responded`, answered tool calls. */
export function answeredIds(message: ChatMessage): string[] {
  const out: string[] = []
  for (const part of message.parts) {
    const p = part as {
      type?: string
      state?: string
      toolCallId?: string
      approval?: { id?: string }
    }
    if (typeof p.type !== 'string' || !p.type.startsWith('tool-')) continue
    if (p.state === 'approval-responded' && typeof p.approval?.id === 'string')
      out.push(p.approval.id)
    else if ((p.state === 'output-available' || p.state === 'output-error') && p.toolCallId) {
      out.push(p.toolCallId)
    }
  }
  return out
}

const asMessage = (m: HarnessUIMessage): ChatMessage => m as unknown as ChatMessage

export function createChatService(
  factory: AgentFactory,
  deps: Pick<Deps, 'workspaceId'>,
): ChatPort {
  /** Connectors are activated asynchronously (`factory.prepare`); the agent itself is synchronous. */
  const sessionFor = async (def: AgentDef): Promise<HarnessSession> => {
    await factory.prepare(def)
    return factory.agentFor(def).session(dmSessionId(def.id), {
      lock: factory.lock,
      runtime: { workspaceId: deps.workspaceId, agentId: def.id },
    }) as HarnessSession
  }

  const modelOf = (def: AgentDef): ChatStats['model'] => {
    const { id, profileId, contextWindow, maxOutputTokens, pricing } = factory.modelInfo(def)
    return {
      id,
      ...(profileId === undefined ? {} : { profileId }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(pricing === undefined
        ? {}
        : {
            pricing: {
              input: pricing.input,
              output: pricing.output,
              ...(pricing.cacheRead === undefined ? {} : { cacheRead: pricing.cacheRead }),
              ...(pricing.cacheWrite === undefined ? {} : { cacheWrite: pricing.cacheWrite }),
            },
          }),
    }
  }

  /** Approval ids and client tool call ids that still wait for an answer in the DM session. */
  const waitingIds = async (def: AgentDef): Promise<Set<string>> => {
    const pending = await factory.peek(dmSessionId(def.id)).pending()
    const out = new Set<string>()
    for (const a of pending?.approvals ?? []) if (a.answer === undefined) out.add(a.approvalId)
    for (const c of pending?.clientTools ?? []) {
      if (c.answer === undefined && c.result === undefined) out.add(c.toolCallId)
    }
    return out
  }

  return {
    async chat(def, input, { actor, ifBusy }) {
      const session = await sessionFor(def)
      const body = input as unknown as ChatRequestBody
      const last = input.messages.at(-1)
      const isSend =
        input.trigger !== 'regenerate-message' &&
        last?.role === 'user' &&
        input.messageId === undefined

      // A turn on another instance: the core cannot hand an input to it by itself, so the route
      // decides here (`busy()` is the liveness check: stored activeTurn with a fresh heartbeat).
      // an assistant message posted back answers items by id (`useChat` auto-send of an old tab, a
      // double click): when none of the ids it answers waits any more, it is a stale answer, not
      // a failing turn. 409 `ALREADY_ANSWERED`; the client refreshes quietly.
      if (last?.role === 'assistant' && input.trigger !== 'regenerate-message') {
        const waiting = await waitingIds(def)
        if (!answeredIds(last).some((id) => waiting.has(id))) {
          throw conflict(
            'Nothing in this message is waiting for an answer any more.',
            ALREADY_ANSWERED,
          )
        }
      }
      const busy = await session.busy()
      if (busy?.scope === 'remote') {
        if (!isSend || ifBusy !== 'steer') {
          throw conflict(`A turn of this chat is running on another instance.`, 'EH_SESSION_BUSY')
        }
        const queued = await session.enqueue(last as unknown as HarnessUIMessage, {
          mode: 'steer',
        })
        return { kind: 'queued', inboxId: queued.inboxId, target: queued.target }
      }
      const run = handleChatRequest(session, body, {
        actor,
        ...(isSend && ifBusy === 'steer' ? { ifBusy: 'steer' as const } : {}),
      })
      // a turn that fails before its commit point (busy, bad input, stale approval answer)
      // answers with an HTTP status; everything later stays in the stream
      return { kind: 'stream', response: await run.toHttpResponse() }
    },

    resume: async (def, request) => handleResumeRequest(await sessionFor(def), request),

    abort: async (def, reason) => (await sessionFor(def)).requestAbort(reason),

    async messages(def, { before, limit }) {
      // a pure read: no session.start hooks (agent.peek)
      await factory.prepare(def)
      const page = await factory
        .agentFor(def)
        .peek(dmSessionId(def.id))
        .messages({
          ...(before === undefined ? {} : { beforeId: before }),
          limit: limit + 1,
        })
      const more = page.length > limit
      const messages = (more ? page.slice(page.length - limit) : page).map(asMessage)
      return { messages, nextBefore: more ? (messages[0]?.id ?? null) : null }
    },

    async compact(def) {
      const message = await (await sessionFor(def)).compact()
      return { compacted: message !== null, message: message === null ? null : asMessage(message) }
    },

    stats: async (def) => statsOf(await sessionFor(def), modelOf(def)),

    async context(def) {
      const session = await sessionFor(def)
      const [stats, tools] = await Promise.all([statsOf(session, modelOf(def)), session.tools()])
      return {
        stats,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          source: t.source,
          deferred: t.deferred,
          tokens: t.tokens,
        })),
      }
    },
  }
}

async function statsOf(session: HarnessSession, model: ChatStats['model']): Promise<ChatStats> {
  const { pending, activeTurn, usage, ...context } = await session.stats()
  return {
    running: session.running,
    model,
    context: {
      window: context.window,
      tokens: context.tokens,
      instructions: context.instructions,
      tools: context.tools,
      messages: context.messages,
      summarizeAt: context.summarizeAt,
      hardLimit: context.hardLimit,
      ...(context.lastCompaction === undefined ? {} : { lastCompaction: context.lastCompaction }),
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
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      costUsd: usage.costUsd ?? 0,
      turns: usage.turns,
    },
  }
}
