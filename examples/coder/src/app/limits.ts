/**
 * Safety ceiling of one turn. Cost is the library's own budget (`budget.maxTurnUsd`, stop
 * `cost-cap`, wired in `agent.ts`); wall time is the small plugin below (stop
 * `plugin:turn-time-limit:time`). Both stop a turn at a step boundary, never in the middle of a
 * tool call, and both leave the conversation intact: sending another message starts a new turn
 * with a fresh allowance.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'

/** Name of the wall-time plugin; its stop reason is `plugin:turn-time-limit:time`. */
export const TURN_TIME_PLUGIN = 'turn-time-limit'
const TIME_STOP = `plugin:${TURN_TIME_PLUGIN}:time`

/** Stops a turn after `maxMinutes` of wall time (checked after every step). `<= 0` = never. */
export function turnTimeLimit(options: {
  maxMinutes: number
  /** Clock, epoch ms (tests). Default `Date.now`. */
  now?: () => number
}): HarnessPlugin<typeof TURN_TIME_PLUGIN> {
  const now = options.now ?? Date.now
  const maxMs = options.maxMinutes * 60_000
  const started = new Map<string, number>()
  return definePlugin({
    name: TURN_TIME_PLUGIN,
    setup: () => ({
      hooks: {
        'turn.start': (ctx): void => {
          if (ctx.turn?.id !== undefined) started.set(ctx.turn.id, now())
        },
        'step.end': (ctx): { stop: string } | undefined => {
          const start = ctx.turn?.id === undefined ? undefined : started.get(ctx.turn.id)
          if (maxMs > 0 && start !== undefined && now() - start >= maxMs) {
            return { stop: 'time' }
          }
          return undefined
        },
        'turn.end': (_ctx, e: { turnId: string }): void => {
          started.delete(e.turnId)
        },
      },
    }),
  }) as HarnessPlugin<typeof TURN_TIME_PLUGIN>
}

/** The caps of one turn, as the notices and `/cost` show them. */
export interface TurnLimits {
  maxTurnCostUsd: number
  maxTurnMinutes: number
}

const usd = (n: number): string => `$${n.toFixed(2)}`

/**
 * Readable text for a turn that was stopped by a cap, with how to raise it; `undefined` for any
 * other stop. The turn is not lost: the conversation is stored and the user can just continue.
 */
export function limitStopNotice(
  stop: string,
  limits: TurnLimits,
  headless = false,
): string | undefined {
  const again = headless
    ? 'Run again with --continue to carry on (each turn gets a fresh cap)'
    : 'Send a message to continue (each turn gets a fresh cap)'
  if (stop === 'cost-cap') {
    return `Stopped: this turn reached its cost cap (${usd(limits.maxTurnCostUsd)}). ${again}, or raise it with --max-cost <usd> or limits.maxTurnCostUsd in settings (0 = no cap).`
  }
  if (stop === TIME_STOP) {
    return `Stopped: this turn reached its time cap (${limits.maxTurnMinutes} min). ${again}, or raise it with --max-time <minutes> or limits.maxTurnMinutes in settings (0 = no cap).`
  }
  return undefined
}
