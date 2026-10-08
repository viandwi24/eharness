/**
 * Background task manager: the registry behind `/tasks`, `bash_output`, `kill_shell` and the
 * background subagents. Pure in-memory state; the producers (background shells, background
 * agents) own the processes and report into it.
 */
import type { HarnessRun } from 'eharness'
import type { BackgroundTask, CoderMessage } from '../contracts.ts'

/** Output cap per task (older output is dropped from the front). */
export const MAX_TASK_OUTPUT = 1024 * 1024
const TAIL_LINES = 12
const TAIL_CHARS = 2000
const NOTIFY_THROTTLE_MS = 100

/**
 * Injects an `eh.event` into a session (usually `session.inject('eh.event', data, options)` of
 * the live session `sessionId`). Resolves with the wake run when the call started one, so the
 * integrator can drive it (answer its approvals). Producers never await a rejection: failures are
 * swallowed (the session may be closed by the time a background task ends).
 */
export type TaskInject = (
  sessionId: string,
  event: { name: string; text: string; data?: unknown },
  options: { deliver?: 'next-turn' | 'next-step'; wake?: boolean },
) => Promise<{ run?: HarnessRun<CoderMessage> } | undefined>

/** What a producer registers. */
export interface TaskInit {
  kind: BackgroundTask['kind']
  label: string
  /** Stop the underlying work (kill the process group, abort the child). May be async. */
  stop(): void | Promise<void>
}

export interface TaskManager {
  /** Register a running task; ids are `bash-1`, `bash-2`, … and `agent-1`, … */
  add(init: TaskInit): string
  /** Append output (shell stdout/stderr). */
  append(id: string, text: string): void
  /** Patch fields (`tail` for agents, `label`). */
  update(id: string, patch: Partial<Pick<BackgroundTask, 'tail' | 'label'>>): void
  /** Mark the end. A task that was stopped stays `stopped`. */
  complete(id: string, result: { status: 'completed' | 'failed'; exitCode?: number | null }): void
  tasks(): BackgroundTask[]
  get(id: string): BackgroundTask | undefined
  onTasks(listener: (tasks: BackgroundTask[]) => void): () => void
  /** Stop a running task and mark it `stopped`. No-op for unknown or finished tasks. */
  stopTask(id: string): Promise<void>
  /** Everything the task printed (capped at 1 MB, newest kept). */
  taskOutput(id: string): string
  /** Output since the last `readNew` of this task (what `bash_output` returns). */
  readNew(id: string): string | undefined
  /** Stop every running task (session end / process exit). */
  stopAll(): Promise<void>
}

interface Entry {
  task: BackgroundTask
  stop: TaskInit['stop']
  /** Retained output. */
  buffer: string
  /** Total characters ever appended; `dropped = total - buffer.length`. */
  total: number
  /** Total characters already returned by `readNew`. */
  read: number
  tailOverride: boolean
}

function tailOf(buffer: string): string {
  const lines = buffer.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
  return lines.length > TAIL_CHARS ? lines.slice(lines.length - TAIL_CHARS) : lines
}

/** Create an empty task manager. */
export function createTaskManager(): TaskManager {
  const entries = new Map<string, Entry>()
  const counters: Record<string, number> = {}
  const listeners = new Set<(tasks: BackgroundTask[]) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): BackgroundTask[] =>
    [...entries.values()].map((e) => ({ ...e.task, tail: e.task.tail }))
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
  const fireSoon = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(fire, NOTIFY_THROTTLE_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    add(init) {
      const prefix = init.kind === 'shell' ? 'bash' : 'agent'
      counters[prefix] = (counters[prefix] ?? 0) + 1
      const id = `${prefix}-${counters[prefix]}`
      entries.set(id, {
        task: {
          id,
          kind: init.kind,
          label: init.label,
          status: 'running',
          startedAt: Date.now(),
          tail: '',
        },
        stop: init.stop,
        buffer: '',
        total: 0,
        read: 0,
        tailOverride: false,
      })
      fire()
      return id
    },
    append(id, text) {
      const e = entries.get(id)
      if (e === undefined || text === '') return
      e.total += text.length
      e.buffer += text
      if (e.buffer.length > MAX_TASK_OUTPUT) e.buffer = e.buffer.slice(-MAX_TASK_OUTPUT)
      if (!e.tailOverride) e.task.tail = tailOf(e.buffer.slice(-TAIL_CHARS * 2))
      fireSoon()
    },
    update(id, patch) {
      const e = entries.get(id)
      if (e === undefined) return
      if (patch.label !== undefined) e.task.label = patch.label
      if (patch.tail !== undefined) {
        e.task.tail = patch.tail
        e.tailOverride = true
        // an agent's text doubles as its output
        e.buffer = patch.tail
        e.total = Math.max(e.total, patch.tail.length)
        e.read = Math.min(e.read, e.buffer.length)
      }
      fireSoon()
    },
    complete(id, result) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      e.task.status = result.status
      e.task.endedAt = Date.now()
      if (result.exitCode !== undefined) e.task.exitCode = result.exitCode
      fire()
    },
    tasks: snapshot,
    get(id) {
      const e = entries.get(id)
      return e === undefined ? undefined : { ...e.task }
    },
    onTasks(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async stopTask(id) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      // mark first: the producer's own completion (process exit) must not overwrite it
      e.task.status = 'stopped'
      e.task.endedAt = Date.now()
      fire()
      try {
        await e.stop()
      } catch {
        // already gone
      }
    },
    taskOutput(id) {
      return entries.get(id)?.buffer ?? ''
    },
    readNew(id) {
      const e = entries.get(id)
      if (e === undefined) return undefined
      const dropped = e.total - e.buffer.length
      const from = Math.max(e.read - dropped, 0)
      const text = e.buffer.slice(from)
      const lost = Math.max(dropped - e.read, 0)
      e.read = e.total
      return lost > 0 ? `[… ${lost} characters of older output dropped]\n${text}` : text
    },
    async stopAll() {
      for (const id of [...entries.keys()]) await this.stopTask(id)
    },
  }
}
