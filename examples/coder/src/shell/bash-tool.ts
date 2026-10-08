/**
 * The `bash` tool: runs a shell command through a {@link Sandbox}, streams its output to the UI as
 * transient `bashOutput` parts and returns a capped, model-readable result string.
 */
import { tool } from 'ai'
import { type DataPartDef, defineDataPart, type HarnessContext, type ToolInput } from 'eharness'
import { z } from 'zod/v4'
import { type Sandbox, TOOL } from '../contracts.ts'
import { SANDBOX_DENIAL, SANDBOX_HINT } from './os-sandbox.ts'

const bashOutputSchema = z.object({
  toolCallId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  chunk: z.string(),
})

/**
 * Transient output chunk of a running command. Register it as the app data part `bashOutput`
 * (`dataParts: { bashOutput: bashOutputPart }`, part type `data-bashOutput`).
 */
export const bashOutputPart: DataPartDef<typeof bashOutputSchema> = defineDataPart({
  schema: bashOutputSchema,
  transient: true,
})

/** Options of {@link createBashTool}. */
export interface BashToolOptions {
  sandbox: Sandbox
  /** Default 120 000 ms. */
  defaultTimeoutMs?: number
  /** Upper bound for the model-chosen timeout. Default 600 000 ms. */
  maxTimeoutMs?: number
  /** Cap of the output returned to the model. Default 30 000 characters (head 10 000 + tail). */
  maxOutputChars?: number
}

const HEAD_CHARS = 10_000

const DESCRIPTION = `Run a shell command in the project root and return its combined output and exit code.

- Commands run in the project root with your user's privileges; use relative paths. Each call is a fresh shell: \`cd\` and exported variables do not persist.
- Prefer the dedicated tools for reading, listing, searching and editing files (read_file, list_files, grep, glob, edit_file, write_file); use bash for builds, tests, git, package managers and other commands.
- Quote paths that contain spaces. Chain dependent commands with && (or ; when failures do not matter).
- No interactive commands (editors, pagers, prompts waiting for input): stdin is closed.
- Long output is truncated to the first and last part. A non-zero exit code is reported, not an error.
- Default timeout 120 s, at most 600 s (timeoutMs); a timed-out command is killed. Set \`description\` to a 5-10 word summary of what the command does.`

/** Cap `text` to `max` characters: head (10 000) + marker + tail (shared with `!command` mode). */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.min(HEAD_CHARS, Math.floor(max / 3))
  const tail = max - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`
}

/**
 * Create the `bash` tool. Returns a tool factory (eharness `ToolsInput` entry) so the tool can
 * write transient output parts through `ctx.stream`. Risk is `external`; permission rules are
 * enforced by the permissions module through `tool.approve`.
 *
 * Expected failures (non-zero exit, timeout, abort, spawn errors) are returned as strings.
 */
export function createBashTool(
  opts: BashToolOptions,
): ToolInput<{ bashOutput: typeof bashOutputPart }> {
  const defaultTimeout = opts.defaultTimeoutMs ?? 120_000
  const maxTimeout = opts.maxTimeoutMs ?? 600_000
  const maxChars = opts.maxOutputChars ?? 30_000

  return (ctx: HarnessContext<{ bashOutput: typeof bashOutputPart }>) =>
    tool({
      description: DESCRIPTION,
      inputSchema: z.object({
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
      }),
      metadata: { risk: 'external' },
      execute: async ({ command, timeoutMs }, { toolCallId, abortSignal }): Promise<string> => {
        const timeout = Math.min(timeoutMs ?? defaultTimeout, maxTimeout)
        const started = Date.now()
        const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1)

        let proc: Awaited<ReturnType<Sandbox['spawn']>>
        try {
          proc = await opts.sandbox.spawn({ command })
        } catch (error) {
          return `ERROR: could not start the command: ${error instanceof Error ? error.message : String(error)}`
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

        let output = ''
        const pump = async (
          stream: ReadableStream<Uint8Array>,
          name: 'stdout' | 'stderr',
        ): Promise<void> => {
          const dec = new TextDecoder()
          const emit = (chunk: string): void => {
            if (!chunk) return
            output += chunk
            if (ctx.stream.active)
              ctx.stream.data('bashOutput', { toolCallId, stream: name, chunk })
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
          if (!aborted && !timedOut) {
            return `ERROR: ${error instanceof Error ? error.message : String(error)}`
          }
        } finally {
          clearTimeout(timer)
          abortSignal?.removeEventListener('abort', onAbort)
        }

        let body = capOutput(output.trimEnd(), maxChars)
        const state = (opts.sandbox as { sandboxState?: () => { enabled: boolean } }).sandboxState
        if (state?.call(opts.sandbox).enabled && SANDBOX_DENIAL.test(output)) {
          body = body ? `${body}\n${SANDBOX_HINT}` : SANDBOX_HINT
        }
        let footer: string
        if (timedOut) footer = `(timed out after ${Math.round(timeout / 1000)}s)`
        else if (aborted) footer = `(aborted after ${seconds()}s)`
        else footer = `Exit code ${exitCode} · ${seconds()}s`
        return body ? `${body}\n${footer}` : footer
      },
    })
}

/** Tool name of the bash tool. */
export const BASH_TOOL_NAME: string = TOOL.bash
