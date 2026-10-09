/** Which fullscreen page is open. Lives apart from the page components so `slash.ts` can import it. */
import type { Entry } from '../state.ts'

/** The subagent an {@link PageSpec} `agent` page shows (its child session and what we know of it). */
export interface AgentViewTarget {
  /** Child session id: where the conversation is stored and where messages are addressed. */
  sessionId: string
  /** Display name: the name the model gave, else the subagent type. */
  name: string
  /** Subagent type, when known. */
  agent?: string
  /** One-line description of the task. */
  description?: string
  /** Background task id (`agent-2`), when it has one. */
  taskId?: string
  /** Status to show when no live task is found (a run of an earlier process). */
  status?: 'running' | 'done' | 'failed'
}

export type PageSpec =
  | { kind: 'context' }
  | { kind: 'status' }
  | { kind: 'cost' }
  | { kind: 'help' }
  | { kind: 'agents' }
  | { kind: 'permissions' }
  | { kind: 'diff' }
  | { kind: 'config' }
  | { kind: 'tasks' /** Preselect this task and show its output. */; taskId?: string }
  | {
      kind: 'agent'
      /** A subagent's conversation: live, scrollable, with a prompt that messages it. */
      target: AgentViewTarget
      /** Page to return to when this one closes (e.g. `/tasks`, `/agents`). */
      parent?: PageSpec
    }
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

/** The agent page target of a background agent task. */
export function agentTargetOfTask(task: {
  id: string
  sessionId?: string
  name?: string
  agent?: string
  label: string
  status: string
}): AgentViewTarget {
  const at = task.label.indexOf(': ')
  return {
    sessionId: task.sessionId ?? task.id,
    name: task.name ?? task.agent ?? (at > 0 ? task.label.slice(0, at) : task.id),
    ...(task.agent !== undefined ? { agent: task.agent } : {}),
    description: at > 0 ? task.label.slice(at + 2) : task.label,
    taskId: task.id,
    status: task.status === 'running' ? 'running' : task.status === 'completed' ? 'done' : 'failed',
  }
}
