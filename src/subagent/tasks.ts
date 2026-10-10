/**
 * Background subagent registry of one session (internal): status, tail and listeners. Pure
 * in-memory state; the plugin owns the child sessions and reports into it.
 *
 * @see docs/specs/20-subagent-plugin.md
 */

/** Lifecycle of a background subagent. */
export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** A background subagent (`agent-1`, `agent-2`, …) started by `run_in_background`. */
export interface SubagentTask {
  /** `agent-<n>`, per session. */
  id: string
  /** Subagent type (a key of the catalog). */
  agent: string
  /** The `description` label the model gave. */
  description: string
  /** The `name` the model gave (addressable with `send_message`), when it gave one. */
  name?: string
  /** The child session that runs it (open it with `agent.session(childSessionId)`). */
  childSessionId: string
  status: SubagentTaskStatus
  startedAt: number
  endedAt?: number
  /** Latest text of the child (last 2 000 characters), or its latest tool call before any text. */
  tail: string
}

/**
 * The `subagentTasks` service: the background subagents this session started, in this process,
 * for UIs and other plugins (like `shellTasks`). It is per process and per live session; the
 * durable record is the `data-subagent.run` part and the `eh.event` report message.
 */
export interface SubagentTasks {
  /** All tasks of this session, oldest first. */
  list(): SubagentTask[]
  /** By task id (`agent-1`), child session id or name. */
  get(id: string): SubagentTask | undefined
  /**
   * Stop a running task (task id or child session id): aborts the child (its turn ends
   * `aborted`) and marks the task `stopped`; the parent is told. An id this process does not know
   * is taken for a child session id and gets `requestAbort()`, which reaches a child running in
   * another instance (spec 05 §9.1).
   */
  stop(id: string): Promise<void>
  /** Stop every running task. */
  stopAll(): Promise<void>
  /** Called with the full list after every change (throttled for tail updates). Returns an unsubscribe. */
  subscribe(listener: (tasks: SubagentTask[]) => void): () => void
  /**
   * Move running foreground `agent` calls to the background (Ctrl+B in Claude Code): each call
   * returns to the model at once, the child keeps running as a task and reports like a
   * `run_in_background` one. All running foreground calls, or only `toolCallId`. Returns the new
   * task ids (empty when nothing could be moved; not available with `approvals: 'park'` or
   * without `background: true`).
   */
  moveToBackground(toolCallId?: string): string[]
  /**
   * Message an agent as the USER (or by id / child session id / name): a running agent gets it as
   * input at its next step (a steer, `source: 'user'`); a finished resumable one is resumed in the
   * background on the same child session (same task id, `running` again) and its report goes to
   * the session that launched it. Never throws: a refusal is `{ ok: false, error }` (unknown agent,
   * stopped by the user, one-shot agent, messaging not available).
   */
  send(
    to: string,
    message: string,
    options?: { from?: 'user' },
  ): Promise<
    { ok: true; status: 'delivered' | 'resumed'; id: string } | { ok: false; error: string }
  >
}

const TAIL_CHARS = 2000
const NOTIFY_THROTTLE_MS = 100

/** @internal */
export interface SubagentTaskRegistry extends SubagentTasks {
  /** Running foreground calls that can be moved to the background, by tool call id. */
  foreground: Map<string, () => string | undefined>
  add(init: {
    /** An existing id to reuse (a task restored after a restart); the counter moves past it. */
    id?: string
    agent: string
    description: string
    name?: string
    childSessionId: string
    stop: () => void | Promise<void>
  }): string
  /** A finished task runs again (a resume): same id, `running`, new stop function. */
  restart(id: string, stop: () => void | Promise<void>): void
  /** Move the id counter past `n` (`agent-<n>` ids that exist in stored history). */
  reserve(n: number): void
  setTail(id: string, tail: string): void
  complete(id: string, status: 'completed' | 'failed'): void
  /** Whether the task was stopped through `stop()`. */
  stopped(id: string): boolean
}

/** @internal */
export function createSubagentTaskRegistry(options: {
  /** Called by `stop()` for an id that is not a known task. */
  foreign: (childSessionId: string) => Promise<void>
  /** Backs `send()`. */
  send: SubagentTasks['send']
}): SubagentTaskRegistry {
  const entries = new Map<string, { task: SubagentTask; stop: () => void | Promise<void> }>()
  const listeners = new Set<(tasks: SubagentTask[]) => void>()
  let counter = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): SubagentTask[] => [...entries.values()].map((e) => ({ ...e.task }))
  const fire = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const list = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(list)
      } catch {
        // a broken listener must not break the producers
      }
    }
  }
  const find = (id: string) =>
    entries.get(id) ??
    [...entries.values()].find((e) => e.task.childSessionId === id || e.task.name === id)

  const registry: SubagentTaskRegistry = {
    add(init) {
      let id = init.id
      if (id === undefined) {
        counter++
        id = `agent-${counter}`
      } else {
        const n = Number(/^agent-(\d+)$/.exec(id)?.[1] ?? 0)
        if (n > counter) counter = n
      }
      entries.set(id, {
        task: {
          id,
          agent: init.agent,
          description: init.description,
          ...(init.name === undefined ? {} : { name: init.name }),
          childSessionId: init.childSessionId,
          status: 'running',
          startedAt: Date.now(),
          tail: '',
        },
        stop: init.stop,
      })
      fire()
      return id
    },
    restart(id, stop) {
      const e = entries.get(id)
      if (e === undefined) return
      e.task.status = 'running'
      e.task.startedAt = Date.now()
      e.task.endedAt = undefined
      delete e.task.endedAt
      e.task.tail = ''
      e.stop = stop
      fire()
    },
    reserve(n) {
      if (n > counter) counter = n
    },
    send: (to, message, opts) => options.send(to, message, opts),
    setTail(id, tail) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      const next = tail.length > TAIL_CHARS ? tail.slice(tail.length - TAIL_CHARS) : tail
      if (next === e.task.tail) return
      e.task.tail = next
      if (timer !== undefined) return
      timer = setTimeout(fire, NOTIFY_THROTTLE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    },
    complete(id, status) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      e.task.status = status
      e.task.endedAt = Date.now()
      fire()
    },
    foreground: new Map(),
    moveToBackground(toolCallId) {
      const ids: string[] = []
      const keys = toolCallId === undefined ? [...registry.foreground.keys()] : [toolCallId]
      for (const key of keys) {
        const id = registry.foreground.get(key)?.()
        if (id !== undefined) ids.push(id)
      }
      return ids
    },
    stopped: (id) => entries.get(id)?.task.status === 'stopped',
    list: snapshot,
    get(id) {
      const e = find(id)
      return e === undefined ? undefined : { ...e.task }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async stop(id) {
      const e = find(id)
      if (e === undefined) {
        await options.foreign(id)
        return
      }
      if (e.task.status !== 'running') return
      // mark first: the child's own completion must not overwrite `stopped`
      e.task.status = 'stopped'
      e.task.endedAt = Date.now()
      fire()
      try {
        await e.stop()
      } catch {
        // already gone
      }
    },
    async stopAll() {
      for (const e of [...entries.values()]) await registry.stop(e.task.id)
    },
  }
  return registry
}
