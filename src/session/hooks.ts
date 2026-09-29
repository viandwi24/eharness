/**
 * Hook ordering and invocation (internal).
 *
 * Order: plugin order (root plugin `app` first); within one plugin, setup-phase hooks before
 * session-phase hooks.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
import type { HarnessHooks, HookName } from '../plugin/types.ts'
import type { HookEntry } from '../registry/static.ts'

/** A hook function with the plugin that registered it. */
export interface OrderedHook<K extends HookName> {
  owner: string
  fn: NonNullable<HarnessHooks[K]>
}

/** Ordered access to the hooks of a session. */
export interface HookRunner {
  list<K extends HookName>(name: K): Array<OrderedHook<K>>
  has(name: HookName): boolean
}

/** Build the hook runner from hook entries and the plugin order. */
export function createHookRunner(entries: readonly HookEntry[], pluginOrder: string[]): HookRunner {
  const rank = (entry: HookEntry) =>
    pluginOrder.indexOf(entry.owner) * 2 + (entry.phase === 'setup' ? 0 : 1)
  const sorted = [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map((x) => x.entry)
  const cache = new Map<HookName, Array<OrderedHook<HookName>>>()
  const runner: HookRunner = {
    list<K extends HookName>(name: K): Array<OrderedHook<K>> {
      let list = cache.get(name)
      if (list === undefined) {
        list = []
        for (const entry of sorted) {
          const fn = entry.hooks[name]
          if (typeof fn === 'function')
            list.push({ owner: entry.owner, fn } as OrderedHook<HookName>)
        }
        cache.set(name, list)
      }
      return list as Array<OrderedHook<K>>
    },
    has: (name) => runner.list(name).length > 0,
  }
  return runner
}
