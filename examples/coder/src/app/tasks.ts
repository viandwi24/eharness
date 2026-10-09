/**
 * The task list behind `/tasks` and the footer: background shells and background subagents.
 *
 * - Shells are the library's `shellTasks` service (`eharness/shell`), which is per session. A
 *   small plugin on the main agent captures the service of each session it opens.
 * - Background subagents have no service in the library: the `agent` tool answers
 *   `Started background subagent <id> (<type>): <label>.` and its report arrives later as an
 *   `eh.event` message. Both are stored messages, so the list is derived from the parent's stored
 *   messages and the child's stored state (it survives a restart of the UI process).
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import type { ShellTasks } from 'eharness/shell'
import type { BackgroundTask, CoderMessage } from '../contracts.ts'
import type { SessionStorage } from './session-tools.ts'

const POLL_MS = 1000
/** A child that has not written any state yet is still starting for this long. */
const START_GRACE_MS = 8000
const STARTED = /^Started background subagent (\S+) \(([^)]+)\): ([\s\S]*?)\. You will be notified/

/** Dependencies of {@link createTaskHub}. */
export interface TaskHubDeps {
  /** The controller's current session id. */
  session: () => string
  storage: SessionStorage
  /** Stored messages of the current session. */
  messages: () => Promise<CoderMessage[]>
  /** Abort a background subagent (its session id and subagent type). */
  stopAgent: (sessionId: string, agent: string) => Promise<void>
}

export interface TaskHub {
  /** Add it to the MAIN agent's plugins (after `shell()`). */
  plugin: HarnessPlugin<'task-hub'>
  /** Tasks of the current session, oldest first. */
  tasks(): BackgroundTask[]
  stopTask(id: string): Promise<void>
  taskOutput(id: string): string
  onTasks(listener: (tasks: BackgroundTask[]) => void): () => void
  /** Re-read the background subagents (after a turn, or when the session changed). */
  refresh(): Promise<void>
  /** The current session changed: notify the listeners. */
  changed(): void
  close(): void
}

interface AgentTask {
  /** The session that started it. */
  parent: string
  task: BackgroundTask
  sessionId: string
  agent: string
  stopped: boolean
}

const textOfLast = (messages: CoderMessage[]): string => {
  const last = messages.findLast((m) => m.role === 'assistant')
  const parts = last?.parts ?? []
  const from = parts.map((p) => p.type).lastIndexOf('step-start')
  return parts
    .slice(Math.max(from, 0))
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
}

/** Create the hub. */
export function createTaskHub(deps: TaskHubDeps): TaskHub {
  const shells = new Map<string, { service: ShellTasks; off: () => void }>()
  const agents = new Map<string, AgentTask>()
  const listeners = new Set<(tasks: BackgroundTask[]) => void>()
  let timer: ReturnType<typeof setInterval> | undefined

  const shellList = (): BackgroundTask[] =>
    (shells.get(deps.session())?.service.list() ?? []).map(({ command: _c, ...t }) => ({
      ...t,
      kind: 'shell' as const,
    }))
  const mine = (): AgentTask[] => [...agents.values()].filter((a) => a.parent === deps.session())
  const tasks = (): BackgroundTask[] =>
    [...shellList(), ...mine().map((a) => ({ ...a.task }))].sort(
      (a, b) => a.startedAt - b.startedAt,
    )
  const emit = (): void => {
    const list = tasks()
    for (const listener of [...listeners]) {
      try {
        listener(list)
      } catch {
        // a broken listener must not break the producers
      }
    }
  }

  const refresh = async (): Promise<void> => {
    const parent = deps.session()
    let changed = false
    const messages = await deps.messages()
    const finished = new Map<string, 'completed' | 'failed'>()
    for (const m of messages) {
      for (const part of m.parts) {
        const p = part as { type: string; data?: { data?: Record<string, unknown> } }
        const d = p.type === 'data-eh.event' ? p.data?.data : undefined
        if (
          typeof d?.sessionId === 'string' &&
          (d.status === 'completed' || d.status === 'failed')
        ) {
          finished.set(d.sessionId, d.status)
        }
      }
    }
    const children = (await deps.storage.state.get(parent))?.core.children ?? []
    for (const m of messages) {
      for (const part of m.parts) {
        const p = part as { type: string; output?: unknown }
        if (p.type !== 'tool-agent' || typeof p.output !== 'string') continue
        const hit = STARTED.exec(p.output)
        if (hit === null) continue
        const [, sessionId = '', agent = '', label = ''] = hit
        let entry = agents.get(sessionId)
        if (entry === undefined) {
          entry = {
            parent,
            sessionId,
            agent,
            stopped: false,
            task: {
              id: `agent-${[...agents.values()].filter((a) => a.parent === parent).length + 1}`,
              kind: 'agent',
              label: `${agent}: ${label}`,
              status: 'running',
              startedAt: children.find((c) => c.sessionId === sessionId)?.createdAt ?? Date.now(),
              tail: '',
            },
          }
          agents.set(sessionId, entry)
          changed = true
        }
        if (entry.task.status !== 'running') continue
        const state = await deps.storage.state.get(sessionId)
        const report = finished.get(sessionId)
        const childMessages = (await deps.storage.messages.load({ sessionId })) as CoderMessage[]
        const last = childMessages.at(-1)
        // a stored `stop` on the child's last assistant message means its turn ended
        const ended = last?.role === 'assistant' && last.metadata?.eharness?.stop !== undefined
        const running =
          report === undefined &&
          !ended &&
          (state?.core.activeTurn != null || Date.now() - entry.task.startedAt < START_GRACE_MS)
        const tail = textOfLast(childMessages)
        const status = entry.stopped
          ? 'stopped'
          : running
            ? 'running'
            : (report ?? (last?.metadata?.eharness?.stop === 'complete' ? 'completed' : 'failed'))
        if (status !== entry.task.status || tail !== entry.task.tail) {
          entry.task = {
            ...entry.task,
            status,
            tail,
            ...(status === 'running' ? {} : { endedAt: Date.now() }),
          }
          changed = true
        }
      }
    }
    const anyRunning = [...agents.values()].some((a) => a.task.status === 'running')
    if (anyRunning && timer === undefined) {
      timer = setInterval(() => void refresh().catch(() => {}), POLL_MS)
      ;(timer as { unref?: () => void }).unref?.()
    } else if (!anyRunning && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (changed) emit()
  }

  const plugin = definePlugin({
    name: 'task-hub',
    requires: ['shellTasks'],
    setup: () => ({
      hooks: {
        // the service is per session and a reopened session has a new one: always take the latest
        'turn.start': (ctx) => {
          const service = ctx.services.shellTasks
          const id = ctx.session.id
          const known = shells.get(id)
          if (known?.service === service) return
          known?.off()
          shells.set(id, { service, off: service.subscribe(emit) })
          emit()
        },
      },
    }),
  }) as HarnessPlugin<'task-hub'>

  return {
    plugin,
    tasks,
    async stopTask(id) {
      const agent = mine().find((a) => a.task.id === id)
      if (agent !== undefined) {
        if (agent.task.status !== 'running') return
        agent.stopped = true
        agent.task = { ...agent.task, status: 'stopped', endedAt: Date.now() }
        emit()
        await deps.stopAgent(agent.sessionId, agent.agent).catch(() => {})
        return
      }
      await shells.get(deps.session())?.service.stop(id)
    },
    taskOutput(id) {
      const agent = mine().find((a) => a.task.id === id)
      if (agent !== undefined) return agent.task.tail
      return shells.get(deps.session())?.service.output(id) ?? ''
    },
    onTasks(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    changed: emit,
    close() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      for (const { off, service } of shells.values()) {
        off()
        void service.stopAll().catch(() => {})
      }
      shells.clear()
    },
  }
}
