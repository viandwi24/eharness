/**
 * Which agent runs a session id, and the canonical id. A session id is a chat thread
 * (`chat:<agentId>:<threadId>` of a thread row, or the first thread's `dm:<agentId>` / `dm:<slug>`),
 * a channel conversation, a background worker of one of those, or the session of a task row.
 */
import type { AgentRepo, TaskStore, ThreadStore } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { dmSessionId, isDmSession } from '../../domain/chat.ts'
import { parseChatSession } from '../../domain/threads.ts'

export type SessionResolver = (sessionId: string) => { def: AgentDef; id: string } | undefined

export function createSessionResolver(options: {
  agents: AgentRepo
  tasks: TaskStore
  threads: ThreadStore
}): SessionResolver {
  const { agents, tasks } = options
  const resolve: SessionResolver = (sessionId) => {
    // a background worker belongs to the agent of the session that started it
    const worker = sessionId.lastIndexOf(':worker:')
    if (worker > 0) {
      const parent = resolve(sessionId.slice(0, worker))
      return parent === undefined ? undefined : { def: parent.def, id: sessionId }
    }
    const chat = parseChatSession(sessionId)
    if (chat !== undefined && !chat.child && chat.threadId !== null) {
      // a `chat:` id of a thread that was never created is not a session
      const thread = options.threads.getBySession(sessionId)
      const def = thread === undefined ? undefined : agents.get(thread.agentId)
      return def === undefined ? undefined : { def, id: sessionId }
    }
    if (sessionId.startsWith('channel:')) {
      // a channel conversation exists only as a thread row (`infra/channels`)
      const thread = options.threads.getBySession(sessionId)
      const def = thread === undefined ? undefined : agents.get(thread.agentId)
      return def === undefined ? undefined : { def, id: sessionId }
    }
    if (sessionId.startsWith('heartbeat:')) {
      // the rolling heartbeat session of an agent (read for debugging on its page)
      const def = agents.get(sessionId.slice('heartbeat:'.length))
      return def === undefined ? undefined : { def, id: sessionId }
    }
    if (isDmSession(sessionId)) {
      const key = sessionId.slice('dm:'.length)
      const def = agents.get(key) ?? agents.getBySlug(key)
      return def === undefined ? undefined : { def, id: dmSessionId(def.id) }
    }
    const task = tasks.getBySession(sessionId)
    const def = task === undefined ? undefined : agents.get(task.agentId)
    return def === undefined ? undefined : { def, id: sessionId }
  }
  return resolve
}
