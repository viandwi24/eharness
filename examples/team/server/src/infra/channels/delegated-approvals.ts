/**
 * Delegated agents in a chat (P40): a role agent that works for a channel session is a child
 * session of its own. When it waits for an approval or an answer, nobody in the chat would know:
 * this plugin hands each turn end of a child to the gateway, which posts the request in the
 * conversation that asked for the work, with the same buttons and the same who-may-answer rules
 * as a request of the lead. A child of a web chat or of a task is not a channel's business: the
 * gateway ignores it.
 */
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import type { ChannelGateway, PendingView } from './gateway.ts'

export interface DelegatedApprovalsOptions {
  /** Late-bound: the plugin is built before the gateway. */
  gateway: () => ChannelGateway | undefined
  /** The agent id and display name behind a hook context's agent slug. */
  agentOf: (slug: string) => { id: string; name: string } | undefined
}

/** A turn the launcher's call started directly (not from the inbox): the launcher waits for it. */
export function isForegroundTurn(ctx: Pick<HarnessContext, 'turn'>): boolean {
  return (ctx.turn as { source?: unknown } | undefined)?.source === undefined
}

export function delegatedApprovals(
  options: DelegatedApprovalsOptions,
): HarnessPlugin<'delegated-approvals'> {
  return definePlugin({
    name: 'delegated-approvals',
    setup: () => ({
      hooks: {
        // only a turn the launcher's `agent` call started directly is foreground (the launcher's turn
        // waits for it). A turn from the inbox never is: a background start (`subagent-bg:` key), a
        // resume by `send_message`, a wake. Treating those as foreground let every new chat message
        // abort a running worker.
        'turn.start': (ctx: HarnessContext): void => {
          const parent = ctx.session.parent?.sessionId
          if (parent === undefined || !parent.startsWith('channel:')) return
          options.gateway()?.delegatedTurnStarted({
            parentSessionId: parent,
            childSessionId: ctx.session.id,
            foreground: isForegroundTurn(ctx),
          })
        },
        'turn.end': async (
          ctx: HarnessContext,
          e: { stop: string; pending?: PendingView },
        ): Promise<void> => {
          const parent = ctx.session.parent?.sessionId
          if (parent === undefined || !parent.startsWith('channel:')) return
          const gw = options.gateway()
          if (gw === undefined) return
          const agent = options.agentOf(ctx.agent.id)
          try {
            await gw.delegatedTurnEnded({
              parentSessionId: parent,
              childSessionId: ctx.session.id,
              childAgentId: agent?.id ?? ctx.agent.id,
              agentName: agent?.name,
              stop: e.stop,
              pending: e.pending,
            })
          } catch (error) {
            ctx.log.warn(`channels: delegated turn end of ${ctx.session.id}: ${errorText(error)}`)
          }
        },
      } as never,
    }),
  })
}
