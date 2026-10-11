/**
 * Bounded hook calls (internal): every plugin hook the core awaits is raced against the turn abort
 * signal and a per-hook timeout, so a hook stuck on a dead socket can never hold a turn, a session
 * lock or `run.result` forever.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
import type { HarnessWarning } from '../errors.ts'
import { errorText } from './util.ts'

/** Default of `config.hooks.timeoutMs`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

/** A hook did not settle within `config.hooks.timeoutMs`; reported as `W_HOOK_TIMEOUT`. */
export class HookTimeoutError extends Error {
  readonly hook: string
  readonly owner: string
  readonly timeoutMs: number
  constructor(hook: string, owner: string, timeoutMs: number) {
    super(`did not finish within ${timeoutMs} ms`)
    this.name = 'HookTimeoutError'
    this.hook = hook
    this.owner = owner
    this.timeoutMs = timeoutMs
  }
}

/** The turn (or session) was aborted while a hook was running; not reported as a warning. */
export class HookAbortedError extends Error {
  constructor(hook: string) {
    super(`aborted while running hook '${hook}'`)
    this.name = 'AbortError'
  }
}

/** Options of {@link runHook}. */
export interface RunHookOptions {
  hook: string
  owner: string
  /** Default {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  timeoutMs?: number | undefined
  /** Aborts the wait (not the hook itself, which cannot be cancelled). */
  signal?: AbortSignal | undefined
}

/** The effective timeout of `config.hooks`. */
export function hookTimeoutOf(config: { hooks?: { timeoutMs?: number | undefined } }): number {
  return config.hooks?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
}

/**
 * Run `call` and settle with its result, or reject with {@link HookTimeoutError} /
 * {@link HookAbortedError} once the timeout elapsed or the signal aborted. A late result or error
 * of the abandoned call is swallowed.
 */
export function runHook<T>(call: () => T | Promise<T>, options: RunHookOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const signal = options.signal
  if (signal?.aborted === true) return Promise.reject(new HookAbortedError(options.hook))
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        cleanup()
        reject(new HookTimeoutError(options.hook, options.owner, timeoutMs))
      }, timeoutMs)
    }
    if (signal !== undefined) {
      onAbort = () => {
        cleanup()
        reject(new HookAbortedError(options.hook))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    let pending: T | Promise<T>
    try {
      pending = call()
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    Promise.resolve(pending).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/**
 * Report a failing hook: `W_HOOK_TIMEOUT` for a hook that did not settle in time, nothing for a
 * wait the turn abort cut short, `W_HOOK_FAILED` otherwise.
 */
export function hookFailed(
  deps: { warn(warning: HarnessWarning, key?: string): void },
  hook: string,
  owner: string,
  error: unknown,
): void {
  if (error instanceof HookAbortedError) return
  const who = owner === 'app' ? 'the app' : `plugin '${owner}'`
  const outcome = hook === 'input.submit' ? 'the input was blocked' : 'it was skipped'
  if (error instanceof HookTimeoutError) {
    deps.warn(
      {
        code: 'W_HOOK_TIMEOUT',
        message: `Hook '${hook}' of ${who} did not finish within ${error.timeoutMs} ms; ${outcome}.`,
        details: { hook, owner, timeoutMs: error.timeoutMs },
      },
      `${owner}:${hook}`,
    )
    return
  }
  deps.warn(
    {
      code: 'W_HOOK_FAILED',
      message: `Hook '${hook}' of ${who} threw; ${outcome}${hook === 'input.submit' ? ' (see the logger for the error).' : `: ${errorText(error)}`}`,
      details: { hook, owner },
    },
    `${owner}:${hook}`,
  )
}
