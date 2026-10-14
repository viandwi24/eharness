/**
 * Browser profiles (spec 35 §3): the async store port, a memory adapter, sealing of secret
 * settings with a `SecretVault`, and the public (redacted) view.
 */
import { HarnessError, isRecord, uuidv7 } from '../index.ts'
import type { SecretVault } from '../providers/index.ts'
import { formSpec } from '../providers/index.ts'
import type { BrowserRegistry } from './adapter.ts'
import type { BrowserProfile, PublicBrowserProfile } from './types.ts'

/** What `create` takes. `id` is for wrappers (sealing binds a blob to its id); stores generate one when absent. */
export interface BrowserProfileInput {
  id?: string
  name: string
  adapter: string
  mode: 'manual' | 'managed'
  settings: Record<string, unknown>
  allowDomains?: string[]
  trusted?: boolean
  metadata?: Record<string, unknown>
}

/** What `update` takes: a field that is absent keeps its value; `allowDomains: []` clears the list. */
export interface BrowserProfilePatch {
  name?: string
  settings?: Record<string, unknown>
  allowDomains?: string[]
  trusted?: boolean
  metadata?: Record<string, unknown>
}

/** Result of `update`. */
export type BrowserProfileUpdate =
  | { ok: true; profile: BrowserProfile }
  | { ok: false; reason: 'not-found' | 'conflict' }

/** The storage port of profiles (spec 35 §3). Implementations pass `browserProfileStoreConformance`. */
export interface BrowserProfileStore {
  /** Throws `EH_CONFIG_INVALID` for a name that is taken (case-insensitive). */
  create(input: BrowserProfileInput): Promise<BrowserProfile>
  get(id: string): Promise<BrowserProfile | null>
  /** Oldest first (ids sort by creation time). `cursor` is opaque. */
  list(query?: {
    limit?: number
    cursor?: string
  }): Promise<{ items: BrowserProfile[]; nextCursor?: string }>
  /** `ifUpdatedAt`: only when the stored `updatedAt` still matches. Throws `EH_CONFIG_INVALID` for a taken name. */
  update(
    id: string,
    patch: BrowserProfilePatch,
    ifUpdatedAt?: number,
  ): Promise<BrowserProfileUpdate>
  delete(id: string): Promise<boolean>
}

const nameTaken = (name: string): HarnessError =>
  new HarnessError('EH_CONFIG_INVALID', `A browser profile named "${name}" already exists.`, {
    details: { plugin: 'browser', reason: 'name-taken' },
  })

const fold = (name: string): string => name.trim().toLowerCase()

/** Options of {@link memoryBrowserProfileStore}. */
export interface MemoryBrowserProfileStoreOptions {
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
}

/** A {@link BrowserProfileStore} in memory (tests, single-process apps). Stores copies. */
export function memoryBrowserProfileStore(
  options: MemoryBrowserProfileStoreOptions = {},
): BrowserProfileStore {
  const now = options.now ?? Date.now
  const map = new Map<string, BrowserProfile>()
  const taken = (name: string, except?: string): boolean =>
    [...map.values()].some((p) => p.id !== except && fold(p.name) === fold(name))
  return {
    async create(input) {
      const name = input.name.trim()
      if (name === '') {
        throw new HarnessError('EH_CONFIG_INVALID', 'A browser profile needs a name.', {
          details: { plugin: 'browser', reason: 'name-empty' },
        })
      }
      if (taken(name)) throw nameTaken(name)
      const at = now()
      const profile: BrowserProfile = {
        id: input.id ?? uuidv7(),
        name,
        adapter: input.adapter,
        mode: input.mode,
        settings: structuredClone(input.settings),
        ...(input.allowDomains === undefined || input.allowDomains.length === 0
          ? {}
          : { allowDomains: [...input.allowDomains] }),
        ...(input.trusted === true ? { trusted: true } : {}),
        createdAt: at,
        updatedAt: at,
        ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
      }
      if (map.has(profile.id)) throw nameTaken(profile.name)
      map.set(profile.id, profile)
      return structuredClone(profile)
    },
    async get(id) {
      const p = map.get(id)
      return p === undefined ? null : structuredClone(p)
    },
    async list(query = {}) {
      const all = [...map.values()].sort((a, b) =>
        a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt,
      )
      const start = query.cursor === undefined ? 0 : Math.max(0, Number(query.cursor) || 0)
      const limit = Math.max(1, query.limit ?? all.length)
      const page = all.slice(start, start + limit)
      const next = start + limit
      return {
        items: page.map((p) => structuredClone(p)),
        ...(next < all.length ? { nextCursor: String(next) } : {}),
      }
    },
    async update(id, patch, ifUpdatedAt) {
      const current = map.get(id)
      if (current === undefined) return { ok: false, reason: 'not-found' }
      if (ifUpdatedAt !== undefined && current.updatedAt !== ifUpdatedAt) {
        return { ok: false, reason: 'conflict' }
      }
      if (patch.name !== undefined && taken(patch.name, id)) throw nameTaken(patch.name.trim())
      const next: BrowserProfile = { ...current }
      if (patch.name !== undefined) next.name = patch.name.trim()
      if (patch.settings !== undefined) next.settings = structuredClone(patch.settings)
      if (patch.allowDomains !== undefined) {
        if (patch.allowDomains.length === 0) delete next.allowDomains
        else next.allowDomains = [...patch.allowDomains]
      }
      if (patch.trusted !== undefined) {
        if (patch.trusted) next.trusted = true
        else delete next.trusted
      }
      if (patch.metadata !== undefined) next.metadata = structuredClone(patch.metadata)
      // a change always moves the version, even within the same millisecond
      next.updatedAt = Math.max(now(), current.updatedAt + 1)
      map.set(id, next)
      return { ok: true, profile: structuredClone(next) }
    },
    async delete(id) {
      return map.delete(id)
    },
  }
}

/** Marker key of a sealed value: `{ "~sealed": "<blob>" }` (the same as `sealedProfileStore`). */
const SEALED_KEY = '~sealed'
type Json = Record<string, unknown>
const isSealed = (v: unknown): v is { [SEALED_KEY]: string } =>
  isRecord(v) && typeof v[SEALED_KEY] === 'string'

/** Options of {@link sealedBrowserProfiles}. */
export interface SealedBrowserProfilesOptions {
  store: BrowserProfileStore
  vault: SecretVault
  /** Tells which settings fields are secret (the adapters' schemas). */
  registry: BrowserRegistry
}

function pathGet(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function pathSet(root: Json, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = root
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (!isRecord(next)) return
    cur = next
  }
  cur[parts[parts.length - 1] as string] = value
}

/**
 * A store that encrypts the secret settings (`secret` and `secretValues` fields of the adapter's
 * schema) at rest with a vault. Callers see plain settings; the inner store (a database) only
 * holds ciphertext. A blob is bound to the profile id and the field path, so a row cannot be moved.
 * A profile whose adapter is not registered is stored as it is.
 */
export function sealedBrowserProfiles(options: SealedBrowserProfilesOptions): BrowserProfileStore {
  const { store, vault, registry } = options
  const context = (id: string, path: string): string => `browser-profile:${id}:${path}`
  const secretFields = (p: { adapter: string; mode: 'manual' | 'managed' }): string[] => {
    const schema = registry.get(p.adapter)?.schema(p.mode)
    if (schema === undefined) return []
    return formSpec(schema)
      .fields.filter((f) => f.secret || f.secretValues)
      .map((f) => f.path)
  }
  async function seal(
    p: { id: string; adapter: string; mode: 'manual' | 'managed' },
    settings: Json,
  ): Promise<Json> {
    const out = structuredClone(settings)
    for (const path of secretFields(p)) {
      const value = pathGet(out, path)
      if (value !== undefined && !isSealed(value)) {
        pathSet(out, path, {
          [SEALED_KEY]: await vault.seal(JSON.stringify(value), context(p.id, path)),
        })
      }
    }
    return out
  }
  async function open(p: BrowserProfile): Promise<BrowserProfile> {
    const settings = structuredClone(p.settings)
    for (const path of secretFields(p)) {
      const value = pathGet(settings, path)
      if (isSealed(value)) {
        pathSet(
          settings,
          path,
          JSON.parse(await vault.open(value[SEALED_KEY], context(p.id, path))),
        )
      }
    }
    return { ...p, settings }
  }
  return {
    async create(input) {
      const id = input.id ?? uuidv7()
      const created = await store.create({
        ...input,
        id,
        settings: await seal({ id, adapter: input.adapter, mode: input.mode }, input.settings),
      })
      return open(created)
    },
    async get(id) {
      const p = await store.get(id)
      return p === null ? null : open(p)
    },
    async list(query) {
      const page = await store.list(query)
      return { ...page, items: await Promise.all(page.items.map(open)) }
    },
    async update(id, patch, ifUpdatedAt) {
      let sealed = patch
      if (patch.settings !== undefined) {
        const current = await store.get(id)
        if (current === null) return { ok: false, reason: 'not-found' }
        sealed = { ...patch, settings: await seal(current, patch.settings) }
      }
      const result = await store.update(id, sealed, ifUpdatedAt)
      return result.ok ? { ok: true, profile: await open(result.profile) } : result
    },
    delete: (id) => store.delete(id),
  }
}

/**
 * The profile as sent to a browser: every secret setting is replaced by `{ set, hint? }`, so the
 * result holds no secret and can be serialized or logged. Needs the registry for the schemas.
 */
export function publicProfile(
  registry: BrowserRegistry,
  profile: BrowserProfile,
): PublicBrowserProfile {
  return registry.publicProfile(profile)
}
