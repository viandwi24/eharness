/**
 * `HarnessContext` objects (one per session and plugin) with live turn/step getters (internal).
 *
 * @see docs/specs/01-agent-and-plugins.md#4-harnesscontext-sessionturnstep-context
 */
import { HarnessError } from '../errors.ts'
import type { HarnessContext, HarnessLogger, HarnessServices } from '../plugin/types.ts'
import { createPluginWriter } from '../stream/writer.ts'
import type { SessionRuntime } from './runtime.ts'

/** Default logger: debug/info are no-ops, warn/error go to the console. */
export const defaultLogger: HarnessLogger = {
  debug() {},
  info() {},
  warn(msg, data) {
    if (data === undefined) console.warn(msg)
    else console.warn(msg, data)
  },
  error(msg, data) {
    if (data === undefined) console.error(msg)
    else console.error(msg, data)
  },
}

/** Services map: accessing a service no plugin provides throws `EH_SERVICE_MISSING`. */
function createServices(rt: SessionRuntime, plugin: string): HarnessServices {
  return new Proxy({} as HarnessServices, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined
      const services = rt.open?.services ?? pendingServices.get(rt)
      if (services?.has(name) === true) return services.get(name)
      if (name === 'then' || name === 'toJSON') return undefined // not a thenable / JSON value
      throw new HarnessError(
        'EH_SERVICE_MISSING',
        `Service '${name}' is not available to plugin '${plugin}': no plugin provides it${rt.agent.services.has(name) ? ' yet (its provider has not opened)' : ''}.`,
        { details: { service: name, plugin } },
      )
    },
    has(_target, name) {
      const services = rt.open?.services ?? pendingServices.get(rt)
      return typeof name === 'string' && services?.has(name) === true
    },
  })
}

/** Services being registered while the session opens (before `rt.open` is set). */
export const pendingServices: WeakMap<SessionRuntime, Map<string, unknown>> = new WeakMap()

/** Create the context object of `plugin` in session `rt`. */
export function createContext(rt: SessionRuntime, plugin: string): HarnessContext {
  const parent = rt.options.parent
  const session = parent === undefined ? { id: rt.id } : { id: rt.id, parent: { ...parent } }
  const services = createServices(rt, plugin)
  const stream = createPluginWriter(rt, plugin)
  const state = rt.state.plugin(plugin)
  return {
    agent: { id: rt.agent.id },
    session,
    plugin: { name: plugin },
    get turn() {
      return rt.turn?.info
    },
    get step() {
      return rt.turn?.step
    },
    services,
    stream,
    state,
    get runtime() {
      return rt.turn?.runtime ?? rt.options.runtime ?? {}
    },
    log: rt.log,
    signal: rt.signal,
  }
}
