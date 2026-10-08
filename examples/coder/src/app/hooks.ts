/**
 * Settings hooks: user-configured shell commands that run on agent events, mapped onto eharness
 * hooks by {@link hooksPlugin}.
 *
 * | settings event     | eharness hook      | command input (JSON on stdin)                          | effect |
 * |--------------------|--------------------|--------------------------------------------------------|--------|
 * | `PreToolUse`       | `tool.approve`     | `{ event, tool_name, tool_input, session_id, cwd }`    | exit 2 = deny (stderr = reason); stdout JSON `{ decision: 'approve'\|'deny'\|'ask', reason }` |
 * | `PostToolUse`      | `tool.after`       | the same plus `tool_output`                            | stdout JSON `{ additionalContext }` is appended to the output; exit 2 appends stderr |
 * | `UserPromptSubmit` | `input.submit`     | `{ event, prompt, session_id, cwd }`                   | exit 2 = block (stderr); stdout text (or `additionalContext`) becomes added context |
 * | `Stop`             | `turn.beforeEnd`   | `{ event, session_id, cwd, stop_hook_active, last_text }` | exit 2 = keep working, stderr is the reason |
 * | `SubagentStop`     | `turn.beforeEnd`   | same, for child sessions                               | same |
 * | `SessionStart`     | `session.start`    | `{ event, session_id, cwd }`                           | none |
 * | `Notification`     | (integrator)       | `{ event, message, session_id, cwd }`                  | none |
 *
 * `matcher` is a regular expression that must match the WHOLE tool name (`Edit|Write` would be
 * written `edit_file|write_file`; omitted, empty or `*` match every tool). Exit 0 with no output
 * means "no opinion". Any other failure (spawn error, timeout, exit code other than 0 and 2) is a
 * warning through `onNotify`, never an error: a broken hook must not break the agent.
 *
 * Deviation from spec 01 §5: `tool.approve` hooks must be deterministic and free of side effects,
 * but a PreToolUse hook is an arbitrary user command. The decision is therefore computed once per
 * tool call id and cached (a `respond()` continuation re-evaluates `tool.approve`, and must see
 * the same answer without running the command again). Hooks are the user's own configuration;
 * project hooks only load when the project is trusted (`app/config.ts`).
 */
import { spawn } from 'node:child_process'
import type { ToolApprovalStatus } from 'ai'
import { definePlugin, type HarnessUIMessage } from 'eharness'
import type { CoderSettings, HookEvent } from '../contracts.ts'

/** `CoderSettings['hooks']`. */
export type HooksConfig = NonNullable<CoderSettings['hooks']>

/** Options of {@link createHookRunner} and {@link hooksPlugin}. */
export interface HooksOptions {
  hooks: HooksConfig
  /** Project root: the working directory of every command. */
  root: string
  /** Receives warnings (a hook failed or timed out) and `systemMessage` output of hooks. */
  onNotify?(message: string): void
  /** Default 60 000 ms. */
  defaultTimeoutMs?: number
  /** Extra environment for the commands. */
  env?: Record<string, string>
}

/** Outcome of one hook command. */
export interface HookResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Spawn failure. */
  error?: string
}

/** Whether any event has at least one command. */
export function hasHooks(hooks: HooksConfig | undefined): boolean {
  return hooks !== undefined && Object.values(hooks).some((list) => (list?.length ?? 0) > 0)
}

const MAX_CAPTURE = 256 * 1024

/** Run one command with `input` as JSON on stdin. Never rejects. */
export function runHookCommand(
  command: string,
  input: unknown,
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<HookResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: Partial<HookResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ command, exitCode: null, stdout, stderr, timedOut, ...result })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({
        command,
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({})
    }, opts.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8')
    })
    child.on('error', (error) => finish({ error: error.message }))
    child.on('close', (code) => finish({ exitCode: code }))
    child.stdin?.on('error', () => {
      // the command did not read its stdin
    })
    child.stdin?.end(JSON.stringify(input))
  })
}

/** Whole-name regex of a matcher; `undefined` = every tool; an invalid pattern throws. */
function compileMatcher(matcher: string | undefined): RegExp | undefined {
  if (matcher === undefined || matcher === '' || matcher === '*') return undefined
  return new RegExp(`^(?:${matcher})$`)
}

/** The runner behind {@link hooksPlugin}; the integrator also uses it for `Notification`. */
export interface HookRunner {
  readonly options: HooksOptions
  /** Whether any hook is configured for the event (after dropping invalid matchers). */
  has(event: HookEvent): boolean
  /** Run every matching command of the event in parallel. `target` is the tool name for tool events. */
  run(event: HookEvent, payload: Record<string, unknown>, target?: string): Promise<HookResult[]>
  /**
   * Run the `Notification` hooks (the UI needs the user: approval, question, turn done).
   * Fire-and-forget safe; never rejects.
   */
  notification(message: string, sessionId?: string): Promise<void>
}

/** Create the hook runner. Invalid matchers are reported once and their hook is skipped. */
export function createHookRunner(options: HooksOptions): HookRunner {
  const compiled = new Map<
    HookEvent,
    Array<{ matcher: RegExp | undefined; command: string; timeoutMs: number }>
  >()
  const notify = (m: string): void => {
    try {
      options.onNotify?.(m)
    } catch {
      // a broken notifier must not break a hook
    }
  }
  for (const event of Object.keys(options.hooks) as HookEvent[]) {
    const list: Array<{ matcher: RegExp | undefined; command: string; timeoutMs: number }> = []
    for (const entry of options.hooks[event] ?? []) {
      try {
        list.push({
          matcher: compileMatcher(entry.matcher),
          command: entry.command,
          timeoutMs: entry.timeoutMs ?? options.defaultTimeoutMs ?? 60_000,
        })
      } catch {
        notify(`Hook ${event}: invalid matcher "${entry.matcher}" (hook skipped)`)
      }
    }
    if (list.length > 0) compiled.set(event, list)
  }

  const run: HookRunner['run'] = async (event, payload, target) => {
    const entries = (compiled.get(event) ?? []).filter(
      (e) => e.matcher === undefined || (target !== undefined && e.matcher.test(target)),
    )
    const input = { event, cwd: options.root, ...payload }
    const results = await Promise.all(
      entries.map((e) =>
        runHookCommand(e.command, input, {
          cwd: options.root,
          timeoutMs: e.timeoutMs,
          env: {
            CODER_PROJECT_DIR: options.root,
            CODER_HOOK_EVENT: event,
            ...options.env,
          },
        }),
      ),
    )
    for (const r of results) {
      if (r.timedOut) notify(`Hook ${event} timed out: ${r.command}`)
      else if (r.error !== undefined) notify(`Hook ${event} failed to start: ${r.error}`)
      else if (r.exitCode !== 0 && r.exitCode !== 2) {
        notify(
          `Hook ${event} exited with code ${r.exitCode}: ${r.command}${r.stderr.trim() ? ` (${r.stderr.trim().split('\n')[0]})` : ''}`,
        )
      }
      const system = parseJson(r.stdout)?.systemMessage
      if (typeof system === 'string' && system !== '') notify(system)
    }
    return results
  }

  return {
    options,
    has: (event) => compiled.has(event),
    run,
    async notification(message, sessionId) {
      try {
        await run('Notification', {
          message,
          ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        })
      } catch {
        // hooks never throw
      }
    },
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const RESTRICTION = { none: 0, approved: 1, ask: 2, denied: 3 } as const
type Verdict = { kind: keyof typeof RESTRICTION; reason?: string }

/** One PreToolUse result as a verdict. */
function verdictOf(r: HookResult): Verdict {
  if (r.timedOut || r.error !== undefined) return { kind: 'none' }
  if (r.exitCode === 2) {
    return {
      kind: 'denied',
      reason: r.stderr.trim() || `Blocked by a PreToolUse hook: ${r.command}`,
    }
  }
  if (r.exitCode !== 0) return { kind: 'none' }
  const json = parseJson(r.stdout)
  const decision = json?.decision ?? json?.permissionDecision
  const reason = typeof json?.reason === 'string' ? json.reason : undefined
  const withReason = (kind: Verdict['kind']): Verdict =>
    reason === undefined ? { kind } : { kind, reason }
  if (decision === 'approve' || decision === 'allow') return withReason('approved')
  if (decision === 'deny' || decision === 'block') {
    return { kind: 'denied', reason: reason ?? `Denied by a PreToolUse hook: ${r.command}` }
  }
  if (decision === 'ask') return withReason('ask')
  return { kind: 'none' }
}

function promptText(message: HarnessUIMessage): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** Cached PreToolUse decisions are kept for this many tool calls. */
const DECISION_CACHE = 500
/** `Stop` hooks may force the model to continue this many times in a row. */
const MAX_STOP_CONTINUES = 3

/**
 * The `hooks` plugin. Add one instance to every agent (main and subagents): inside child
 * sessions `Stop` hooks run as `SubagentStop` and `SessionStart` does not run. Pass `runner` to
 * share a runner (and the `Notification` entry point) with the integrator.
 */
export function hooksPlugin(
  options: HooksOptions & { runner?: HookRunner },
): ReturnType<typeof definePlugin> {
  const runner = options.runner ?? createHookRunner(options)
  const decisions = new Map<string, Promise<ToolApprovalStatus>>()

  const decide = async (
    sessionId: string,
    toolName: string,
    input: unknown,
  ): Promise<ToolApprovalStatus> => {
    const results = await runner.run(
      'PreToolUse',
      { tool_name: toolName, tool_input: input, session_id: sessionId },
      toolName,
    )
    let best: Verdict = { kind: 'none' }
    for (const r of results) {
      const v = verdictOf(r)
      if (RESTRICTION[v.kind] > RESTRICTION[best.kind]) best = v
    }
    switch (best.kind) {
      case 'denied':
        return { type: 'denied', reason: best.reason }
      case 'ask':
        return best.reason === undefined
          ? { type: 'user-approval' }
          : { type: 'user-approval', reason: best.reason }
      case 'approved':
        return { type: 'approved', ...(best.reason !== undefined ? { reason: best.reason } : {}) }
      default:
        return undefined
    }
  }

  return definePlugin({
    name: 'hooks',
    setup: () => ({
      hooks: {
        'session.start': async (ctx) => {
          if (ctx.session.parent !== undefined || !runner.has('SessionStart')) return
          await runner.run('SessionStart', { session_id: ctx.session.id })
        },
        'input.submit': async (ctx, e) => {
          if (!runner.has('UserPromptSubmit')) return
          const results = await runner.run('UserPromptSubmit', {
            prompt: promptText(e.message),
            session_id: ctx.session.id,
          })
          const context: string[] = []
          for (const r of results) {
            if (r.timedOut || r.error !== undefined) continue
            const json = parseJson(r.stdout)
            if (r.exitCode === 2 || json?.decision === 'block') {
              const reason =
                r.exitCode === 2
                  ? r.stderr.trim()
                  : typeof json?.reason === 'string'
                    ? json.reason
                    : ''
              return { block: { reason: reason || 'Blocked by a UserPromptSubmit hook.' } }
            }
            if (r.exitCode !== 0) continue
            if (json !== undefined) {
              if (
                typeof json.additionalContext === 'string' &&
                json.additionalContext.trim() !== ''
              ) {
                context.push(json.additionalContext.trim())
              }
            } else if (r.stdout.trim() !== '') context.push(r.stdout.trim())
          }
          return context.length > 0 ? { context } : undefined
        },
        'tool.approve': (ctx, e) => {
          if (!runner.has('PreToolUse')) return undefined
          let cached = decisions.get(e.toolCallId)
          if (cached === undefined) {
            cached = decide(ctx.session.id, e.toolName, e.input).catch(() => undefined)
            decisions.set(e.toolCallId, cached)
            if (decisions.size > DECISION_CACHE) {
              const oldest = decisions.keys().next().value
              if (oldest !== undefined) decisions.delete(oldest)
            }
          }
          return cached
        },
        'tool.after': async (ctx, e) => {
          if (!runner.has('PostToolUse') || typeof e.output !== 'string') return undefined
          const results = await runner.run(
            'PostToolUse',
            {
              tool_name: e.toolName,
              tool_input: e.input,
              tool_output: e.output,
              session_id: ctx.session.id,
            },
            e.toolName,
          )
          const extra: string[] = []
          for (const r of results) {
            if (r.timedOut || r.error !== undefined) continue
            if (r.exitCode === 2 && r.stderr.trim() !== '') {
              extra.push(`PostToolUse hook feedback: ${r.stderr.trim()}`)
              continue
            }
            if (r.exitCode !== 0) continue
            const json = parseJson(r.stdout)
            if (typeof json?.additionalContext === 'string' && json.additionalContext !== '') {
              extra.push(json.additionalContext)
            }
          }
          return extra.length > 0 ? { output: `${e.output}\n\n${extra.join('\n')}` } : undefined
        },
        'turn.beforeEnd': async (ctx, e) => {
          if (e.stop !== 'complete') return undefined
          const event: HookEvent = ctx.session.parent !== undefined ? 'SubagentStop' : 'Stop'
          if (!runner.has(event) || e.continues >= MAX_STOP_CONTINUES) return undefined
          const results = await runner.run(event, {
            session_id: ctx.session.id,
            stop_hook_active: e.continues > 0,
            last_text: e.lastText,
          })
          for (const r of results) {
            if (r.timedOut || r.error !== undefined) continue
            const json = parseJson(r.stdout)
            if (r.exitCode === 2) {
              return {
                continue: { reason: r.stderr.trim() || `A ${event} hook asked to continue.` },
              }
            }
            if (r.exitCode === 0 && json?.decision === 'block') {
              return {
                continue: {
                  reason:
                    typeof json.reason === 'string'
                      ? json.reason
                      : `A ${event} hook asked to continue.`,
                },
              }
            }
          }
          return undefined
        },
      },
    }),
  })
}
