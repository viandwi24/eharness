/**
 * Chat thread use cases (P40 phase M, `domain/threads.ts`): any number of equal threads per agent,
 * new / rename / archive, and "Discuss in chat" (a new thread seeded with a briefing item, an
 * alert or a run). Threads are created on demand, never by an event.
 */
import type { AgentDef } from '../domain/agents.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  cleanThreadTitle,
  FIRST_THREAD_TITLE,
  legacyThreadSessionId,
  seedText,
  sortThreads,
  type Thread,
  type ThreadSeed,
  type ThreadSource,
  threadSessionId,
} from '../domain/threads.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'

const live = (deps: Deps, idOrSlug: string): AgentDef => {
  const agent = getAgent(deps, idOrSlug)
  if (agent.archivedAt !== null) {
    throw conflict(`agent is archived: ${agent.slug}`, 'AGENT_ARCHIVED')
  }
  return agent
}

function changed(deps: Deps, thread: Thread, action: string): void {
  deps.events.append({
    type: 'thread-changed',
    agentId: thread.agentId,
    sessionId: thread.sessionId,
    payload: { threadId: thread.id, action },
  })
}

/**
 * The migration of the single DM: an agent that has no thread yet gets one for its existing
 * `dm:<agentId>` session. Nothing is moved or copied; the history stays under the old id.
 * Idempotent, so every read can call it.
 */
export function ensureFirstThread(deps: Deps, agent: AgentDef): void {
  if (deps.threads.list(agent.id).length > 0) return
  deps.threads.insert({
    id: deps.ids.next(),
    agentId: agent.id,
    sessionId: legacyThreadSessionId(agent.id),
    title: FIRST_THREAD_TITLE,
    source: 'web',
    sourceLabel: null,
    seed: null,
    now: deps.clock.now(),
  })
}

/** Boot: every agent has its first thread, so repair passes see the sessions of old chats too. */
export function ensureAllFirstThreads(deps: Deps): void {
  for (const agent of deps.agents.list({ includeArchived: true })) ensureFirstThread(deps, agent)
}

export function listThreads(
  deps: Deps,
  idOrSlug: string,
  opts: { archived?: boolean } = {},
): Thread[] {
  const agent = getAgent(deps, idOrSlug)
  ensureFirstThread(deps, agent)
  const all = sortThreads(deps.threads.list(agent.id))
  return opts.archived === true ? all : all.filter((t) => t.archivedAt === null)
}

export function getThread(deps: Deps, agentIdOrSlug: string, threadId: string): Thread {
  const agent = getAgent(deps, agentIdOrSlug)
  const thread = deps.threads.get(threadId)
  if (thread === undefined || thread.agentId !== agent.id) throw notFound('thread', threadId)
  return thread
}

/**
 * The session of a thread of this agent: the one named, or without a name the thread with the
 * newest activity (the one the chat opens on). An archived thread still resolves (history).
 */
export function threadSessionOf(deps: Deps, agent: AgentDef, threadId?: string): string {
  if (threadId !== undefined) return getThread(deps, agent.id, threadId).sessionId
  ensureFirstThread(deps, agent)
  const open = listThreads(deps, agent.id)
  return (open[0] ?? sortThreads(deps.threads.list(agent.id))[0])?.sessionId as string
}

export function createThread(
  deps: Deps,
  idOrSlug: string,
  input: {
    title?: string | undefined
    source?: ThreadSource | undefined
    sourceLabel?: string | null | undefined
    seed?: ThreadSeed | null | undefined
  } = {},
): Thread {
  const agent = live(deps, idOrSlug)
  // a first request on an old agent adopts its single DM before it adds another thread
  ensureFirstThread(deps, agent)
  const title = input.title === undefined ? null : cleanThreadTitle(input.title)
  if (input.title !== undefined && title === '')
    throw invalid('title must not be empty', 'INVALID_TITLE')
  const id = deps.ids.next()
  const thread = deps.threads.insert({
    id,
    agentId: agent.id,
    sessionId: threadSessionId(agent.id, id),
    title,
    source: input.source ?? 'web',
    sourceLabel: input.sourceLabel ?? null,
    seed: input.seed ?? null,
    now: deps.clock.now(),
  })
  changed(deps, thread, 'created')
  return thread
}

export function renameThread(
  deps: Deps,
  idOrSlug: string,
  threadId: string,
  title: string,
): Thread {
  const thread = getThread(deps, idOrSlug, threadId)
  const clean = cleanThreadTitle(title)
  if (clean === '') throw invalid('title must not be empty', 'INVALID_TITLE')
  const next = deps.threads.patch(thread.id, { title: clean }, deps.clock.now()) as Thread
  changed(deps, next, 'renamed')
  return next
}

export function archiveThread(deps: Deps, idOrSlug: string, threadId: string): Thread {
  const thread = getThread(deps, idOrSlug, threadId)
  const next = deps.threads.patch(
    thread.id,
    { archivedAt: deps.clock.now() },
    deps.clock.now(),
  ) as Thread
  changed(deps, next, 'archived')
  return next
}

export function restoreThread(deps: Deps, idOrSlug: string, threadId: string): Thread {
  const thread = getThread(deps, idOrSlug, threadId)
  const next = deps.threads.patch(thread.id, { archivedAt: null }, deps.clock.now()) as Thread
  changed(deps, next, 'restored')
  return next
}

/** Every session that holds a conversation of the agent (threads, archived included). */
export function threadSessionsOf(deps: Deps, agentId: string): string[] {
  return [...new Set([legacyThreadSessionId(agentId), ...deps.threads.sessionsOf(agentId)])]
}

// --- Discuss in chat -------------------------------------------------------------------------

export type DiscussInput =
  | { kind: 'briefing'; ref: string; item?: number | undefined; agent?: string | undefined }
  | { kind: 'alert'; ref: string; agent?: string | undefined }
  | { kind: 'run'; ref: string; agent?: string | undefined }

function lead(deps: Deps): AgentDef {
  const found = deps.agents.list().find((a) => a.role === 'lead')
  if (found === undefined) throw conflict('the team has no lead agent', 'NO_LEAD')
  return found
}

/** The context a seeded thread opens with, read from the thing it is about. */
function contextOf(deps: Deps, input: DiscussInput): { seed: ThreadSeed; body: string } {
  if (input.kind === 'briefing') {
    const b = deps.briefings.get(input.ref)
    if (b === undefined) throw notFound('briefing', input.ref)
    if (input.item !== undefined) {
      const item = b.items[input.item]
      if (item === undefined) throw notFound('briefing item', String(input.item))
      const link = item.link === null ? '' : `\nLink: ${item.link}`
      return {
        seed: { kind: 'briefing', ref: b.id, title: item.title },
        body: `From the briefing of ${b.day} (${item.kind}):\n${item.title}\n${item.detail}${link}`,
      }
    }
    return { seed: { kind: 'briefing', ref: b.id, title: b.title }, body: b.body }
  }
  if (input.kind === 'alert') {
    const n = deps.notifications.get(input.ref)
    if (n === undefined || n.kind !== 'alert') throw notFound('alert', input.ref)
    const link = n.link === null ? '' : `\nLink: ${n.link}`
    return {
      seed: { kind: 'alert', ref: n.id, title: n.title },
      body: `${n.title}\n${n.body}${link}`,
    }
  }
  const task = deps.tasks.get(input.ref)
  if (task === undefined) throw notFound('run', input.ref)
  const agent = deps.agents.get(task.agentId)
  const outputs = task.report?.outputs ?? []
  const lines = [
    `Run: ${task.title}`,
    `Agent: ${agent?.name ?? task.agentId}`,
    `Status: ${task.status}`,
    ...(task.summary === null ? [] : [`Summary: ${task.summary}`]),
    ...(outputs.length === 0 ? [] : ['Outputs:', ...outputs.slice(0, 10).map((o) => `- ${o}`)]),
    `Open it: /tasks/${task.id} (its own session keeps the full context; it takes follow-ups too)`,
  ]
  return { seed: { kind: 'run', ref: task.id, title: task.title }, body: lines.join('\n') }
}

/**
 * A new thread seeded with the context of a briefing item, an alert or a run, on the lead (or the
 * agent named). The context is one `eh.event` message, no model call: the client's first message
 * starts the conversation. Always a new thread, never an existing one.
 */
export async function discussInChat(deps: Deps, input: DiscussInput): Promise<Thread> {
  const { seed, body } = contextOf(deps, input)
  const agent = input.agent === undefined ? lead(deps) : live(deps, input.agent)
  const thread = createThread(deps, agent.id, { title: seed.title, seed })
  await deps.chat.seed(agent, thread.sessionId, {
    name: `discuss.${seed.kind}`,
    text: seedText(seed, body),
    key: `discuss:${thread.id}`,
  })
  return thread
}
