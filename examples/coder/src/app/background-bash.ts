/**
 * Background shells without touching `shell/`: `withBackgroundOption` wraps the bash tool with
 * `run_in_background` / `notify_on`, `createBackgroundBashTools` adds `bash_output` and
 * `kill_shell`. Commands run through the same sandbox as the foreground tool.
 *
 * Wake policy: a finished task and (rate-limited) monitor matches are injected as `eh.event`
 * messages with `{ deliver: 'next-step', wake: true }`. A running turn sees them at its next step
 * boundary; an idle session starts a no-input turn so the agent can react (the integrator's
 * `inject` must drive that run, see `onWake`). A task the user stopped sends nothing.
 */
import { tool } from 'ai'
import type { HarnessContext, HarnessRun, ToolInput } from 'eharness'
import { z } from 'zod/v4'
import { type CoderMessage, type Sandbox, TOOL } from '../contracts.ts'
import { capOutput } from '../shell/index.ts'
import type { TaskInject, TaskManager } from './tasks.ts'

/** Dependencies of the background shell tools. */
export interface BackgroundBashDeps {
  sandbox: Sandbox
  tasks: TaskManager
  /** Delivers an `eh.event` into a session; see {@link TaskInject}. */
  inject: TaskInject
  /** Called with the run an injection with `wake: true` started on an idle session. Drive it like a turn. */
  onWake?: (run: HarnessRun<CoderMessage>) => void
  /** Minimum time between two monitor events. Default 5000 ms. */
  monitorIntervalMs?: number
  /** Cap of one `bash_output` result. Default 30 000 characters. */
  maxOutputChars?: number
}

/** Names of the extra tools. */
export const BASH_OUTPUT_TOOL = 'bash_output'
export const KILL_SHELL_TOOL = 'kill_shell'

const MAX_MATCH_LINES = 40
const MAX_MATCH_CHARS = 4000

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function compile(pattern: string | undefined): RegExp | undefined | { error: string } {
  if (pattern === undefined || pattern === '') return undefined
  try {
    return new RegExp(pattern)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** A started background command. */
export interface BackgroundStart {
  id: string
  message: string
}

/** Create the runner shared by the wrapper and the extra tools. */
function createRunner(deps: BackgroundBashDeps) {
  const interval = deps.monitorIntervalMs ?? 5000

  const notify = (sessionId: string, name: string, text: string, data: unknown): void => {
    void (async () => {
      try {
        const out = await deps.inject(
          sessionId,
          { name, text, data },
          { deliver: 'next-step', wake: true },
        )
        if (out?.run !== undefined) deps.onWake?.(out.run)
      } catch {
        // the session may be closed by now
      }
    })()
  }

  return async function runInBackground(
    command: string,
    description: string | undefined,
    opts: { sessionId: string; notifyOn?: string },
  ): Promise<string> {
    const monitor = compile(opts.notifyOn)
    if (monitor !== undefined && 'error' in monitor && !(monitor instanceof RegExp)) {
      return `ERROR: notify_on is not a valid regular expression: ${monitor.error}`
    }
    const regex = monitor instanceof RegExp ? monitor : undefined

    let proc: Awaited<ReturnType<Sandbox['spawn']>>
    try {
      proc = await deps.sandbox.spawn({ command })
    } catch (error) {
      return `ERROR: could not start the command: ${error instanceof Error ? error.message : String(error)}`
    }
    const label = description?.trim() ? description.trim() : oneLine(command, 80)
    const id = deps.tasks.add({
      kind: 'shell',
      label: `${label}${regex ? ` (monitor ${regex.source})` : ''}`,
      stop: () => {
        void proc.kill()
      },
    })

    // monitor: rate-limited, batched match events
    let pending: string[] = []
    let lastEmit = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (pending.length === 0) return
      let lines = pending
      pending = []
      lastEmit = Date.now()
      const omitted = Math.max(lines.length - MAX_MATCH_LINES, 0)
      lines = lines.slice(0, MAX_MATCH_LINES)
      let body = lines.join('\n')
      if (body.length > MAX_MATCH_CHARS) body = `${body.slice(0, MAX_MATCH_CHARS)}…`
      notify(
        opts.sessionId,
        'task',
        `Background task ${id} (${oneLine(command, 80)}) printed ${lines.length + omitted} line(s) matching /${regex?.source}/:\n${body}${omitted > 0 ? `\n… ${omitted} more` : ''}`,
        { id, kind: 'match' },
      )
    }
    const schedule = (): void => {
      if (timer !== undefined) return
      const wait = Math.max(lastEmit + interval - Date.now(), 0)
      if (wait === 0) flush()
      else {
        timer = setTimeout(flush, wait)
        ;(timer as { unref?: () => void }).unref?.()
      }
    }

    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const dec = new TextDecoder()
      let partial = ''
      const feed = (chunk: string): void => {
        if (chunk === '') return
        deps.tasks.append(id, chunk)
        if (regex === undefined) return
        partial += chunk
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        const hits = lines.filter((l) => regex.test(l))
        if (hits.length > 0) {
          pending.push(...hits)
          schedule()
        }
      }
      try {
        for await (const bytes of stream) feed(dec.decode(bytes, { stream: true }))
        feed(dec.decode())
        if (partial !== '' && regex?.test(partial)) pending.push(partial)
      } catch {
        // torn down by a kill
      }
    }

    void (async () => {
      let exitCode: number | null | undefined
      try {
        const [, , result] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.wait()])
        exitCode = result.exitCode
      } catch {
        exitCode = null
      }
      flush()
      const stopped = deps.tasks.get(id)?.status === 'stopped'
      deps.tasks.complete(id, {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode: exitCode ?? null,
      })
      if (stopped) return
      notify(
        opts.sessionId,
        'task',
        `Background task ${id} (${oneLine(command, 80)}) exited with code ${exitCode ?? 'unknown'}.`,
        { id, kind: 'exit', exitCode: exitCode ?? null },
      )
    })()

    return `Started background task ${id}. Use ${BASH_OUTPUT_TOOL} to read its output.`
  }
}

/** `bash_output` and `kill_shell`, plus the runner for the wrapper. */
export function createBackgroundBashTools(deps: BackgroundBashDeps): {
  tools: Record<string, ToolInput>
  runInBackground(
    command: string,
    description: string | undefined,
    opts: { sessionId: string; notifyOn?: string },
  ): Promise<string>
} {
  const maxChars = deps.maxOutputChars ?? 30_000
  const tools: Record<string, ToolInput> = {
    [BASH_OUTPUT_TOOL]: tool({
      description: `Read the output a background task (bash-N or agent-N) printed since you last read it, with its status and exit code. Optional \`filter\` is a regular expression: only matching lines are returned (the rest is skipped, not kept for later).`,
      inputSchema: z.object({
        id: z.string().describe('Task id, e.g. bash-1'),
        filter: z.string().optional().describe('Regex; only matching lines are returned'),
      }),
      metadata: { risk: 'read' },
      execute: async ({ id, filter }): Promise<string> => {
        const task = deps.tasks.get(id)
        if (task === undefined) {
          const known = deps.tasks.tasks().map((t) => t.id)
          return `ERROR: no background task "${id}".${known.length > 0 ? ` Known: ${known.join(', ')}` : ''}`
        }
        const re = compile(filter)
        if (re !== undefined && !(re instanceof RegExp)) {
          return `ERROR: filter is not a valid regular expression: ${re.error}`
        }
        let text = deps.tasks.readNew(id) ?? ''
        if (re !== undefined) {
          text = text
            .split('\n')
            .filter((l) => re.test(l))
            .join('\n')
        }
        const status =
          task.status === 'running'
            ? 'running'
            : task.exitCode !== undefined
              ? `${task.status}, exit code ${task.exitCode}`
              : task.status
        const body = capOutput(text.trimEnd(), maxChars)
        return `[${id}: ${status}]${body ? `\n${body}` : '\n(no new output)'}`
      },
    }) as unknown as ToolInput,
    [KILL_SHELL_TOOL]: tool({
      description:
        'Stop a running background shell (bash-N). Use it for servers and watchers you started and no longer need.',
      inputSchema: z.object({ id: z.string().describe('Task id, e.g. bash-1') }),
      metadata: { risk: 'write' },
      execute: async ({ id }): Promise<string> => {
        const task = deps.tasks.get(id)
        if (task === undefined || task.kind !== 'shell') {
          return `ERROR: no background shell "${id}".`
        }
        if (task.status !== 'running') return `${id} is not running (${task.status}).`
        await deps.tasks.stopTask(id)
        return `Stopped ${id}.`
      },
    }) as unknown as ToolInput,
  }
  return { tools, runInBackground: createRunner(deps) }
}

const BACKGROUND_NOTE = `

Background mode: set \`run_in_background: true\` to start a long-running command (dev server, watcher, slow test run) and return at once with a task id. Read its output with ${BASH_OUTPUT_TOOL} and stop it with ${KILL_SHELL_TOOL}; you are told when it exits. Add \`notify_on\` (a regex) to be told about each new output line matching it (at most one notification per 5 seconds, batched), e.g. "error|ready in".`

type LooseTool = {
  description?: string
  inputSchema?: unknown
  metadata?: unknown
  execute?: (input: never, options: never) => unknown
} & Record<string, unknown>

/**
 * Wrap the bash tool (a tool or a tool factory) with `run_in_background` and `notify_on`. The
 * foreground behaviour is unchanged. The tool keeps its name and risk, so permission rules for
 * `Bash(...)` apply to background commands too.
 */
export function withBackgroundOption(
  bashToolInput: ToolInput<never>,
  deps: BackgroundBashDeps,
): ToolInput<never> {
  const runner = createRunner(deps)
  return ((ctx: HarnessContext<never>) => {
    const inner = (typeof bashToolInput === 'function'
      ? bashToolInput(ctx)
      : bashToolInput) as unknown as LooseTool
    const base = inner.inputSchema as z.ZodObject
    const innerExecute = inner.execute as (input: unknown, options: unknown) => unknown
    return tool({
      ...(inner as object),
      description: `${inner.description ?? ''}${BACKGROUND_NOTE}`,
      inputSchema: base.extend({
        run_in_background: z
          .boolean()
          .optional()
          .describe('Start the command in the background and return a task id immediately'),
        notify_on: z
          .string()
          .optional()
          .describe('With run_in_background: regex; each new output line matching it is reported'),
      }),
      execute: async (
        input: {
          command: string
          description?: string
          run_in_background?: boolean
          notify_on?: string
        },
        options: unknown,
      ) => {
        if (input.run_in_background !== true) return await innerExecute(input, options)
        return await runner(input.command, input.description, {
          sessionId: ctx.session.id,
          ...(input.notify_on !== undefined ? { notifyOn: input.notify_on } : {}),
        })
      },
    } as never)
  }) as unknown as ToolInput<never>
}

/** Name of the wrapped tool. */
export const BACKGROUND_BASH_NAME: string = TOOL.bash
