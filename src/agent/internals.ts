/**
 * Boot-time state of an agent that the runtime (P2+) needs but that is not public API.
 */
import type { WarningEmitter } from '../errors.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { DataPartMap, HarnessPlugin, KindMap } from '../plugin/types.ts'
import type { StaticRegistry } from '../registry/static.ts'
import type { HarnessAgent, HarnessAgentConfig } from './types.ts'

/** Internal state attached to every agent created by `defineHarnessAgent`. */
export interface AgentInternals {
  id: string
  config: HarnessAgentConfig
  /** Plugins in order: the root plugin `app` first, then `config.plugins`. */
  plugins: ReadonlyArray<HarnessPlugin<string, DataPartMap, KindMap>>
  /** Data parts and kinds (core, app, plugins). */
  messages: MessageRegistry
  /** Service name → name of the providing plugin. */
  services: ReadonlyMap<string, string>
  /** Static contributions (root config + plugin setup phases). */
  statics: StaticRegistry
  /** The agent's warning emitter (`config.onWarning` or deduplicated console). */
  emitWarning: WarningEmitter
  /** Message/turn id generator (`config.generateId` or monotonic UUIDv7). */
  generateId: (floor?: string) => string
}

const internals = new WeakMap<object, AgentInternals>()

/** Attach internals to an agent (boot only). */
export function setAgentInternals(agent: object, value: AgentInternals): void {
  internals.set(agent, value)
}

/** Internals of an agent created by `defineHarnessAgent`; throws for foreign objects. */
export function getAgentInternals(agent: HarnessAgent<unknown>): AgentInternals {
  const value = internals.get(agent)
  if (value === undefined) throw new TypeError('Not an agent created by defineHarnessAgent().')
  return value
}
