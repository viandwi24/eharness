/**
 * `fileGrant` plugin: a program run gets the file tools its authority grants, whatever the Files
 * capabilities of its agent say (docs/plans/P40-team-autonomous-operations.md, D3).
 *
 * The Files connector of an agent can have Edit switched off for chats; a program that grants the
 * agent write paths would then never get `write_file`, and `request_authority` could not help (the
 * tool does not exist, it is not an authority question). So the file tools are always defined
 * (`connector-catalog.ts`, `agent-factory.ts`), and this plugin narrows `activeTools` (spec 01 §4
 * `step.prepare`): every session sees the file tools its agent's connector offers, a program run
 * also those its authority names (`runFileTools`). The permission gate still limits each call to
 * the granted paths, and the capability switches stay what they are for every other session.
 * Tool definitions and their order never change (prompt-cache prefix).
 */
import { definePlugin, type HarnessPlugin } from 'eharness'

export interface FileGrantOptions {
  /** File tools the agent does not have through its connector (off, or no Files connection). */
  withheld: readonly string[]
  /** The file tools the authority of the session's program grants; empty for other sessions. */
  granted: (sessionId: string) => ReadonlySet<string>
}

export function fileGrant(options: FileGrantOptions): HarnessPlugin<'file-grant'> {
  return definePlugin({
    name: 'file-grant',
    setup: () => ({
      hooks: {
        'step.prepare': (ctx, e: { toolNames: string[] }) => {
          const granted = options.granted(ctx.session.id)
          const hidden = new Set(options.withheld.filter((t) => !granted.has(t)))
          if (hidden.size === 0) return undefined
          const activeTools = e.toolNames.filter((n) => !hidden.has(n))
          return activeTools.length === e.toolNames.length ? undefined : { activeTools }
        },
      },
    }),
  })
}
