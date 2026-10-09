/**
 * Background task registry of one session: output buffers with a read cursor, status and
 * listeners. Pure in-memory state; the plugin owns the processes and reports into it.
 */

/** Output cap per task: older output is dropped from the front. */
export const MAX_TASK_OUTPUT: number = 1024 * 1024
const TAIL_LINES = 12
const TAIL_CHARS = 2000
const NOTIFY_THROTTLE_MS = 100

/** Lifecycle of a background task. */
export type ShellTaskStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** A background shell command (`bash-1`, `bash-2`, …). */
export interface ShellTask {
  id: string
  /** The `description` the model gave, else the command (one line, 80 characters). */
  label: string
  command: string
  status: ShellTaskStatus
  /** `null` when the command was killed by an abort or the exit code is unknown. */
  exitCode?: number | null
  startedAt: number
  endedAt?: number
  /** Last lines of output (for status UIs). */
  tail: string
}

/** The `shellTasks` service: the session's background tasks, for UIs and other plugins. */
export interface ShellTasks {
  /** All tasks of this session, oldest first. */
  list(): ShellTask[]
  get(id: string): ShellTask | undefined
  /** Everything the task printed (capped at 1 MB, newest kept). */
  output(id: string): string
  /** Stop a running task (process group SIGTERM, SIGKILL after 2 s) and mark it `stopped`. */
  stop(id: string): Promise<void>
  /** Stop every running task. */
  stopAll(): Promise<void>
  /** Called with the full list after every change (throttled for output). Returns an unsubscribe. */
  subscribe(listener: (tasks: ShellTask[]) => void): () => void
  /**
   * Move running foreground `bash` calls to the background (Ctrl+B in Claude Code): the call
   * returns to the model at once, the command keeps running as a task. All running foreground
   * calls, or only `toolCallId`. Returns the new task ids (empty when nothing could be moved or
   * `background` is not enabled).
   */
  background(toolCallId?: string): string[]
}

interface Entry {
  task: ShellTask
  stop: () => void | Promise<void>
  buffer: string
  /** Characters ever appended; dropped = total - buffer.length. */
  total: number
  /** Characters already returned by `readNew`. */
  read: number
}

function tailOf(buffer: string): string {
  const lines = buffer.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
  return lines.length > TAIL_CHARS ? lines.slice(lines.length - TAIL_CHARS) : lines
}

/** @internal The registry behind the {@link ShellTasks} service. */
export interface TaskRegistry extends Omit<ShellTasks, 'background'> {
  add(init: { label: string; command: string; stop: () => void | Promise<void> }): string
  append(id: string, text: string): void
  complete(id: string, result: { status: 'completed' | 'failed'; exitCode: number | null }): void
  /** Output since the last `readNew` of this task (what `bash_output` returns). */
  readNew(id: string): string | undefined
  running(): number
}

/** @internal */
export function createTaskRegistry(): TaskRegistry {
  const entries = new Map<string, Entry>()
  const listeners = new Set<(tasks: ShellTask[]) => void>()
  let counter = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): ShellTask[] => [...entries.values()].map((e) => ({ ...e.task }))
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

  const registry: TaskRegistry = {
    add(init) {
      counter++
      const id = `bash-${counter}`
      entries.set(id, {
        task: {
          id,
          label: init.label,
          command: init.command,
          status: 'running',
          startedAt: Date.now(),
          tail: '',
        },
        stop: init.stop,
        buffer: '',
        total: 0,
        read: 0,
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
      e.task.tail = tailOf(e.buffer.slice(-TAIL_CHARS * 2))
      fireSoon()
    },
    complete(id, result) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      e.task.status = result.status
      e.task.endedAt = Date.now()
      e.task.exitCode = result.exitCode
      fire()
    },
    running: () => [...entries.values()].filter((e) => e.task.status === 'running').length,
    list: snapshot,
    get(id) {
      const e = entries.get(id)
      return e === undefined ? undefined : { ...e.task }
    },
    output: (id) => entries.get(id)?.buffer ?? '',
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
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async stop(id) {
      const e = entries.get(id)
      if (e === undefined || e.task.status !== 'running') return
      // mark first: the process's own completion must not overwrite `stopped`
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
      for (const id of [...entries.keys()]) await registry.stop(id)
    },
  }
  return registry
}
