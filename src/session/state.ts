/**
 * Session state: the in-memory `SessionStateSnapshot`, namespaced plugin state with dirty
 * tracking, and serialized writes through the `StateAdapter` (internal).
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
import type { JSONValue } from 'ai'
import type { SessionStateSnapshot, StateAdapter } from '../agent/session-types.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import type { PluginState } from '../plugin/types.ts'

/** The session state of one live session. */
export interface StateStore {
  /** True after the first successful `load()`. */
  readonly loaded: boolean
  /** True when something changed since the last successful write. */
  readonly dirty: boolean
  /** Epoch ms of the last successful write (0 = never). */
  readonly lastWriteAt: number
  /** (Re)load the snapshot from the adapter. Throws `EH_STORAGE`. */
  load(): Promise<void>
  /** Core state (mutable). Call `markDirty()` after changing it. */
  core(): SessionStateSnapshot['core']
  /** A copy of the current snapshot. */
  snapshot(): SessionStateSnapshot
  markDirty(): void
  /** Namespaced plugin state (`plugins[<name>][key]`). */
  plugin(name: string): PluginState
  /**
   * Write the snapshot (rev + 1). With `cas` and an adapter that has `setIf`, the write is a
   * compare-and-set on the last read/written rev and resolves `false` on conflict. Throws
   * `EH_STORAGE` when the adapter throws. Writes are serialized.
   */
  write(options?: { cas?: boolean }): Promise<boolean>
  /** Write only when dirty. */
  writeIfDirty(): Promise<void>
}

function empty(): SessionStateSnapshot {
  return { v: 1, rev: 0, core: {}, plugins: {} }
}

function storageError(what: string, cause: unknown): HarnessError {
  if (isHarnessError(cause)) return cause
  return new HarnessError('EH_STORAGE', `State storage failed (${what}).`, { cause })
}

/** Create the state store of one session. */
export function createStateStore(adapter: StateAdapter, sessionId: string): StateStore {
  let snapshot = empty()
  /** rev of the stored snapshot (`null` = nothing stored yet). */
  let persistedRev: number | null = null
  let loaded = false
  let version = 0
  let writtenVersion = 0
  let lastWriteAt = 0
  let queue: Promise<unknown> = Promise.resolve()

  const pluginViews = new Map<string, PluginState>()

  const store: StateStore = {
    get loaded() {
      return loaded
    },
    get dirty() {
      return version !== writtenVersion
    },
    get lastWriteAt() {
      return lastWriteAt
    },
    async load() {
      let stored: SessionStateSnapshot | null
      try {
        stored = await adapter.get(sessionId)
      } catch (error) {
        throw storageError('get', error)
      }
      if (stored === null) {
        snapshot = empty()
        persistedRev = null
      } else {
        snapshot = {
          v: 1,
          rev: typeof stored.rev === 'number' ? stored.rev : 0,
          core: typeof stored.core === 'object' && stored.core !== null ? stored.core : {},
          plugins:
            typeof stored.plugins === 'object' && stored.plugins !== null ? stored.plugins : {},
        }
        persistedRev = snapshot.rev
      }
      version = 0
      writtenVersion = 0
      loaded = true
    },
    core: () => snapshot.core,
    snapshot: () => structuredClone(snapshot),
    markDirty() {
      version++
    },
    plugin(name) {
      let view = pluginViews.get(name)
      if (view !== undefined) return view
      view = {
        get<T extends JSONValue = JSONValue>(key: string): T | undefined {
          const value = snapshot.plugins[name]?.[key]
          return value === undefined ? undefined : (structuredClone(value) as T)
        },
        set(key: string, value: JSONValue | undefined): void {
          const namespace = snapshot.plugins[name]
          if (value === undefined) {
            if (namespace === undefined || !(key in namespace)) return
            delete namespace[key]
            if (Object.keys(namespace).length === 0) delete snapshot.plugins[name]
          } else {
            const copy = structuredClone(value)
            if (namespace === undefined) snapshot.plugins[name] = { [key]: copy }
            else namespace[key] = copy
          }
          version++
        },
      }
      pluginViews.set(name, view)
      return view
    },
    write(options = {}) {
      const run = async (): Promise<boolean> => {
        const capturedVersion = version
        const next: SessionStateSnapshot = structuredClone({ ...snapshot, rev: snapshot.rev + 1 })
        try {
          if (options.cas === true && adapter.setIf !== undefined) {
            const ok = await adapter.setIf(sessionId, next, persistedRev)
            if (!ok) return false
          } else {
            await adapter.set(sessionId, next)
          }
        } catch (error) {
          throw storageError('set', error)
        }
        snapshot.rev = next.rev
        persistedRev = next.rev
        writtenVersion = capturedVersion
        lastWriteAt = Date.now()
        return true
      }
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    },
    async writeIfDirty() {
      if (store.dirty) await store.write()
    },
  }
  return store
}
