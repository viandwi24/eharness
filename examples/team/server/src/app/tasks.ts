/** Task board and agent session use cases. */
import { conflict, invalid, notFound } from '../domain/errors.ts'
import type { Task, TaskStatus } from '../domain/tasks.ts'
import { isQueuedSession } from '../domain/work-queue.ts'
import { getAgent } from './agents.ts'
import { withCreator } from './library.ts'
import { listMemory } from './memory.ts'
import type { ChatMessage, Deps } from './ports.ts'
import { threadSessionOf } from './threads.ts'

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

const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file']

/**
 * The files a session wrote (`write_file` / `edit_file` calls that succeeded), once each, newest
 * first. Internal folders are left out. Read from the stored messages, so a view that wants only
 * the list never has to download them.
 */
export function writtenPaths(messages: readonly ChatMessage[]): string[] {
  const seen = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts) {
      const type = typeof p.type === 'string' ? p.type : ''
      const name = type === 'dynamic-tool' ? String(p.toolName ?? '') : type.replace(/^tool-/, '')
      if (!type.startsWith('tool-') && type !== 'dynamic-tool') continue
      if (!WRITE_TOOLS.has(name) || p.state !== 'output-available') continue
      if (typeof p.output === 'string' && /^\s*error\b/i.test(p.output)) continue
      const input = (p.input ?? {}) as Record<string, unknown>
      const path = PATH_KEYS.map((k) => input[k]).find(
        (v): v is string => typeof v === 'string' && v.startsWith('/'),
      )
      if (path === undefined || path.startsWith('/memories/') || path.startsWith('/.eharness/'))
        continue
      seen.add(path)
    }
  }
  return [...seen].reverse()
}

export async function getTask(
  deps: Deps,
  id: string,
  options: { messages?: boolean; outputs?: boolean } = {},
): Promise<{
  task: Task
  messages: ChatMessage[]
  outputs: string[]
  approvals: Awaited<ReturnType<typeof taskApprovals>>
  job: Awaited<ReturnType<Deps['team']['workerJob']>> | null
}> {
  const task = deps.tasks.get(id)
  if (task === undefined) throw notFound('task', id)
  const wantsMessages = options.messages !== false
  const [stored, approvals, job] = await Promise.all([
    isQueuedSession(task.sessionId) || (!wantsMessages && options.outputs !== true)
      ? Promise.resolve([])
      : deps.team.taskMessages(task, 200),
    taskApprovals(deps, task),
    isQueuedSession(task.sessionId) ? Promise.resolve(undefined) : deps.team.workerJob(task),
  ])
  return {
    task,
    messages: wantsMessages ? stored : [],
    outputs: options.outputs === true ? writtenPaths(stored) : [],
    approvals,
    job: job ?? null,
  }
}

/**
 * Retry a task now: continue its session from where the failed turn stopped (nothing already done
 * is done twice). For a task that failed, stopped, was interrupted, or waits for its automatic retry.
 */
export async function retryTask(deps: Deps, id: string): Promise<Task> {
  const task = taskOrThrow(deps, id)
  if (!['failed', 'retrying', 'interrupted', 'timed_out', 'stopped'].includes(task.status)) {
    throw conflict(
      'Only a task that stopped without finishing can be retried.',
      'TASK_NOT_RETRYABLE',
    )
  }
  if (isQueuedSession(task.sessionId)) {
    throw conflict('A queued task has no session yet: start it instead.', 'TASK_QUEUED')
  }
  await deps.turnRetry.retryNow(task.sessionId)
  return deps.tasks.get(id) ?? task
}

/** Stop the long-run job of a background worker task (the report to its parent says `stopped`). */
export async function stopWorkerTask(deps: Deps, id: string): Promise<Task> {
  const task = taskOrThrow(deps, id)
  const stopped = await deps.team.stopWorkerJob(task, 'stopped')
  if (!stopped)
    throw conflict('This task has no running background job to stop.', 'TASK_NOT_RUNNING')
  return deps.tasks.get(id) ?? task
}

async function taskApprovals(deps: Deps, task: Task) {
  if (task.status !== 'needs_action') return []
  return (await deps.team.approvals()).filter((a) => a.sessionId === task.sessionId)
}

/** The DM chat and the tasks of an agent (owned, and handed to others from its DM). */
export async function agentSessions(deps: Deps, idOrSlug: string, threadId?: string) {
  const agent = getAgent(deps, idOrSlug)
  const dm = threadSessionOf(deps, agent, threadId)
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

function taskOrThrow(deps: Deps, id: string): Task {
  const task = deps.tasks.get(id)
  if (task === undefined) throw notFound('task', id)
  return task
}

/** Everything that waits for a person (enriched with agent and task; answers are `/attention/{id}/answer`). */
export function listApprovals(deps: Deps) {
  return deps.team.approvals()
}

const MAX_TASK_MESSAGE_CHARS = 20_000

/** A message from the user into a task's session through the inbox (steer or queue). */
export async function messageTask(
  deps: Deps,
  id: string,
  body: { text: string; mode?: 'steer' | 'queue' },
) {
  const task = taskOrThrow(deps, id)
  if (task.status === 'queued') {
    throw conflict('a queued task has no session yet: change its brief instead', 'TASK_QUEUED')
  }
  const text = body.text.trim()
  if (text === '' || text.length > MAX_TASK_MESSAGE_CHARS) {
    throw invalid(`text must be 1-${MAX_TASK_MESSAGE_CHARS} characters`, 'INVALID_MESSAGE')
  }
  const mode = body.mode ?? 'steer'
  const queued = await deps.team.messageTask(task, text, mode)
  return { taskId: task.id, mode, ...queued }
}

/** Everything the right panel of an agent needs in one call. */
export async function agentContext(deps: Deps, idOrSlug: string, threadId?: string) {
  const agent = getAgent(deps, idOrSlug)
  const session = threadSessionOf(deps, agent, threadId)
  const [chat, memoryWorkspace] = await Promise.all([
    deps.chat.context(agent, session),
    Promise.resolve(listMemory(deps, 'workspace')),
  ])
  const { owned, delegated } = deps.tasks.ofAgent(agent.id, session)
  const active = (t: Task) => t.status === 'running' || t.status === 'needs_action'
  return {
    agent: { id: agent.id, slug: agent.slug, name: agent.name, role: agent.role },
    stats: chat.stats,
    tools: chat.tools,
    memory: {
      workspace: memoryWorkspace.files,
      agent: listMemory(deps, 'agent', agent.id).files,
    },
    routines: deps.routines.list({ agentId: agent.id }),
    tasks: { owned: owned.filter(active), delegated: delegated.filter(active) },
    files: deps.library
      .list({
        prefix: '/',
        excludePrefixes: ['/memories/'],
        createdBy: agent.id,
        newestFirst: true,
        limit: 20,
      })
      .map((m) => withCreator(deps, m)),
  }
}
