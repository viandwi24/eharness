/**
 * `turnRetry` plugin: tells the retry service when a turn starts (a new message or a manual run
 * cancels a waiting retry) and when it ends (a transient failure schedules one; any other end
 * clears it). The task index, the run outcomes and the channel gateway read the plan from the same
 * `observe` call (idempotent per turn), so the order of the hooks does not matter. Never throws.
 */
import { definePlugin, errorText, type HarnessPlugin } from 'eharness'
import type { TurnRetryHooks } from './turn-retry-service.ts'

export function turnRetry(options: {
  retries: () => TurnRetryHooks | undefined
}): HarnessPlugin<'turn-retry'> {
  return definePlugin({
    name: 'turn-retry',
    setup: () => ({
      hooks: {
        'turn.start': (ctx): void => {
          try {
            if (ctx.turn !== undefined) options.retries()?.turnStarted(ctx.session.id, ctx.turn.id)
          } catch (error) {
            ctx.log.warn(`turnRetry start failed: ${errorText(error)}`)
          }
        },
        'turn.end': (
          ctx,
          e: { turnId: string; stop: string; error?: { code: string; message: string } },
        ): void => {
          try {
            options.retries()?.observe({
              sessionId: ctx.session.id,
              turnId: e.turnId,
              stop: e.stop,
              error: e.error,
            })
          } catch (error) {
            ctx.log.warn(`turnRetry end failed: ${errorText(error)}`)
          }
        },
      },
    }),
  })
}
