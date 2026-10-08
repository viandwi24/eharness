/**
 * The footer status line: runs the `statusLine.command` setting with the status JSON on stdin and
 * shows the first line of its stdout (ANSI colours allowed). 2 s timeout; the result is cached for
 * 1 s and concurrent calls share one run. Any failure yields `undefined` (no status line).
 *
 * Stdin JSON: `{ session_id, cwd, mode, model: { id }, cost: { total_cost_usd }, context: { used_tokens, window, used_percentage } }`.
 */
import type { PermissionMode } from '../contracts.ts'
import { runHookCommand } from './hooks.ts'

/** What the integrator reports about the running session. */
export interface StatusLineInput {
  sessionId: string
  cwd: string
  mode: PermissionMode
  model: string
  costUsd?: number
  contextTokens: number
  contextWindow: number
}

export interface StatusLineDeps {
  /** The current `statusLine.command` setting (read on every call, so changes apply at once). */
  command(): string | undefined
  input(): Promise<StatusLineInput> | StatusLineInput
  /** Working directory of the command. */
  cwd: string
  /** Default 2000. */
  timeoutMs?: number
  /** Default 1000. */
  cacheMs?: number
  now?(): number
}

export interface StatusLine {
  text(): Promise<string | undefined>
}

/** Keep ANSI escapes (ESC) and drop other control characters. */
function clean(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return line.replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/g, '').trimEnd()
}

export function createStatusLine(deps: StatusLineDeps): StatusLine {
  const now = deps.now ?? Date.now
  let cached: { command: string; at: number; value: string | undefined } | undefined
  let inflight: { command: string; promise: Promise<string | undefined> } | undefined

  const run = async (command: string): Promise<string | undefined> => {
    try {
      const i = await deps.input()
      const result = await runHookCommand(
        command,
        {
          session_id: i.sessionId,
          cwd: i.cwd,
          mode: i.mode,
          model: { id: i.model },
          cost: { total_cost_usd: i.costUsd ?? null },
          context: {
            used_tokens: i.contextTokens,
            window: i.contextWindow,
            used_percentage:
              i.contextWindow > 0 ? Math.round((i.contextTokens / i.contextWindow) * 100) : 0,
          },
        },
        { cwd: deps.cwd, timeoutMs: deps.timeoutMs ?? 2000, env: { CODER_PROJECT_DIR: deps.cwd } },
      )
      if (result.timedOut || result.error !== undefined || result.exitCode !== 0) return undefined
      const line = result.stdout
        .split('\n')
        .map(clean)
        .find((l) => l.trim() !== '')
      return line === undefined ? undefined : line
    } catch {
      return undefined
    }
  }

  return {
    async text() {
      const command = deps.command()?.trim()
      if (command === undefined || command === '') return undefined
      const cacheMs = deps.cacheMs ?? 1000
      if (cached?.command === command && now() - cached.at < cacheMs) return cached.value
      if (inflight?.command === command) return await inflight.promise
      const promise = run(command).then((value) => {
        cached = { command, at: now(), value }
        return value
      })
      inflight = { command, promise }
      try {
        return await promise
      } finally {
        if (inflight?.promise === promise) inflight = undefined
      }
    },
  }
}
