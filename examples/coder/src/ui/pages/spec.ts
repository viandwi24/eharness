/** Which fullscreen page is open. Lives apart from the page components so `slash.ts` can import it. */
import type { Entry } from '../state.ts'

export type PageSpec =
  | { kind: 'context' }
  | { kind: 'status' }
  | { kind: 'cost' }
  | { kind: 'help' }
  | { kind: 'agents' }
  | { kind: 'permissions' }
  | { kind: 'diff' }
  | { kind: 'config' }
  | { kind: 'tasks' }
  | { kind: 'doctor' }
  | { kind: 'memory' }
  | {
      kind: 'transcript'
      title: string
      subtitle?: string
      /** Snapshot of the entries to show (the page does not follow a running turn). */
      entries: Entry[]
      /** Page to return to when this one closes (e.g. the agents page). */
      parent?: PageSpec
    }
