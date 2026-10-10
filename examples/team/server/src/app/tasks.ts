/** Task board and agent session use cases. */
import { dmSessionId } from '../domain/chat.ts'
import { notFound } from '../domain/errors.ts'
import type { Task, TaskStatus } from '../domain/tasks.ts'
import { getAgent } from './agents.ts'
import type { ChatMessage, Deps } from './ports.ts'

export function listTasks(
  deps: Deps,
  query: { status?: TaskStatus; agentId?: string; limit?: number },
): Task[] {
  const agentId = query.agentId === undefined ? undefined : getAgent(deps, query.agentId).id
  return deps.tasks.list({
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(agentId === undefined ? {} : { agentId }),
    limit: query.limit ?? 100,
  })
}

export async function getTask(
  deps: Deps,
  id: string,
): Promise<{
  task: Task
  messages: ChatMessage[]
  approvals: Awaited<ReturnType<typeof taskApprovals>>
}> {
  const task = deps.tasks.get(id)
  if (task === undefined) throw notFound('task', id)
  const [messages, approvals] = await Promise.all([
    deps.team.taskMessages(task, 200),
    taskApprovals(deps, task),
  ])
  return { task, messages, approvals }
}

async function taskApprovals(deps: Deps, task: Task) {
  if (task.status !== 'needs_action') return []
  return (await deps.team.approvals()).filter((a) => a.sessionId === task.sessionId)
}

/** The DM chat and the tasks of an agent (owned, and handed to others from its DM). */
export async function agentSessions(deps: Deps, idOrSlug: string) {
  const agent = getAgent(deps, idOrSlug)
  const dm = dmSessionId(agent.id)
  const { owned, delegated } = deps.tasks.ofAgent(agent.id, dm)
  const activity = deps.tasks.activity().get(agent.id)
  const pending = (await deps.team.approvals()).filter((a) => a.sessionId === dm).length
  return {
    dm: {
      sessionId: dm,
      lastMessageAt: activity?.lastMessageAt ?? null,
      preview: activity?.preview ?? null,
      unread: activity?.unread ?? 0,
      pending,
    },
    tasks: owned,
    delegated,
  }
}
