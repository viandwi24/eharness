/**
 * The Worker that runs one script in QuickJS (ADR-0065). It owns nothing: the parent
 * (`executor.ts`) sends the prepared JavaScript, the event, the names of the host methods and the
 * limits; every `ctx.*` call becomes a message to the parent and its answer resolves the promise
 * inside QuickJS. The parent terminates this Worker on the wall-time limit, so a script that hangs
 * on a host call cannot outlive its run. Values cross the boundary as JSON text only.
 *
 * Inside QuickJS there is no `fetch`, no timers, no file system, no `process`: only the language,
 * `console` and the frozen `ctx` built from the method list.
 */
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core'
import type { ScriptLimits, ScriptOutcome } from '../../domain/scripts.ts'

export type ToWorker =
  | { type: 'run'; js: string; event: string; methods: string[]; limits: ScriptLimits }
  | { type: 'answer'; id: number; ok: boolean; value?: string; error?: string }

export type FromWorker =
  | { type: 'call'; id: number; method: string; args: string }
  | { type: 'log'; line: string }
  | { type: 'done'; outcome: ScriptOutcome; result?: string; error?: string; cpuMs: number }

declare const self: {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(m: FromWorker): void
}

const quickjs = newQuickJSWASMModuleFromVariant(variant)
const pending = new Map<number, (m: Extract<ToWorker, { type: 'answer' }>) => void>()
let started = false

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'answer') pending.get(m.id)?.(m)
  else if (m.type === 'run' && !started) {
    started = true
    void run(m)
  }
}

const post = (m: FromWorker): void => self.postMessage(m)

/** The prelude that builds `ctx` and `console` from host functions, then removes them from globals. */
const prelude = (methods: string[]): string => `(() => {
  const host = globalThis.__host, log = globalThis.__log, sleep = globalThis.__sleep;
  const text = (v) => { if (typeof v === 'string') return v; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s } catch { return String(v) } };
  const ctx = { log: (...a) => log(a.map(text).join(' ')), sleep: (ms) => sleep(Number(ms) || 0) };
  for (const name of ${JSON.stringify(methods)}) {
    const parts = name.split('.');
    let at = ctx;
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {});
    at[parts[parts.length - 1]] = (input) =>
      host(name, input === undefined ? 'null' : JSON.stringify(input)).then((s) => JSON.parse(s));
  }
  const freeze = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return o };
  globalThis.console = Object.freeze({ log: ctx.log, info: ctx.log, warn: ctx.log, error: ctx.log, debug: ctx.log });
  Object.defineProperty(globalThis, '__ctx', { value: freeze(ctx) });
  delete globalThis.__host; delete globalThis.__log; delete globalThis.__sleep;
})()`

async function run(m: Extract<ToWorker, { type: 'run' }>): Promise<void> {
  const limits = m.limits
  let finished = false
  let cpuUsed = 0
  let segment: number | null = null
  let cpuExceeded = false
  let runtime: QuickJSRuntime | undefined
  let vm: QuickJSContext | undefined

  const enter = (): void => {
    segment = performance.now()
  }
  const leave = (): void => {
    if (segment !== null) cpuUsed += performance.now() - segment
    segment = null
  }
  const finish = (
    outcome: ScriptOutcome,
    extra: { result?: string; error?: string } = {},
  ): void => {
    if (finished) return
    finished = true
    leave()
    post({ type: 'done', outcome, ...extra, cpuMs: Math.round(cpuUsed) })
  }

  /** What a QuickJS error handle says, and which limit (if any) it means. */
  const failure = (handle: QuickJSHandle): { outcome: ScriptOutcome; error: string } => {
    let message: string
    try {
      const e = (vm as QuickJSContext).dump(handle) as { name?: string; message?: string } | string
      message = typeof e === 'string' ? e : `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`
    } catch {
      message = 'the script failed'
    } finally {
      handle.dispose()
    }
    if (cpuExceeded || /interrupted/i.test(message))
      return {
        outcome: 'cpu',
        error: `the script ran longer than ${limits.cpuMs} ms of CPU time (an endless loop?)`,
      }
    if (/out of memory/i.test(message))
      return {
        outcome: 'memory',
        error: `the script used more than ${limits.memoryMb} MB of memory`,
      }
    return { outcome: 'error', error: message }
  }

  try {
    const QuickJS = await quickjs
    runtime = QuickJS.newRuntime()
    runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024)
    runtime.setMaxStackSize(512 * 1024)
    runtime.setInterruptHandler(() => {
      if (segment !== null && cpuUsed + (performance.now() - segment) > limits.cpuMs) {
        cpuExceeded = true
        return true
      }
      return false
    })
    vm = runtime.newContext()
    const ctx = vm
    const rt = runtime

    /** Run the jobs QuickJS has queued (promise callbacks) after a host answer. */
    const pump = (): void => {
      if (finished) return
      enter()
      const r = rt.executePendingJobs()
      leave()
      if (r.error) {
        const f = failure(r.error)
        finish(f.outcome, { error: f.error })
        return
      }
      if (cpuExceeded)
        finish('cpu', {
          error: `the script ran longer than ${limits.cpuMs} ms of CPU time (an endless loop?)`,
        })
    }

    let nextId = 0
    const host = ctx.newFunction('__host', (methodH, argsH) => {
      const method = ctx.getString(methodH)
      const args = ctx.getString(argsH)
      const deferred = ctx.newPromise()
      const id = ++nextId
      pending.set(id, (answer) => {
        pending.delete(id)
        if (finished) return
        if (answer.ok) {
          const v = ctx.newString(answer.value ?? 'null')
          deferred.resolve(v)
          v.dispose()
        } else {
          const err = ctx.newError(answer.error ?? 'the call failed')
          deferred.reject(err)
          err.dispose()
        }
        pump()
      })
      post({ type: 'call', id, method, args })
      return deferred.handle
    })
    const log = ctx.newFunction('__log', (lineH) => {
      post({ type: 'log', line: ctx.getString(lineH) })
    })
    const sleep = ctx.newFunction('__sleep', (msH) => {
      const ms = Math.min(Math.max(0, ctx.getNumber(msH)), 10_000)
      const deferred = ctx.newPromise()
      setTimeout(() => {
        if (finished) return
        deferred.resolve()
        pump()
      }, ms)
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__host', host)
    ctx.setProp(ctx.global, '__log', log)
    ctx.setProp(ctx.global, '__sleep', sleep)
    host.dispose()
    log.dispose()
    sleep.dispose()

    enter()
    const pre = ctx.evalCode(prelude(m.methods), 'prelude.js')
    leave()
    if (pre.error) {
      finish('error', { error: failure(pre.error).error })
      return
    }
    pre.value.dispose()

    enter()
    const mod = ctx.evalCode(m.js, 'script.js', { type: 'module' })
    leave()
    if (mod.error) {
      const f = failure(mod.error)
      finish(f.outcome, { error: f.error })
      return
    }
    // a module with top-level await answers with a promise of its exports; resolvePromise
    // wraps either in Promise.resolve
    const loading = ctx.resolvePromise(mod.value)
    pump()
    if (finished) return
    const loaded = await loading
    mod.value.dispose()
    if (finished) return
    if (loaded.error) {
      const f = failure(loaded.error)
      finish(f.outcome, { error: f.error })
      return
    }
    const exportsH = loaded.value
    const main = ctx.getProp(exportsH, 'default')
    exportsH.dispose()
    if (ctx.typeof(main) !== 'function') {
      main.dispose()
      finish('error', {
        error:
          'the default export is not a function: export default async function (event, ctx) { ... }',
      })
      return
    }
    const parse = ctx.unwrapResult(ctx.evalCode('JSON.parse'))
    const eventText = ctx.newString(m.event)
    const parsed = ctx.callFunction(parse, ctx.undefined, eventText)
    eventText.dispose()
    parse.dispose()
    if (parsed.error) {
      finish('error', { error: failure(parsed.error).error })
      return
    }
    const ctxH = ctx.getProp(ctx.global, '__ctx')

    enter()
    const called = ctx.callFunction(main, ctx.undefined, parsed.value, ctxH)
    leave()
    main.dispose()
    parsed.value.dispose()
    ctxH.dispose()
    if (called.error) {
      const f = failure(called.error)
      finish(f.outcome, { error: f.error })
      return
    }
    // the default export may be async or not: run what is queued, then wait for host answers
    const settling = ctx.resolvePromise(called.value)
    pump()
    if (finished) return
    const settled = await settling
    called.value.dispose()
    if (finished) return
    if (settled.error) {
      const f = failure(settled.error)
      finish(f.outcome, { error: f.error })
      return
    }
    const resultH = settled.value
    let result: string | undefined
    try {
      const value = ctx.dump(resultH)
      result = value === undefined ? undefined : JSON.stringify(value)
    } catch {
      result = undefined
    } finally {
      resultH.dispose()
    }
    finish('ok', result === undefined ? {} : { result })
  } catch (error) {
    finish('error', { error: error instanceof Error ? error.message : String(error) })
  }
}
