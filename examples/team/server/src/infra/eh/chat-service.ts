/**
 * Chat reads and maintenance that are not part of `eharness/http`: compact, stats and context of
 * a chat thread session (`domain/threads.ts`). The chat itself (send, respond, resume, interrupt, messages) is
 * the library's HTTP module (`infra/eh/harness-http.ts`).
 */
import type { HarnessSession, HarnessUIMessage } from 'eharness'
import type { ChatMessage, ChatPort, ChatStats, Deps } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import type { AgentFactory } from './agent-factory.ts'

const asMessage = (m: HarnessUIMessage): ChatMessage => m as unknown as ChatMessage

export function createChatService(
  factory: AgentFactory,
  deps: Pick<Deps, 'workspaceId'>,
): ChatPort {
  /** Connectors are activated asynchronously (`factory.prepare`); the agent itself is synchronous. */
  const sessionFor = async (def: AgentDef, sessionId: string): Promise<HarnessSession> => {
    await factory.prepare(def)
    return factory.agentFor(def, sessionId).session(sessionId, {
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

  return {
    modelOf,

    async compact(def, sessionId) {
      const message = await (await sessionFor(def, sessionId)).compact()
      return { compacted: message !== null, message: message === null ? null : asMessage(message) }
    },

    stats: async (def, sessionId) => statsOf(await sessionFor(def, sessionId), modelOf(def)),

    async seed(def, sessionId, { name, text, key }) {
      const session = await sessionFor(def, sessionId)
      await session.inject('eh.event', { name, text }, { key })
    },

    async context(def, sessionId) {
      const session = await sessionFor(def, sessionId)
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
