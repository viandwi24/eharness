/**
 * The task list behind `/tasks` and the footer: background shells and background subagents.
 *
 * Both are library services of the session (`shellTasks` from `eharness/shell`, `subagentTasks`
 * from `eharness/subagent`), per live session. A small plugin on the main agent captures the
 * services of each session it opens; this module only merges them into one list for the UI.
 */
import { definePlugin, type HarnessPlugin } from 'eharness'
import type { ShellTasks } from 'eharness/shell'
import type { SubagentTasks } from 'eharness/subagent'
import type { BackgroundTask } from '../contracts.ts'

/** Dependencies of {@link createTaskHub}. */
export interface TaskHubDeps {
  /** The controller's current session id. */
  session: () => string
}

export interface TaskHub {
  /** Add it to the MAIN agent's plugins (after `shell()` and `subagents()`). */
  plugin: HarnessPlugin<'task-hub'>
  /** Tasks of the current session, oldest first. */
  tasks(): BackgroundTask[]
  stopTask(id: string): Promise<void>
  /** Move the running foreground bash / agent calls to the background; the new task ids. */
  backgroundRunning(): string[]
  taskOutput(id: string): string
  onTasks(listener: (tasks: BackgroundTask[]) => void): () => void
  /** The current session changed: notify the listeners. */
  changed(): void
  close(): void
}

interface Services {
  shells: ShellTasks
  agents: SubagentTasks
  off: () => void
}

/** Create the hub. */
export function createTaskHub(deps: TaskHubDeps): TaskHub {
  const sessions = new Map<string, Services>()
  const listeners = new Set<(tasks: BackgroundTask[]) => void>()

  const tasks = (): BackgroundTask[] => {
    const services = sessions.get(deps.session())
    if (services === undefined) return []
    const shells = services.shells.list().map(({ command: _c, ...t }) => ({
      ...t,
      kind: 'shell' as const,
    }))
    const agents = services.agents.list().map(
      (t): BackgroundTask => ({
        id: t.id,
        kind: 'agent',
        label: `${t.agent}: ${t.description}`,
        status: t.status,
        startedAt: t.startedAt,
        ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
        tail: t.tail,
      }),
    )
    return [...shells, ...agents].sort((a, b) => a.startedAt - b.startedAt)
  }
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

  const plugin = definePlugin({
    name: 'task-hub',
    requires: ['shellTasks', 'subagentTasks'],
    setup: () => ({
      hooks: {
        // the services are per session and a reopened session has new ones: always take the latest
        'turn.start': (ctx) => {
          const { shellTasks, subagentTasks } = ctx.services
          const id = ctx.session.id
          const known = sessions.get(id)
          if (known?.shells === shellTasks && known.agents === subagentTasks) return
          known?.off()
          const offs = [shellTasks.subscribe(emit), subagentTasks.subscribe(emit)]
          sessions.set(id, {
            shells: shellTasks,
            agents: subagentTasks,
            off: () => {
              for (const off of offs) off()
            },
          })
          emit()
        },
      },
    }),
  }) as HarnessPlugin<'task-hub'>

  return {
    plugin,
    tasks,
    async stopTask(id) {
      const services = sessions.get(deps.session())
      if (services === undefined) return
      if (services.agents.get(id) !== undefined) await services.agents.stop(id)
      else await services.shells.stop(id)
    },
    backgroundRunning() {
      const services = sessions.get(deps.session())
      if (services === undefined) return []
      return [...services.shells.background(), ...services.agents.background()]
    },
    taskOutput(id) {
      const services = sessions.get(deps.session())
      return services?.agents.get(id)?.tail ?? services?.shells.output(id) ?? ''
    },
    onTasks(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    changed: emit,
    close() {
      for (const { off, shells, agents } of sessions.values()) {
        off()
        void shells.stopAll().catch(() => {})
        void agents.stopAll().catch(() => {})
      }
      sessions.clear()
    },
  }
}
