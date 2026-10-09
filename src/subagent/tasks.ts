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
  /** By task id (`agent-1`) or child session id. */
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
}

const TAIL_CHARS = 2000
const NOTIFY_THROTTLE_MS = 100

/** @internal */
export interface SubagentTaskRegistry extends SubagentTasks {
  add(init: {
    agent: string
    description: string
    childSessionId: string
    stop: () => void | Promise<void>
  }): string
  setTail(id: string, tail: string): void
  complete(id: string, status: 'completed' | 'failed'): void
  /** Whether the task was stopped through `stop()`. */
  stopped(id: string): boolean
}

/** @internal */
export function createSubagentTaskRegistry(options: {
  /** Called by `stop()` for an id that is not a known task. */
  foreign: (childSessionId: string) => Promise<void>
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
    entries.get(id) ?? [...entries.values()].find((e) => e.task.childSessionId === id)

  const registry: SubagentTaskRegistry = {
    add(init) {
      counter++
      const id = `agent-${counter}`
      entries.set(id, {
        task: {
          id,
          agent: init.agent,
          description: init.description,
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
