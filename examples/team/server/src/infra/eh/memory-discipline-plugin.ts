/**
 * `memoryDiscipline` plugin (production review): memory is for durable facts about the work and
 * people's stated preferences. In every session (web chats, tasks, programs, chats), a memory write
 * that records system state (roles, rights, connection status, what the agent can or cannot do) or a
 * communication style is refused with a sentence the model reads. The channels plugin applies the
 * same rule in chat sessions; this covers everything else. Hook only: no tools, no instructions.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import { memoryWriteRefusal } from '../channels/medium.ts'

export function memoryDiscipline(): HarnessPlugin<'memory-discipline'> {
  return definePlugin({
    name: 'memory-discipline',
    setup: () => ({
      hooks: {
        'tool.approve': (
          _ctx,
          e: { toolName: string; input?: unknown },
        ): { type: 'denied'; reason: string } | undefined => {
          const refusal = memoryWriteRefusal(e.toolName, e.input)
          return refusal === undefined ? undefined : { type: 'denied', reason: refusal }
        },
      },
    }),
  })
}
