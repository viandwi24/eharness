import { errorText } from '../index.ts'
import { drain } from './child-run.ts'
import type { Scope } from './env.ts'
import type { AgentEntry } from './messaging.ts'
import type { MessageLike } from './report.ts'
import type { AnyRun, AnySession, SubagentRunData } from './types.ts'

/** Register an addressable child of this session. */
export function addEntry(
  scope: Scope,
  init: {
    childSessionId: string
    agent: string
    description: string
    name?: string
    taskId?: string
    status?: AgentEntry['status']
    parentInfo: AgentEntry['parentInfo']
    durable?: true
  },
): AgentEntry | undefined {
  const dir = scope.dir
  if (dir === undefined) return undefined
  const entry: AgentEntry = {
    childSessionId: init.childSessionId,
    ownerSessionId: scope.ctx.session.id,
    parentInfo: init.parentInfo,
    agent: init.agent,
    description: init.description,
    status: init.status ?? 'running',
    resumable: scope.defs()[init.agent]?.resumable !== false,
    startedAt: Date.now(),
    queued: [],
    ...(init.name === undefined ? {} : { name: init.name }),
    ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    ...(init.durable === true ? { durable: true as const } : {}),
  }
  if (init.durable !== true) entry.resume = (text, sender) => scope.resume(entry, text, sender)
  dir.entries.set(init.childSessionId, entry)
  return entry
}

/** The child runs: messages can be delivered into it. */
export function wireRunning(entry: AgentEntry, child: AnySession): void {
  entry.status = 'running'
  entry.deliver = async (text, data) => {
    await child.inject('eh.event', { name: 'agent-message', text, data }, { deliver: 'next-step' })
  }
  entry.deliverUser = async (text) => {
    // a steer: the text lands at the next step boundary as `data-eh.input { source: 'user' }`
    drain(child.send(text, { ifBusy: 'steer' }) as AnyRun)
  }
}

/** How the last turn of a (not running) child ended, read from its stored messages. */
async function storedOutcome(child: {
  messages(o: { limit: number }): Promise<unknown>
}): Promise<'completed' | 'failed'> {
  const stored = (await child.messages({ limit: 20 })) as Array<{
    role: string
    metadata?: { eharness?: { stop?: string } }
  }>
  const last = stored.findLast((m) => m.role === 'assistant')
  return last?.metadata?.eharness?.stop === 'complete' ? 'completed' : 'failed'
}

/** The child is done: it is no longer a delivery target. */
export function finishEntry(entry: AgentEntry | undefined, status: AgentEntry['status']): void {
  if (entry === undefined) return
  if (entry.status !== 'stopped') entry.status = status
  entry.deliver = undefined
  entry.deliverUser = undefined
  entry.queued.length = 0
}

/**
 * After a restart this process knows none of the earlier children: rebuild finished entries
 * from the markers and reports stored in this session (once, needs `selfAgent`).
 */
export async function rebuildEntries(scope: Scope, miss = false): Promise<void> {
  const { options } = scope.env
  if (scope.env.park) return rebuildPark(scope, miss)
  const dir = scope.dir
  if (scope.rebuilt || dir === undefined || options.selfAgent === undefined) return
  scope.rebuilt = true
  const { ctx } = scope
  try {
    const session = options.selfAgent().peek(ctx.session.id, scope.env.parentPeek(ctx.session.id))
    const children = await session.children()
    if (children.length === 0) return
    const byChild = new Map(children.map((c) => [c.sessionId, c]))
    type Stored = { id: string; parts: Array<{ type: string; data?: unknown }> }
    const markers = new Map<string, SubagentRunData>()
    const outcomes = new Map<string, string>()
    let before: string | undefined
    for (let page = 0; page < 5 && markers.size < 100; page++) {
      const batch = (await session.messages({
        limit: 200,
        ...(before === undefined ? {} : { beforeId: before }),
      })) as unknown as Stored[]
      if (batch.length === 0) break
      for (const message of batch.toReversed()) {
        for (const part of message.parts.toReversed()) {
          if (part.type === 'data-subagent.run') {
            const d = part.data as SubagentRunData
            if (!markers.has(d.sessionId)) markers.set(d.sessionId, d)
          } else if (part.type === 'data-eh.event') {
            const d = part.data as {
              name?: string
              data?: { sessionId?: string; status?: string }
            }
            if (d.name === 'subagent' && d.data?.sessionId !== undefined && d.data.status) {
              if (!outcomes.has(d.data.sessionId)) outcomes.set(d.data.sessionId, d.data.status)
            }
          }
        }
      }
      before = batch[0]?.id
      if (batch.length < 200) break
    }
    const defs = scope.defs()
    for (const [sessionId, marker] of markers) {
      if (dir.entries.has(sessionId)) continue
      const def = defs[marker.agent]
      const info = byChild.get(sessionId)
      if (def === undefined || info === undefined) continue
      let status: AgentEntry['status']
      const reported = outcomes.get(sessionId)
      if (reported === 'stopped' || reported === 'completed' || reported === 'failed') {
        status = reported
      } else if (marker.status === 'completed') status = 'completed'
      else if (marker.status === 'failed') status = 'failed'
      else {
        // the marker says running: the stored child tells how its last turn ended
        const child = scope.env.peekOf(def.agent, sessionId, {
          parentSessionId: ctx.session.id,
          agent: marker.agent,
          depth: scope.depth + 1,
        })
        status = await storedOutcome(child)
      }
      addEntry(scope, {
        childSessionId: sessionId,
        agent: marker.agent,
        description: marker.name ?? marker.agent,
        status,
        ...(marker.name === undefined ? {} : { name: marker.name }),
        ...(marker.taskId === undefined ? {} : { taskId: marker.taskId }),
        parentInfo: {
          sessionId: ctx.session.id,
          turnId: info.turnId,
          toolCallId: info.toolCallId ?? marker.toolCallId,
          depth: scope.depth + 1,
          agent: marker.agent,
          ...(marker.name === undefined ? {} : { name: marker.name }),
        },
      })
      const n = Number(/^agent-(\d+)$/.exec(marker.taskId ?? '')?.[1] ?? 0)
      if (n > 0) scope.registry.reserve(n)
    }
  } catch (error) {
    ctx.log.warn('subagent: could not rebuild the agent directory', { error: errorText(error) })
  }
}

type LaunchInput = { subagent_type?: string; description?: string; name?: string }

/** The `agent` tool inputs of `toolCallIds`, read from the stored messages of `session`. */
export async function readLaunchInputs(
  session: Pick<AnySession, 'messages'>,
  toolCallIds: Set<string>,
): Promise<Map<string, LaunchInput>> {
  const found = new Map<string, LaunchInput>()
  let before: string | undefined
  for (let page = 0; page < 5 && found.size < toolCallIds.size; page++) {
    const batch = (await session.messages({
      limit: 200,
      ...(before === undefined ? {} : { beforeId: before }),
    })) as unknown as MessageLike[]
    if (batch.length === 0) break
    for (const message of batch) {
      for (const part of message.parts) {
        if (
          part.toolCallId !== undefined &&
          toolCallIds.has(part.toolCallId) &&
          typeof part.input === 'object' &&
          part.input !== null &&
          (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
        ) {
          found.set(part.toolCallId, part.input as LaunchInput)
        }
      }
    }
    before = batch[0]?.id
    if (batch.length < 200) break
  }
  return found
}

/**
 * `'park'`: rebuild this session's agent directory from storage (the child index plus the
 * `agent` tool inputs in its messages), so names and finished agents work in any instance.
 * Throttled: a miss may force a rebuild after 500 ms, a step reminder every 15 s.
 */
export async function rebuildPark(scope: Scope, miss: boolean): Promise<void> {
  const { dir, ctx } = scope
  const { options } = scope.env
  if (dir === undefined || options.selfAgent === undefined) return
  const now = Date.now()
  if (now - scope.rebuiltAt < (miss ? 500 : 15_000)) return
  scope.rebuiltAt = now
  try {
    const session = options.selfAgent().peek(ctx.session.id, scope.env.parentPeek(ctx.session.id))
    const children = (await session.children()).filter(
      (c) => c.toolCallId !== undefined && !dir.entries.has(c.sessionId),
    )
    if (children.length === 0) return
    const inputs = await readLaunchInputs(
      session,
      new Set(children.map((c) => c.toolCallId as string)),
    )
    const defs = scope.defs()
    for (const info of children) {
      const input = inputs.get(info.toolCallId as string)
      const type = info.agent ?? input?.subagent_type
      if (type === undefined || defs[type] === undefined) continue
      addEntry(scope, {
        childSessionId: info.sessionId,
        agent: type,
        description: info.description ?? input?.description ?? type,
        status: 'completed',
        durable: true,
        ...((info.name ?? input?.name) === undefined
          ? {}
          : { name: (info.name ?? input?.name) as string }),
        parentInfo: {
          sessionId: ctx.session.id,
          turnId: info.turnId,
          toolCallId: info.toolCallId as string,
          depth: scope.depth + 1,
          agent: type,
          ...(input?.name === undefined ? {} : { name: input.name }),
        },
      })
    }
  } catch (error) {
    ctx.log.warn('subagent: could not rebuild the agent directory', { error: errorText(error) })
  }
}

/** `'park'`: the name this (child) session was given by its launcher, read once. */
export function selfNameOf(scope: Scope): Promise<string | undefined> {
  scope.selfName ??= (async () => {
    const parent = scope.ctx.session.parent
    const { options } = scope.env
    if (parent?.toolCallId === undefined || options.parentAgent === undefined) return undefined
    try {
      const session = options
        .parentAgent()
        .peek(parent.sessionId, scope.env.parentPeek(parent.sessionId))
      const inputs = await readLaunchInputs(session, new Set([parent.toolCallId]))
      return inputs.get(parent.toolCallId)?.name
    } catch {
      return undefined
    }
  })()
  return scope.selfName
}

/** `'park'`: the root session of this (child) session, walking the stored parent links. */
export async function rootOf(scope: Scope): Promise<string | undefined> {
  const parent = scope.ctx.session.parent
  if (parent === undefined) return scope.ctx.session.id
  if (parent.depth <= 1) return parent.sessionId
  const { options } = scope.env
  if (options.parentAgent === undefined) return undefined
  let id = parent.sessionId
  try {
    for (let hops = 0; hops < 8; hops++) {
      const up = await options.parentAgent().peek(id, scope.env.parentPeek(id)).parentInfo()
      if (up === undefined) return id
      id = up.sessionId
    }
  } catch {
    return undefined
  }
  return id
}

/** `'park'`: is the child running or waiting for an answer (read from storage)? */
export async function parkStatus(
  scope: Scope,
  entry: AgentEntry,
): Promise<{ status: AgentEntry['status']; waiting: boolean }> {
  const def = scope.defs()[entry.agent]
  if (def === undefined) return { status: entry.status, waiting: false }
  // a read: peek never opens (and so never resumes) the child
  const child = scope.env.peekOf(def.agent, entry.childSessionId, {
    parentSessionId: entry.parentInfo.sessionId,
    agent: entry.agent,
    depth: entry.parentInfo.depth,
  })
  const stats = await child.stats()
  if (stats.activeTurn !== null || stats.pending !== null) {
    entry.status = 'running'
    return { status: 'running', waiting: stats.pending !== null }
  }
  entry.status = await storedOutcome(child)
  return { status: entry.status, waiting: false }
}

/** `'park'`: `agent_stop` asks the child's session to abort, wherever it runs (spec 05 §9.1). */
export async function stopPark(scope: Scope, entry: AgentEntry): Promise<string> {
  const label = entry.name ?? entry.childSessionId
  const def = scope.defs()[entry.agent]
  if (def === undefined) return `ERROR: the agent type "${entry.agent}" is not available.`
  let state: Awaited<ReturnType<typeof parkStatus>>
  try {
    state = await parkStatus(scope, entry)
  } catch (error) {
    return `ERROR: could not read the state of ${label}: ${errorText(error)}`
  }
  if (state.status !== 'running') return `${label} is not running (${entry.status}).`
  if (state.waiting) {
    return `${label} is waiting for an answer to a permission request; it cannot be stopped from here. It continues when the request is answered.`
  }
  try {
    const out = await (
      def.agent.session(entry.childSessionId, scope.env.entryOptions(entry)) as AnySession
    ).abort('stopped')
    if (out.target === 'idle') return `${label} is not running (${entry.status}).`
  } catch (error) {
    return `ERROR: could not stop ${label}: ${errorText(error)}`
  }
  return `Stopped ${label}.${entry.resumable ? ' It can be resumed by sending it a message.' : ''}`
}
