/**
 * `chatTools` plugin: the connectors a person switched off in the composer menu are not offered
 * to the model in this chat. Tool definitions and their order never change; each step narrows
 * `activeTools` (spec 01 §4 `step.prepare`), and nothing is hidden for sessions without a pick
 * (delegated tasks, routines). Permissions and pinned asks are untouched: they still apply to
 * every tool that stays on.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'

export interface ChatToolsOptions {
  /** Connection ids switched off in this session; read at every step (a toggle applies at once). */
  off: (sessionId: string) => ReadonlySet<string>
  /** Final tool name to the connections that expose it (`ActivatedConnectors.toolNameMap`). */
  origins: Record<string, { connectionIds: string[] }>
}

/** Tool names that stay offered: those not owned only by switched-off connections. */
export function visibleTools(
  toolNames: readonly string[],
  off: ReadonlySet<string>,
  origins: ChatToolsOptions['origins'],
): string[] | undefined {
  if (off.size === 0) return undefined
  const kept = toolNames.filter((name) => {
    const ids = origins[name]?.connectionIds
    return ids === undefined || ids.length === 0 || !ids.every((id) => off.has(id))
  })
  return kept.length === toolNames.length ? undefined : kept
}

export function chatTools(options: ChatToolsOptions): HarnessPlugin<'chat-tools'> {
  return definePlugin({
    name: 'chat-tools',
    setup: () => ({
      hooks: {
        'step.prepare': (ctx, e: { toolNames: string[] }) => {
          const activeTools = visibleTools(
            e.toolNames,
            options.off(ctx.session.id),
            options.origins,
          )
          return activeTools === undefined ? undefined : { activeTools }
        },
      },
    }),
  })
}
