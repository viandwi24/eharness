/**
 * `heartbeat` plugin (docs/plans/P40-team-autonomous-operations.md, D9): the tool of the heartbeat
 * session and the hook that records how a beat ended.
 *
 *  - `team_status`  heartbeat sessions only. The server's deterministic observations as one compact
 *                   text: stuck, failed and long-waiting work, old decisions, failing programs and
 *                   routines, connectors that need sign-in, the budget, and repeated requests that
 *                   may deserve a program. Findings already reported inside their window are left
 *                   out, so the model reads only what is new.
 *  - `turn.end`     a beat's turn ended: record the
 *                   structured result, queue what is new for the digest, interrupt for urgent items.
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { TEAM_STATUS_TOOL } from '../../domain/heartbeat.ts'
import { originOfSession } from '../../domain/run-profiles.ts'

/** What the plugin needs from the app (`app/heartbeat.ts` over the deps, built in `main.ts`). */
export interface HeartbeatIntake {
  status(agentId: string): Promise<string>
  ended(end: { agentId: string; stop: string; output: unknown }): Promise<void>
}

export interface HeartbeatPluginOptions {
  /** Late-bound: the plugin is built before the app deps. */
  intake: () => HeartbeatIntake | undefined
}

export const TEAM_STATUS_DESCRIPTION =
  'What the server found about the team since it last told you: stuck, failed or long-waiting ' +
  'tasks, decisions waiting too long, programs and routines that fail or paused themselves, ' +
  'connectors that need sign-in, the budget, and requests the client repeated that may deserve ' +
  'a standing program. Read-only. Findings already reported are not listed again.'

export function heartbeat(options: HeartbeatPluginOptions): HarnessPlugin<'heartbeat'> {
  return definePlugin({
    name: 'heartbeat',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      if (originOfSession(sessionId) !== 'heartbeat') return {}
      const agentId = sessionId.slice('heartbeat:'.length)
      const intake = () => {
        const found = options.intake()
        if (found === undefined) throw new Error('the heartbeat is not ready')
        return found
      }
      return {
        tools: {
          [TEAM_STATUS_TOOL]: tool({
            description: TEAM_STATUS_DESCRIPTION,
            inputSchema: z.object({}),
            metadata: { risk: 'read', idempotent: true },
            execute: async (): Promise<string> => {
              try {
                return await intake().status(agentId)
              } catch (error) {
                return `ERROR: could not read the team status: ${errorText(error)}`
              }
            },
          }),
        } as never,
        hooks: {
          'turn.end': async (
            hookCtx: HarnessContext,
            e: { stop: string; output?: unknown },
          ): Promise<void> => {
            try {
              await intake().ended({ agentId, stop: e.stop, output: e.output })
            } catch (error) {
              hookCtx.log.warn(`heartbeat: could not record the beat: ${errorText(error)}`)
            }
          },
        } as never,
      }
    },
  })
}
