/**
 * `memoryDiscipline` plugin: memory keeps short rules and an index; facts, long
 * reports and dated files live in the library (P57). In every session (web chats, tasks, programs, chats), a memory write
 * that records system state (roles, rights, connection status, what the agent can or cannot do) or a
 * communication style is refused with a sentence the model reads. The channels plugin applies the
 * same rule in chat sessions; this covers everything else. Hook only: no tools, no instructions.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import { libraryFolders, memoryReportRefusal } from '../../domain/library-structure.ts'
import { memoryWriteRefusal } from '../channels/medium.ts'

export function memoryDiscipline(
  companyRoot: () => string | null = () => null,
): HarnessPlugin<'memory-discipline'> {
  return definePlugin({
    name: 'memory-discipline',
    setup: () => ({
      hooks: {
        'tool.approve': (
          _ctx,
          e: { toolName: string; input?: unknown },
        ): { type: 'denied'; reason: string } | undefined => {
          // long reports and dated files belong in the library (P57), then system state and style
          const refusal =
            memoryReportRefusal(e.toolName, e.input, libraryFolders(companyRoot())) ??
            memoryWriteRefusal(e.toolName, e.input)
          return refusal === undefined ? undefined : { type: 'denied', reason: refusal }
        },
      },
    }),
  })
}
