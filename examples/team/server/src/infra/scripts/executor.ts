/**
 * Runs one script (ADR-0065): a fresh Worker per run (`worker.ts`, QuickJS inside), the host
 * methods the caller allows answered here, and the limits enforced on both sides — CPU time and
 * memory inside QuickJS, wall time, host-call count and value sizes here. Past the wall time the
 * Worker is terminated, whatever it was doing.
 *
 * The caller decides what each host method may do (grants, rate limits); this module only moves
 * calls and answers. In a dry run the methods marked as side effects are recorded and answered with
 * `{ dryRun: true }` instead of being performed.
 */
import {
  DEFAULT_SCRIPT_LIMITS,
  type HostCallRecord,
  hostMethodProblem,
  type ScriptLimits,
  type ScriptOutcome,
  type ScriptRunResult,
} from '../../domain/scripts.ts'
import { prepareScript } from './prepare.ts'
import type { FromWorker, ToWorker } from './worker.ts'

/** A host method: the parsed argument in, a JSON-able answer out; a throw is the script's error. */
export type HostHandler = (args: unknown) => Promise<unknown>

export interface RunScriptInput {
  /** TypeScript (or JavaScript) source with a default export. */
  source: string
  /** The trigger event (JSON-able). */
  event: unknown
  /** The methods `ctx` offers, by dotted name. */
  host: Readonly<Record<string, HostHandler>>
  limits?: Partial<ScriptLimits>
  /** Methods that change something outside the script: recorded, not called. */
  dryRun?: { sideEffects: ReadonlySet<string> }
}

const WORKER_URL = new URL('./worker.ts', import.meta.url).href
const TRACE_CHARS = 2_000

/** A value as the trace keeps it: as is when small, else a cut JSON preview. */
function traceValue(v: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(v)
  } catch {
    return '[not JSON]'
  }
  if (text === undefined || text.length <= TRACE_CHARS) return v
  return `${text.slice(0, TRACE_CHARS)}… (${text.length} characters)`
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export async function runScript(input: RunScriptInput): Promise<ScriptRunResult> {
  const limits: ScriptLimits = { ...DEFAULT_SCRIPT_LIMITS, ...input.limits }
  for (const name of Object.keys(input.host)) {
    const problem = hostMethodProblem(name)
    // the caller wires the host methods: a bad name is a programmer error, not script input
    if (problem !== undefined || name === 'log' || name === 'sleep')
      throw new Error(problem ?? `"${name}" is built into ctx`)
  }
  const started = performance.now()
  const logs: string[] = []
  const calls: HostCallRecord[] = []
  const done = (
    outcome: ScriptOutcome,
    extra: { result?: unknown; error?: string; cpuMs?: number } = {},
  ): ScriptRunResult => ({
    outcome,
    ...(extra.result === undefined ? {} : { result: extra.result }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    logs,
    calls,
    durationMs: Math.round(performance.now() - started),
    cpuMs: extra.cpuMs ?? 0,
  })

  const prepared = prepareScript(input.source)
  if (!prepared.ok) return done('error', { error: prepared.error })
  let eventText: string
  try {
    eventText = JSON.stringify(input.event ?? null)
  } catch {
    return done('error', { error: 'the event is not JSON' })
  }
  if (eventText.length > limits.maxValueChars)
    return done('error', {
      error: `the event is ${eventText.length} characters; at most ${limits.maxValueChars}`,
    })

  const worker = new Worker(WORKER_URL)
  let logChars = 0
  return await new Promise<ScriptRunResult>((resolve) => {
    let settled = false
    const end = (result: ScriptRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        end(
          done('timeout', {
            error: `the script ran longer than ${limits.wallMs} ms (waiting forever?)`,
          }),
        ),
      limits.wallMs,
    )
    const send = (m: ToWorker): void => {
      if (!settled) worker.postMessage(m)
    }
    const answer = async (id: number, method: string, argsText: string): Promise<void> => {
      if (calls.length >= limits.maxHostCalls) {
        end(done('limit', { error: `the script made more than ${limits.maxHostCalls} ctx calls` }))
        return
      }
      const t0 = performance.now()
      const record: HostCallRecord = { method, args: null, ok: false, ms: 0 }
      calls.push(record)
      const fail = (error: string): void => {
        record.error = error
        record.ms = Math.round(performance.now() - t0)
        send({ type: 'answer', id, ok: false, error })
      }
      if (argsText.length > limits.maxValueChars) {
        fail(
          `the input of ctx.${method} is ${argsText.length} characters; at most ${limits.maxValueChars}`,
        )
        return
      }
      let args: unknown
      try {
        args = JSON.parse(argsText)
      } catch {
        fail(`the input of ctx.${method} is not JSON`)
        return
      }
      record.args = traceValue(args)
      const handler = input.host[method]
      if (handler === undefined) {
        fail(`ctx.${method} is not available to this script`)
        return
      }
      let value: unknown
      if (input.dryRun?.sideEffects.has(method)) {
        record.dryRun = true
        value = { dryRun: true }
      } else {
        try {
          value = await handler(args)
        } catch (error) {
          fail(errorText(error))
          return
        }
      }
      let text: string
      try {
        text = JSON.stringify(value ?? null)
      } catch {
        fail(`ctx.${method} answered something that is not JSON`)
        return
      }
      if (text.length > limits.maxValueChars) {
        fail(
          `the answer of ctx.${method} is ${text.length} characters; at most ${limits.maxValueChars}`,
        )
        return
      }
      record.ok = true
      record.result = traceValue(value)
      record.ms = Math.round(performance.now() - t0)
      send({ type: 'answer', id, ok: true, value: text })
    }

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data
      if (m.type === 'call') void answer(m.id, m.method, m.args)
      else if (m.type === 'log') {
        if (logs.length < limits.maxLogLines && logChars < limits.maxLogChars) {
          const line = m.line.slice(0, limits.maxLogChars - logChars)
          logs.push(line)
          logChars += line.length
        }
      } else if (m.type === 'done') {
        let result: unknown
        if (m.result !== undefined) {
          if (m.result.length > limits.maxValueChars) {
            end(
              done('error', {
                error: `the result is ${m.result.length} characters; at most ${limits.maxValueChars}`,
                cpuMs: m.cpuMs,
              }),
            )
            return
          }
          result = JSON.parse(m.result)
        }
        end(
          done(m.outcome, {
            ...(result === undefined ? {} : { result }),
            ...(m.error === undefined ? {} : { error: m.error }),
            cpuMs: m.cpuMs,
          }),
        )
      }
    }
    worker.onerror = (e: ErrorEvent) =>
      end(done('error', { error: `the script runner failed: ${e.message}` }))
    send({
      type: 'run',
      js: prepared.js,
      event: eventText,
      methods: Object.keys(input.host),
      limits,
    })
  })
}
