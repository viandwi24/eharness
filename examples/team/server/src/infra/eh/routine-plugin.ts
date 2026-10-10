/**
 * `routineOutcomes` plugin: at the end of every turn it tells the routine service how the turn
 * went, so a run row becomes `succeeded`, `failed` or `needs_action` and consecutive failures
 * pause the routine. A routine task session (`routine:<id>:<slot>`) is matched by its id, a DM fire
 * by the `inboxId` of the user message the inbox item became. Never throws into the turn.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import type { RoutineOutcomes } from './routine-service.ts'

interface InputLike {
  metadata?: { eharness?: { inboxId?: string } }
}

export function routineOutcomes(options: {
  outcomes: RoutineOutcomes
}): HarnessPlugin<'routine-outcomes'> {
  const inboxByTurn = new Map<string, string>()
  return definePlugin({
    name: 'routine-outcomes',
    setup: () => ({
      hooks: {
        'turn.start': (ctx, e: { input?: InputLike }) => {
          const inboxId = e.input?.metadata?.eharness?.inboxId
          if (inboxId !== undefined && ctx.turn !== undefined) inboxByTurn.set(ctx.turn.id, inboxId)
        },
        'turn.end': (
          ctx,
          e: {
            stop: string
            error?: { message: string }
            pending?: {
              approvals: unknown[]
              clientTools: Array<{ result?: unknown }>
            }
          },
        ) => {
          const inboxId = ctx.turn === undefined ? undefined : inboxByTurn.get(ctx.turn.id)
          if (ctx.turn !== undefined) inboxByTurn.delete(ctx.turn.id)
          const needsPerson =
            e.pending !== undefined &&
            (e.pending.approvals.length > 0 ||
              e.pending.clientTools.some((c) => c.result === undefined))
          // not awaited: matching a DM fire may wait a moment for its run row
          void options.outcomes
            .turnEnded({
              sessionId: ctx.session.id,
              ...(inboxId === undefined ? {} : { inboxId }),
              stop: e.stop,
              ...(e.error === undefined ? {} : { errorMessage: e.error.message }),
              needsPerson,
            })
            .catch((error) => {
              ctx.log.warn(
                `routineOutcomes failed: ${error instanceof Error ? error.message : String(error)}`,
              )
            })
        },
      },
    }),
  })
}
