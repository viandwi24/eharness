/**
 * The `shell()` plugin (spec 19): the `bash` tool (foreground with live output, optional
 * background mode), `bash_output`, `kill_shell`, the transient `data-shell.output` part and the
 * `shellTasks` service.
 *
 * Built only with the public core API (ADR-0008); Node-only (child processes, ADR-0036).
 *
 * @see docs/specs/19-shell-plugin.md
 */
import { type FlexibleSchema, tool } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartDef,
  defineDataPart,
  definePlugin,
  type HarnessContext,
  type HarnessPlugin,
  type InjectOptions,
  type SessionContribution,
  type ToolRisk,
} from '../index.ts'
import { SANDBOX_DENIAL } from './os-sandbox.ts'
import type { Sandbox } from './sandbox-local.ts'
import { createTaskRegistry, type ShellTasks } from './tasks.ts'
import {
  BACKGROUND_NOTE,
  BASH_DESCRIPTION,
  BASH_OUTPUT_DESCRIPTION,
  KILL_SHELL_DESCRIPTION,
  SANDBOX_HINT,
} from './texts.ts'

declare module '../index.ts' {
  interface HarnessServices {
    /** Provided by `shell()`: the background tasks of this session. */
    shellTasks: ShellTasks
  }
}

/** Data of the transient `data-shell.output` part: one chunk of a running foreground command. */
export interface ShellOutputData {
  toolCallId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

const outputSchema: FlexibleSchema<ShellOutputData> = z.object({
  toolCallId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  chunk: z.string(),
})

/** The data parts of the shell plugin. */
export interface ShellDataParts extends Record<string, DataPartDef> {
  output: DataPartDef<FlexibleSchema<ShellOutputData>>
}

/** Name of `bash_output`. */
export const BASH_OUTPUT_TOOL = 'bash_output'
/** Name of `kill_shell`. */
export const KILL_SHELL_TOOL = 'kill_shell'

/** An event of a background task that the model should hear about (spec 19 §5). */
export interface ShellTaskEvent {
  sessionId: string
  taskId: string
  /** `exit`: the task ended on its own. `match`: output lines matched `notify_on`. */
  type: 'exit' | 'match'
  /** `session.inject('eh.event', event.payload, event.options)` delivers it. */
  payload: {
    name: 'task'
    text: string
    data: { id: string; kind: 'exit' | 'match'; exitCode?: number | null }
  }
  options: InjectOptions
}

/** Options of {@link shell}. */
export interface ShellOptions {
  /** The sandbox commands run in, or a factory called once per session. */
  sandbox: Sandbox | ((ctx: HarnessContext) => Sandbox | Promise<Sandbox>)
  /** Default timeout of a foreground command. Default 120 000 ms. */
  timeoutMs?: number
  /** Upper bound for the model-chosen timeout. Default 600 000 ms. */
  maxTimeoutMs?: number
  /** Cap of the output returned to the model (head 10 000 + tail). Default 30 000 characters. */
  maxOutputChars?: number
  /**
   * Background tasks: `run_in_background` / `notify_on` on the tool plus `bash_output` and
   * `kill_shell`. `true` = defaults. Default `false` (foreground only).
   */
  background?:
    | boolean
    | {
        /** Concurrently running background tasks per session. Default 8. */
        maxTasks?: number
        /**
         * How a finished task and monitor matches reach the model: `'wake'` (default) = next step
         * of a running turn, or a new turn when idle; `'next-step'` = only into a running turn
         * (an idle session sees it on its next turn); `false` = never (poll `bash_output`).
         */
        notify?: 'next-step' | 'wake' | false
        /** Minimum time between two `notify_on` events. Default 5000 ms. */
        monitorIntervalMs?: number
      }
  /**
   * Override how a task event reaches the session. Default: the plugin calls
   * `ctx.session.inject('eh.event', e.payload, e.options)` itself (spec 19 §5); with `wake` an idle
   * session starts a turn the application does not drive (listen to `session.events()`).
   */
  onTaskEvent?: (event: ShellTaskEvent) => void | Promise<void>
  /** Name of the command tool. Default `'bash'`. */
  toolName?: string
  /** `metadata.risk` of the command tool. Default `'external'`. */
  risk?: ToolRisk
}

const HEAD_CHARS = 10_000
const MAX_MATCH_LINES = 40
const MAX_MATCH_CHARS = 4000

/** Cap `text` to `max` characters: head (10 000) + marker + tail. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.min(HEAD_CHARS, Math.floor(max / 3))
  const tail = max - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`
}

/** Keeps the head and a rolling tail of an output stream: memory is bounded by the cap. */
class OutputBuffer {
  private head = ''
  private tail = ''
  private total = 0
  private readonly headMax: number
  private readonly tailMax: number
  constructor(private readonly max: number) {
    this.headMax = Math.min(HEAD_CHARS, Math.floor(max / 3))
    this.tailMax = max - this.headMax
  }
  add(chunk: string): void {
    this.total += chunk.length
    let rest = chunk
    if (this.head.length < this.headMax) {
      const take = this.headMax - this.head.length
      this.head += rest.slice(0, take)
      rest = rest.slice(take)
    }
    this.tail += rest
    if (this.tail.length > this.tailMax * 2) this.tail = this.tail.slice(-this.tailMax)
  }
  /** The retained text, equal to `capOutput` of the whole output. */
  text(): string {
    if (this.total <= this.max) return this.head + this.tail
    const tail = this.tail.slice(-this.tailMax)
    const omitted = this.total - this.head.length - tail.length
    return `${this.head}\n… [${omitted} characters omitted] …\n${tail}`
  }
  raw(): string {
    return this.head + this.tail
  }
}

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

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The shell plugin: `bash`, and with `background` also `bash_output` and `kill_shell`.
 *
 * @example
 * ```ts
 * // shell and localSandbox come from the 'eharness/shell' entry point
 * defineHarnessAgent({
 *   model,
 *   plugins: [shell({ sandbox: localSandbox(process.cwd()), background: true })],
 * })
 * ```
 */
export function shell(options: ShellOptions): HarnessPlugin<'shell', ShellDataParts> {
  const defaultTimeout = options.timeoutMs ?? 120_000
  const maxTimeout = Math.max(options.maxTimeoutMs ?? 600_000, defaultTimeout)
  const maxChars = options.maxOutputChars ?? 30_000
  const toolName = options.toolName ?? 'bash'
  const risk = options.risk ?? 'external'
  const bgOpts = typeof options.background === 'object' ? options.background : {}
  const background = options.background !== undefined && options.background !== false
  const maxTasks = bgOpts.maxTasks ?? 8
  const notify = bgOpts.notify ?? 'wake'
  const interval = bgOpts.monitorIntervalMs ?? 5000

  const baseShape = {
    command: z.string().min(1).describe('The shell command to run'),
    description: z
      .string()
      .optional()
      .describe('5-10 word summary of what the command does, shown to the user'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Timeout in milliseconds (default ${defaultTimeout}, max ${maxTimeout})`),
  }
  const inputSchema = background
    ? z.object({
        ...baseShape,
        run_in_background: z
          .boolean()
          .optional()
          .describe('Start the command in the background and return a task id immediately'),
        notify_on: z
          .string()
          .optional()
          .describe('With run_in_background: regex; each new output line matching it is reported'),
      })
    : z.object(baseShape)
  const description =
    BASH_DESCRIPTION.replace(
      '{defaultTimeoutSeconds}',
      String(Math.round(defaultTimeout / 1000)),
    ).replace('{maxTimeoutSeconds}', String(Math.round(maxTimeout / 1000))) +
    (background ? BACKGROUND_NOTE : '')

  return definePlugin({
    name: 'shell',
    provides: ['shellTasks'],
    dataParts: { output: defineDataPart({ schema: outputSchema, transient: true }) },
    session: async (ctx): Promise<SessionContribution<ShellDataParts>> => {
      const sandbox: Sandbox =
        typeof options.sandbox === 'function'
          ? await options.sandbox(ctx as unknown as HarnessContext)
          : options.sandbox
      const registry = createTaskRegistry()
      /** Fallback notices for the next step when the default `ctx.session.inject` fails. */
      const notices: string[] = []

      const deliver = (
        type: 'exit' | 'match',
        taskId: string,
        text: string,
        exitCode?: number | null,
      ): void => {
        if (notify === false) return
        const event: ShellTaskEvent = {
          sessionId: ctx.session.id,
          taskId,
          type,
          payload: {
            name: 'task',
            text,
            data: { id: taskId, kind: type, ...(exitCode !== undefined ? { exitCode } : {}) },
          },
          options:
            notify === 'wake' ? { deliver: 'next-step', wake: true } : { deliver: 'next-step' },
        }
        void (async () => {
          try {
            if (options.onTaskEvent !== undefined) await options.onTaskEvent(event)
            else await ctx.session.inject('eh.event', event.payload, event.options)
          } catch (error) {
            // a closed session or a failed store: the notice still reaches a running turn
            if (options.onTaskEvent === undefined) notices.push(text)
            ctx.log.warn('shell: onTaskEvent failed', { error: errText(error) })
          }
        })()
      }

      async function startBackground(
        command: string,
        label: string | undefined,
        notifyOn: string | undefined,
      ): Promise<string> {
        const monitor = compile(notifyOn)
        if (monitor !== undefined && !(monitor instanceof RegExp)) {
          return `ERROR: notify_on is not a valid regular expression: ${monitor.error}`
        }
        const regex = monitor
        if (registry.running() >= maxTasks) {
          return `ERROR: ${maxTasks} background tasks are already running. Stop one with ${KILL_SHELL_TOOL} first.`
        }
        let proc: Awaited<ReturnType<Sandbox['spawn']>>
        try {
          proc = await sandbox.spawn({ command })
        } catch (error) {
          return `ERROR: could not start the command: ${errText(error)}`
        }
        const name = label?.trim() ? label.trim() : oneLine(command, 80)
        const id = registry.add({
          label: `${name}${regex ? ` (monitor ${regex.source})` : ''}`,
          command,
          stop: () => {
            void proc.kill()
          },
        })

        let pending: string[] = []
        let lastEmit = 0
        let timer: ReturnType<typeof setTimeout> | undefined
        const flush = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          if (pending.length === 0) return
          const all = pending
          pending = []
          lastEmit = Date.now()
          const omitted = Math.max(all.length - MAX_MATCH_LINES, 0)
          let body = all.slice(0, MAX_MATCH_LINES).join('\n')
          if (body.length > MAX_MATCH_CHARS) body = `${body.slice(0, MAX_MATCH_CHARS)}…`
          deliver(
            'match',
            id,
            `Background task ${id} (${oneLine(command, 80)}) printed ${all.length} line(s) matching /${regex?.source}/:\n${body}${omitted > 0 ? `\n… ${omitted} more` : ''}`,
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
            registry.append(id, chunk)
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
          let exitCode: number | null = null
          try {
            const [, , result] = await Promise.all([
              pump(proc.stdout),
              pump(proc.stderr),
              proc.wait(),
            ])
            exitCode = result.exitCode
          } catch {
            exitCode = null
          }
          const stopped = registry.get(id)?.status === 'stopped'
          if (!stopped) flush()
          registry.complete(id, { status: exitCode === 0 ? 'completed' : 'failed', exitCode })
          if (stopped) return
          deliver(
            'exit',
            id,
            `Background task ${id} (${oneLine(command, 80)}) exited with code ${exitCode ?? 'unknown'}.`,
            exitCode,
          )
        })()
        return `Started background task ${id}. Use ${BASH_OUTPUT_TOOL} to read its output.`
      }

      async function runForeground(
        command: string,
        requested: number | undefined,
        toolCallId: string,
        abortSignal: AbortSignal | undefined,
      ): Promise<string> {
        const timeout = Math.min(requested ?? defaultTimeout, maxTimeout)
        const started = Date.now()
        const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1)

        let proc: Awaited<ReturnType<Sandbox['spawn']>>
        try {
          proc = await sandbox.spawn({ command })
        } catch (error) {
          return `ERROR: could not start the command: ${errText(error)}`
        }
        let timedOut = false
        let aborted = false
        const timer = setTimeout(() => {
          timedOut = true
          void proc.kill()
        }, timeout)
        const onAbort = (): void => {
          aborted = true
          void proc.kill()
        }
        if (abortSignal?.aborted) onAbort()
        else abortSignal?.addEventListener('abort', onAbort, { once: true })

        const buffer = new OutputBuffer(maxChars)
        let denial = false
        const pump = async (
          stream: ReadableStream<Uint8Array>,
          name: 'stdout' | 'stderr',
        ): Promise<void> => {
          const dec = new TextDecoder()
          const emit = (chunk: string): void => {
            if (!chunk) return
            buffer.add(chunk)
            if (!denial && SANDBOX_DENIAL.test(chunk)) denial = true
            if (ctx.stream.active) ctx.stream.data('output', { toolCallId, stream: name, chunk })
          }
          try {
            for await (const bytes of stream) emit(dec.decode(bytes, { stream: true }))
            emit(dec.decode())
          } catch {
            // stream torn down by a kill
          }
        }

        let exitCode: number | undefined
        try {
          const [, , result] = await Promise.all([
            pump(proc.stdout, 'stdout'),
            pump(proc.stderr, 'stderr'),
            proc.wait(),
          ])
          exitCode = result.exitCode
        } catch (error) {
          if (!aborted && !timedOut) return `ERROR: ${errText(error)}`
        } finally {
          clearTimeout(timer)
          abortSignal?.removeEventListener('abort', onAbort)
        }

        let body = buffer.text().trimEnd()
        const osState = (sandbox as { state?: () => { enabled: boolean } }).state
        if (typeof osState === 'function' && osState.call(sandbox).enabled && denial) {
          body = body ? `${body}\n${SANDBOX_HINT}` : SANDBOX_HINT
        }
        let footer: string
        if (timedOut) footer = `(timed out after ${Math.round(timeout / 1000)}s)`
        else if (aborted) footer = `(aborted after ${seconds()}s)`
        else footer = `Exit code ${exitCode} · ${seconds()}s`
        return body ? `${body}\n${footer}` : footer
      }

      const tools: Record<string, unknown> = {
        [toolName]: tool({
          description,
          inputSchema,
          metadata: { risk },
          execute: async (
            input: unknown,
            { toolCallId, abortSignal }: { toolCallId: string; abortSignal?: AbortSignal },
          ): Promise<string> => {
            const i = input as {
              command: string
              timeoutMs?: number
              description?: string
              run_in_background?: boolean
              notify_on?: string
            }
            if (background && i.run_in_background === true) {
              return await startBackground(i.command, i.description, i.notify_on)
            }
            return await runForeground(i.command, i.timeoutMs, toolCallId, abortSignal)
          },
        } as never),
      }
      if (background) {
        tools[BASH_OUTPUT_TOOL] = tool({
          description: BASH_OUTPUT_DESCRIPTION,
          inputSchema: z.object({
            id: z.string().describe('Task id, e.g. bash-1'),
            filter: z.string().optional().describe('Regex; only matching lines are returned'),
          }),
          metadata: { risk: 'read' },
          execute: async ({ id, filter }): Promise<string> => {
            const task = registry.get(id)
            if (task === undefined) {
              const known = registry.list().map((t) => t.id)
              return `ERROR: no background task "${id}".${known.length > 0 ? ` Known: ${known.join(', ')}` : ''}`
            }
            const re = compile(filter)
            if (re !== undefined && !(re instanceof RegExp)) {
              return `ERROR: filter is not a valid regular expression: ${re.error}`
            }
            let text = registry.readNew(id) ?? ''
            if (re !== undefined) {
              text = text
                .split('\n')
                .filter((l) => re.test(l))
                .join('\n')
            }
            const status =
              task.status === 'running'
                ? 'running'
                : task.exitCode !== undefined && task.exitCode !== null
                  ? `${task.status}, exit code ${task.exitCode}`
                  : task.status
            const body = capOutput(text.trimEnd(), maxChars)
            return `[${id}: ${status}]${body ? `\n${body}` : '\n(no new output)'}`
          },
        })
        tools[KILL_SHELL_TOOL] = tool({
          description: KILL_SHELL_DESCRIPTION,
          inputSchema: z.object({ id: z.string().describe('Task id, e.g. bash-1') }),
          metadata: { risk: 'write' },
          execute: async ({ id }): Promise<string> => {
            const task = registry.get(id)
            if (task === undefined) return `ERROR: no background shell "${id}".`
            if (task.status !== 'running') return `${id} is not running (${task.status}).`
            await registry.stop(id)
            return `Stopped ${id}.`
          },
        })
      }

      ctx.signal.addEventListener('abort', () => void registry.stopAll(), { once: true })

      return {
        services: {
          shellTasks: {
            list: registry.list,
            get: registry.get,
            output: registry.output,
            stop: registry.stop,
            stopAll: registry.stopAll,
            subscribe: registry.subscribe,
          },
        },
        tools: tools as never,
        hooks: {
          'step.prepare': () => {
            if (notices.length === 0) return undefined
            return { reminder: notices.splice(0).join('\n') }
          },
        },
        dispose: () => registry.stopAll(),
      }
    },
  })
}
