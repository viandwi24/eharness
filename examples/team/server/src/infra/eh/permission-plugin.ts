/**
 * Permissions with a mode per session (docs/specs/18-permissions-plugin.md §7, §12).
 *
 * `permissions` takes one engine; the engine holds the Auto mode block counters, which are
 * per conversation (a pause in one chat must not pause another chat of the same agent, nor a
 * delegated task). So this plugin builds, in the session phase, one engine and one
 * `permissions` per live session and installs that plugin's hooks as the session's hooks.
 * The mode is not engine state: `mode(ctx)` is read at every decision (spec 18 §7 `mode`
 * function), so a mode switch takes effect at the next tool call and never rebuilds an agent.
 *
 * Counters live in the engine of the live session in this process (the library does not persist
 * them, spec 18 §12); `registry` lets the mode service read them by session id.
 */
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import type { AutoEvent, PermissionEngine } from 'eharness/permissions'
import { DONT_ASK_REASON, permissions } from 'eharness/permissions'
import { EH_MODE, type TeamMode } from '../../domain/modes.ts'

/**
 * A closed-world gate of a session (a program run, `domain/programs.ts`): the engine settles the
 * rules (`forbidden` as deny rules, `dontAsk` so nothing asks), and the gate adds that a call is
 * approved only when an allow rule of the authority matches it. Anything else is denied with a
 * reason the model reads, never asked: a background run has nobody to ask.
 */
export interface SessionGate {
  /** The reason to refuse `call`, or undefined when the authority covers it. */
  refuse(call: { toolName: string; input: unknown }): string | undefined
  /** Reason of a call the engine would have asked about (an `alwaysAsk` tool, a protected path). */
  askedReason(toolName: string): string
  /**
   * Called before every decision of the session: bring the engine's rules up to date with the
   * authority (a program that was widened while the session was parked or running).
   */
  sync?(engine: PermissionEngine): Promise<void>
  /**
   * A rehearsal (`domain/rehearsal.ts`): for a call the authority and the engine would approve,
   * the text the model reads INSTEAD of the call being made (it is recorded by the gate); undefined
   * = let the call run.
   */
  simulate?(call: {
    toolName: string
    input: unknown
    risk?: string | undefined
  }): string | undefined
}

export interface SessionPermissionsOptions<G extends SessionGate = SessionGate> {
  /** The gate of a session that runs unattended under a closed authority; absent = normal modes. */
  gate?: (sessionId: string) => G | undefined
  /** A fresh engine (rules, tool kinds, classifier) for a session; `gate` is the session's own. */
  createEngine: (sessionId: string, gate?: G) => PermissionEngine
  /** The mode of the session of `ctx` (own, inherited from the parent, agent, workspace). */
  mode: (ctx: HarnessContext) => TeamMode
  /**
   * Tools shown as Allowed that Manual mode must not ask about (built-in reads): the engine's
   * default mode asks about them, an Auto classifier or Bypass is left alone.
   */
  manualAllowed?: (agentId: string, toolName: string) => boolean
  /** Engines of the live sessions of this process, by session id. */
  registry: Map<string, PermissionEngine>
  /** Auto mode blocked / paused / resumed, for the event feed. */
  onAuto?: (sessionId: string, event: AutoEvent, engine: PermissionEngine) => void
}

export function sessionPermissions<G extends SessionGate = SessionGate>(
  opts: SessionPermissionsOptions<G>,
): HarnessPlugin<'permissions'> {
  return definePlugin({
    name: 'permissions',
    session: (ctx) => {
      const sessionId = (ctx as HarnessContext).session.id
      const gate = opts.gate?.(sessionId)
      const engine = opts.createEngine(sessionId, gate)
      opts.registry.set(sessionId, engine)
      const unsubscribe = engine.subscribeAuto((event) => opts.onAuto?.(sessionId, event, engine))
      // the plan-exit tool belongs to plan mode, which the team app does not offer
      const inner = permissions({
        engine,
        // a gated session never asks: the engine runs in `dontAsk` whatever the chat mode says
        mode: gate === undefined ? (hookCtx) => EH_MODE[opts.mode(hookCtx)] : 'dontAsk',
        planExitTool: false,
      })
      const contribution = inner['~def'].setup?.({
        agentId: ctx.agent.id,
        plugin: { name: 'permissions' },
        has: { dataPart: () => false, service: () => false },
      })
      const base =
        gate === undefined || contribution?.hooks === undefined
          ? contribution?.hooks
          : ({
              ...contribution.hooks,
              'tool.approve': gatedApprove(contribution.hooks, gate, engine),
            } as typeof contribution.hooks)
      // Manual mode: an Allowed built-in read does not ask (a gated session has its own closed rules)
      const engineApprove = base?.['tool.approve'] as ApproveHook | undefined
      const hooks =
        gate !== undefined || engineApprove === undefined || opts.manualAllowed === undefined
          ? base
          : ({
              ...base,
              'tool.approve': async (hookCtx, e) => {
                const verdict = await engineApprove(hookCtx, e)
                if (
                  verdict?.type === 'user-approval' &&
                  opts.mode(hookCtx) === 'manual' &&
                  opts.manualAllowed?.(ctx.agent.id, e.toolName) === true
                ) {
                  return { type: 'approved' }
                }
                return verdict
              },
            } as typeof base)
      return {
        ...(hooks === undefined ? {} : { hooks }),
        dispose: () => {
          unsubscribe()
          if (opts.registry.get(sessionId) === engine) opts.registry.delete(sessionId)
        },
      }
    },
  })
}

type Verdict =
  | { type: 'approved' }
  | { type: 'user-approval'; reason?: string }
  | { type: 'denied'; reason: string }
  | undefined
type ApproveHook = (
  ctx: HarnessContext,
  e: { toolName: string; input: unknown; risk?: string },
) => Promise<Verdict> | Verdict

/**
 * `tool.approve` of a gated session: the gate's closed-world check, then the engine's verdict
 * (deny rules, `dontAsk`). Most restrictive wins, as in the core's chain (spec 11 §3); the
 * reasons are the program's, so the agent learns what to do instead.
 */
function gatedApprove(
  hooks: { 'tool.approve'?: unknown },
  gate: SessionGate,
  engine: PermissionEngine,
): ApproveHook {
  const engineHook = hooks['tool.approve'] as ApproveHook
  return async (ctx, e) => {
    await gate.sync?.(engine)
    const refusal = gate.refuse({ toolName: e.toolName, input: e.input })
    if (refusal !== undefined) return { type: 'denied', reason: refusal }
    const verdict = await engineHook(ctx, e)
    if (verdict !== undefined && verdict.type !== 'approved') {
      // `dontAsk` turns an ask into a denial with the generic text: say what the run can do about it
      if (verdict.type === 'user-approval' || verdict.reason === DONT_ASK_REASON) {
        return { type: 'denied', reason: gate.askedReason(e.toolName) }
      }
      return verdict
    }
    // approved (or no objection): a rehearsal still does not make the call of an external write
    const simulated = gate.simulate?.({ toolName: e.toolName, input: e.input, risk: e.risk })
    return simulated === undefined ? verdict : { type: 'denied', reason: simulated }
  }
}
