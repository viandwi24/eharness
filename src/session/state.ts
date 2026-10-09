/**
 * Session state: the in-memory `SessionStateSnapshot`, namespaced plugin state with dirty
 * tracking, and serialized writes through the `StateAdapter` (internal).
 *
 * @see docs/specs/05-session-and-storage.md#7-state
 */
import type { JSONValue } from 'ai'
import type { AbortRequest, SessionStateSnapshot, StateAdapter } from '../agent/session-types.ts'
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
  /** The adapter has `setIf` (compare-and-set writes, cross-process abort). */
  readonly canCas: boolean
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
   * Read the stored snapshot without touching the in-memory one (abort poll, spec 05 §9.1).
   * Throws `EH_STORAGE`.
   */
  peek(): Promise<SessionStateSnapshot | null>
  /**
   * Write the snapshot (rev + 1). With `cas` and an adapter that has `setIf`, the write is a
   * compare-and-set on the last read/written rev and resolves `false` on conflict. While a turn
   * guard is set (see {@link StateStore.guard}), every write is a compare-and-set that merges a
   * foreign `core.abortRequest` on conflict and retries; it resolves `false` when the stored
   * state no longer names the guarded turn as active. Throws `EH_STORAGE` when the adapter
   * throws. Writes are serialized.
   */
  write(options?: { cas?: boolean }): Promise<boolean>
  /** Write only when dirty. Resolves like {@link StateStore.write} (`true` when clean). */
  writeIfDirty(): Promise<boolean>
  /**
   * Owner writes of a running turn (spec 05 §9.1): set while turn `turnId` runs (`undefined`
   * clears). `onRequest` is called with an abort request for that turn found by a merge.
   * No effect without `setIf`.
   */
  guard(turnId: string | undefined, onRequest?: (request: AbortRequest) => void): void
  /** Capture the in-memory state (before a turn's preparation). */
  checkpoint(): StateCheckpoint
  /** Discard in-memory changes made after `checkpoint()` (a turn failed before its commit point). */
  restore(checkpoint: StateCheckpoint): void
  /**
   * Put the given plugin keys back to their value at `checkpoint` and keep every other change
   * (a turn failed before its commit point: only what its own hooks set is discarded).
   */
  revert(checkpoint: StateCheckpoint, keys: ReadonlyArray<{ plugin: string; key: string }>): void
  /** Forget unwritten changes (mark clean): another instance owns the stored state. */
  discard(): void
  /** Call `listener` for every plugin state `set`; returns the unsubscribe function. */
  observe(listener: (plugin: string, key: string) => void): () => void
}

/** Opaque in-memory state capture of {@link StateStore.checkpoint}. */
export interface StateCheckpoint {
  readonly snapshot: SessionStateSnapshot
  readonly version: number
}

/** Conflicting owner writes of a guarded turn retried before giving up (spec 05 §9.1). */
const GUARD_RETRIES = 5

function empty(): SessionStateSnapshot {
  return { v: 1, rev: 0, core: {}, plugins: {} }
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Signature of a snapshot without the foreign-writable `core.children` and the rev. */
function signature(snapshot: SessionStateSnapshot): string {
  const { children: _children, ...core } = snapshot.core ?? {}
  return stable([core, snapshot.plugins ?? {}])
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
  /** {@link signature} of the stored snapshot as last read or written by this store. */
  let baseline = signature(empty())
  let loaded = false
  let version = 0
  let writtenVersion = 0
  let lastWriteAt = 0
  let queue: Promise<unknown> = Promise.resolve()
  let turnGuard: { turnId: string; onRequest?: (request: AbortRequest) => void } | undefined

  const pluginViews = new Map<string, PluginState>()
  const listeners = new Set<(plugin: string, key: string) => void>()

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
    get canCas() {
      return adapter.setIf !== undefined
    },
    async peek() {
      try {
        return await adapter.get(sessionId)
      } catch (error) {
        throw storageError('get', error)
      }
    },
    guard(turnId, onRequest) {
      turnGuard = turnId === undefined ? undefined : { turnId, onRequest }
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
      baseline = signature(snapshot)
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
          for (const listener of listeners) listener(name, key)
        },
      }
      pluginViews.set(name, view)
      return view
    },
    write(options = {}) {
      const run = async (): Promise<boolean> => {
        const guarded = options.cas !== true && turnGuard !== undefined
        for (let attempt = 0; ; attempt++) {
          const capturedVersion = version
          const next: SessionStateSnapshot = structuredClone({ ...snapshot, rev: snapshot.rev + 1 })
          try {
            if (adapter.setIf !== undefined) {
              const ok = await adapter.setIf(sessionId, next, persistedRev)
              if (!ok) {
                if (options.cas === true) {
                  // only `core.children` changed (a child registered, spec 05 §13): not a conflict
                  if (attempt < GUARD_RETRIES && (await mergeChildrenOnly())) continue
                  return false
                }
                if (guarded) {
                  if (attempt >= GUARD_RETRIES || !(await mergeForeign())) return false
                  continue
                }
                // another writer changed the state: take over what foreign instances may write
                // (`core.children`, spec 05 §13) and retry; plain `set` as the last resort
                if (attempt < GUARD_RETRIES) {
                  await mergeChildren()
                  continue
                }
                await adapter.set(sessionId, next)
              }
            } else {
              await adapter.set(sessionId, next)
            }
          } catch (error) {
            throw storageError('set', error)
          }
          snapshot.rev = next.rev
          persistedRev = next.rev
          baseline = signature(next)
          writtenVersion = capturedVersion
          lastWriteAt = Date.now()
          return true
        }
      }
      /**
       * A guarded write conflicted: re-read, take over the foreign `core.abortRequest` and
       * `core.children` (the only fields another instance may write during a live turn) and the
       * stored rev. False when the
       * stored state no longer names the guarded turn as active (another instance owns it now).
       */
      const mergeForeign = async (): Promise<boolean> => {
        const guard = turnGuard
        if (guard === undefined) return false
        const stored = await adapter.get(sessionId)
        if (stored === null || stored.core?.activeTurn?.turnId !== guard.turnId) return false
        const request = stored.core.abortRequest
        // a request for another turn is dropped; ours is kept while the snapshot still runs it
        if (
          request !== undefined &&
          request.turnId === guard.turnId &&
          snapshot.core.activeTurn?.turnId === guard.turnId
        ) {
          snapshot.core.abortRequest = structuredClone(request)
          guard.onRequest?.(structuredClone(request))
        } else {
          delete snapshot.core.abortRequest
        }
        takeChildren(stored)
        snapshot.rev = typeof stored.rev === 'number' ? stored.rev : 0
        persistedRev = snapshot.rev
        return true
      }
      /** `core.children` is written by children (foreign-writable): the stored list wins. */
      const takeChildren = (stored: SessionStateSnapshot): void => {
        const children = stored.core?.children
        if (children === undefined) delete snapshot.core.children
        else snapshot.core.children = structuredClone(children)
      }
      /** A compare-and-set conflicted: true when the stored state differs only in `children`. */
      const mergeChildrenOnly = async (): Promise<boolean> => {
        const stored = await adapter.get(sessionId)
        if (stored === null || signature(stored) !== baseline) return false
        // a rev bump without a new child is a real conflict
        if (stable(stored.core?.children ?? null) === stable(snapshot.core.children ?? null)) {
          return false
        }
        takeChildren(stored)
        snapshot.rev = typeof stored.rev === 'number' ? stored.rev : 0
        persistedRev = snapshot.rev
        return true
      }
      /** A plain (unguarded) write conflicted: re-read the stored rev and children. */
      const mergeChildren = async (): Promise<void> => {
        const stored = await adapter.get(sessionId)
        if (stored === null) {
          persistedRev = null
          return
        }
        takeChildren(stored)
        snapshot.rev = typeof stored.rev === 'number' ? stored.rev : 0
        persistedRev = snapshot.rev
      }
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    },
    async writeIfDirty() {
      return store.dirty ? store.write() : true
    },
    checkpoint() {
      return { snapshot: structuredClone(snapshot), version }
    },
    discard() {
      writtenVersion = version
    },
    observe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    revert(checkpoint, keys) {
      if (keys.length === 0) return
      for (const { plugin, key } of keys) {
        store.plugin(plugin).set(key, checkpoint.snapshot.plugins[plugin]?.[key])
      }
      // nothing else changed since the checkpoint: clean again (no spurious state write)
      const same =
        JSON.stringify([snapshot.core, snapshot.plugins]) ===
        JSON.stringify([checkpoint.snapshot.core, checkpoint.snapshot.plugins])
      if (same && writtenVersion <= checkpoint.version) version = checkpoint.version
    },
    restore(checkpoint) {
      const rev = snapshot.rev
      snapshot = structuredClone(checkpoint.snapshot)
      snapshot.rev = rev
      version = checkpoint.version
    },
  }
  return store
}
