/**
 * `routineOutcomes` plugin: at the end of every turn it tells the routine service how the turn
 * went, so a run row becomes `succeeded`, `failed` or `needs_action` and consecutive failures
 * pause the routine. A routine task session (`routine:<id>:<slot>`) is matched by its id, a DM fire
 * by the `inboxId` of the user message the inbox item became. Never throws into the turn.
 */
import { definePlugin, errorText, type HarnessPlugin } from 'eharness'
import { parseReport } from '../../domain/programs.ts'
import type { RoutineOutcomes } from './routine-service.ts'
import type { TurnRetryHooks } from './turn-retry-service.ts'

interface InputLike {
  metadata?: { eharness?: { inboxId?: string } }
}

export function routineOutcomes(options: {
  outcomes: RoutineOutcomes
  /** The automatic retry of transient failures: a failed turn that will be retried leaves its run `retrying`. */
  retry?: () => TurnRetryHooks | undefined
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
            turnId: string
            stop: string
            /** The validated structured output of a turn that asked for one (program runs). */
            output?: unknown
            /** `code` is always set (`HarnessErrorCode`, `EH_RUN_FAILED` when nothing more is known). */
            error?: { code: string; message: string }
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
          const report = parseReport(e.output)
          const plan = options.retry?.()?.observe({
            sessionId: ctx.session.id,
            turnId: e.turnId,
            stop: e.stop,
            error: e.error,
          })
          // not awaited: matching a DM fire may wait a moment for its run row
          void options.outcomes
            .turnEnded({
              sessionId: ctx.session.id,
              ...(inboxId === undefined ? {} : { inboxId }),
              stop: e.stop,
              ...(e.error === undefined
                ? {}
                : { errorMessage: e.error.message, errorCode: e.error.code }),
              needsPerson,
              ...(plan?.state === 'retrying'
                ? {
                    retry: {
                      attempt: plan.attempt,
                      max: plan.max,
                      nextAt: plan.nextAt,
                      errorMessage: plan.errorMessage,
                    },
                  }
                : plan?.state === 'exhausted'
                  ? { retryGaveUp: true }
                  : {}),
              ...(report === undefined
                ? {}
                : { reportStatus: report.status, reportSummary: report.summary }),
            })
            .catch((error) => {
              ctx.log.warn(`routineOutcomes failed: ${errorText(error)}`)
            })
        },
      },
    }),
  })
}
