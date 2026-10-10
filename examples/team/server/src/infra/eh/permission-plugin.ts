/**
 * Permissions with a mode per session (docs/specs/18-permissions-plugin.md §7, §12).
 *
 * `permissionsPlugin` takes one engine; the engine holds the Auto mode block counters, which are
 * per conversation (a pause in one chat must not pause another chat of the same agent, nor a
 * delegated task). So this plugin builds, in the session phase, one engine and one
 * `permissionsPlugin` per live session and installs that plugin's hooks as the session's hooks.
 * The mode is not engine state: `mode(ctx)` is read at every decision (spec 18 §7 `mode`
 * function), so a mode switch takes effect at the next tool call and never rebuilds an agent.
 *
 * Counters live in the engine of the live session in this process (the library does not persist
 * them, spec 18 §12); `registry` lets the mode service read them by session id.
 */
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import type { AutoEvent, PermissionEngine } from 'eharness/permissions'
import { permissionsPlugin } from 'eharness/permissions'
import { EH_MODE, type TeamMode } from '../../domain/modes.ts'

export interface SessionPermissionsOptions {
  /** A fresh engine (rules, tool kinds, classifier) for a session. */
  createEngine: () => PermissionEngine
  /** The mode of the session of `ctx` (own, inherited from the parent, agent, workspace). */
  mode: (ctx: HarnessContext) => TeamMode
  /** Engines of the live sessions of this process, by session id. */
  registry: Map<string, PermissionEngine>
  /** Auto mode blocked / paused / resumed, for the event feed. */
  onAuto?: (sessionId: string, event: AutoEvent, engine: PermissionEngine) => void
}

export function sessionPermissions(opts: SessionPermissionsOptions): HarnessPlugin<'permissions'> {
  return definePlugin({
    name: 'permissions',
    session: (ctx) => {
      const sessionId = (ctx as HarnessContext).session.id
      const engine = opts.createEngine()
      opts.registry.set(sessionId, engine)
      const unsubscribe = engine.subscribeAuto((event) => opts.onAuto?.(sessionId, event, engine))
      // the plan-exit tool belongs to plan mode, which the team app does not offer
      const inner = permissionsPlugin({
        engine,
        mode: (hookCtx) => EH_MODE[opts.mode(hookCtx)],
        planExitTool: false,
      })
      const contribution = inner['~def'].setup?.({
        agentId: ctx.agent.id,
        plugin: { name: 'permissions' },
        has: { dataPart: () => false, service: () => false },
      })
      return {
        ...(contribution?.hooks === undefined ? {} : { hooks: contribution.hooks }),
        dispose: () => {
          unsubscribe()
          if (opts.registry.get(sessionId) === engine) opts.registry.delete(sessionId)
        },
      }
    },
  })
}
