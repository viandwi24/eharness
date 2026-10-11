/**
 * `sealedProfileStore`: encrypt the secrets of ANY profile kind (provider profiles, connections,
 * OAuth credentials) with one {@link SecretVault}, in front of any {@link ProfileStore}.
 *
 * @see docs/specs/23-providers.md#8-sealing-secrets-at-rest-generic
 */
import type { z } from 'zod/v4'
import { isRecord } from '../index.ts'
import { formSpec } from './form.ts'
import type { ConfigProfile, ProfileStore, SecretVault } from './types.ts'

/** Marker key of a sealed value: `{ "~sealed": "<blob>" }`. */
export const SEALED_KEY = '~sealed'

type Json = Record<string, unknown>
const isSealed = (v: unknown): v is { [SEALED_KEY]: string } =>
  isRecord(v) && typeof v[SEALED_KEY] === 'string'

/** Options of {@link sealedProfileStore}. */
export interface SealedProfileStoreOptions {
  /** The store that persists the sealed profiles. */
  inner: ProfileStore
  /** Encrypts and decrypts the sealed fields. */
  vault: SecretVault
  /** Seal only these kinds (default: every kind). Others pass through unchanged. */
  kinds?: readonly string[]
  /**
   * Seal only the secret fields (`secret`, `secretValues`) of the profile's settings, found with
   * the schema this returns (`undefined`: seal the whole settings). Without this option the whole
   * `settings` JSON of a sealed kind is encrypted into one blob, which is the safest default
   * (nothing about the shape leaks) and works for credentials and any schema-less kind.
   */
  schemaOf?: (profile: ConfigProfile) => z.ZodObject | undefined
  /**
   * `list` leaves out a row that cannot be opened (lost key, corrupted blob) and calls this with
   * the row's kind, id and the error, instead of rejecting for every row. `get` still rejects.
   * Never log the value.
   */
  onUnreadable?: (row: { kind: string; id: string; error: unknown }) => void
}

/** A {@link ProfileStore} that seals secrets, plus re-sealing after a key rotation. */
export interface SealedProfileStore extends ProfileStore {
  /** Re-seal every sealed row whose blob was made with an old key. Returns how many were rewritten (unopenable rows are reported to `onUnreadable` when given, else reject). */
  reseal(): Promise<number>
}

const context = (kind: string, id: string): string => `profile:${kind}:${id}`

function pathParts(path: string): string[] {
  return path.split('.')
}

function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const part of pathParts(path)) {
    if (!isRecord(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function setAt(root: Json, path: string, value: unknown): void {
  const parts = pathParts(path)
  let cur = root
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (!isRecord(next)) return
    cur = next
  }
  cur[parts[parts.length - 1] as string] = value
}

/**
 * Wrap a store so secrets are encrypted at rest. `put` seals, `get` / `list` open, so callers
 * (the provider manager, the connector service) see plain settings and the inner store (a
 * database) only ever holds ciphertext. The blob is bound to `(kind, id)`, so a row cannot be
 * moved to another id. `subscribe` is passed through (cross-instance invalidation uses the same
 * shape). A row that cannot be opened (wrong key) makes `get` reject with `EH_CONFIG_INVALID`
 * (`details.reason: 'vault-open'`); `list` rejects too rather than hiding rows, unless `onUnreadable` is given (then the row is skipped and reported).
 *
 * @example
 * ```ts
 * const profiles = sealedProfileStore({ inner: dbProfileStore, vault: webCryptoVault(key) })
 * const manager = createProviderManager({ definitions, store: profiles })
 * ```
 */
export function sealedProfileStore(options: SealedProfileStoreOptions): SealedProfileStore {
  const { inner, vault } = options
  const applies = (kind: string): boolean =>
    options.kinds === undefined || options.kinds.includes(kind)

  async function seal(profile: ConfigProfile): Promise<ConfigProfile> {
    if (!applies(profile.kind)) return profile
    const copy = structuredClone(profile)
    const schema = options.schemaOf?.(profile)
    if (schema === undefined) {
      copy.settings = {
        [SEALED_KEY]: await vault.seal(
          JSON.stringify(profile.settings),
          context(profile.kind, profile.id),
        ),
      }
      return copy
    }
    for (const field of formSpec(schema).fields) {
      const value = getAt(copy.settings, field.path)
      if ((field.secret || field.secretValues) && value !== undefined && !isSealed(value)) {
        setAt(copy.settings, field.path, {
          [SEALED_KEY]: await vault.seal(
            JSON.stringify(value),
            `${context(profile.kind, profile.id)}:${field.path}`,
          ),
        })
      }
    }
    return copy
  }

  async function open(profile: ConfigProfile): Promise<ConfigProfile> {
    if (!applies(profile.kind)) return profile
    const copy = structuredClone(profile)
    if (isSealed(copy.settings)) {
      copy.settings = JSON.parse(
        await vault.open(copy.settings[SEALED_KEY], context(profile.kind, profile.id)),
      ) as Json
      return copy
    }
    const schema = options.schemaOf?.(profile)
    if (schema === undefined) return copy
    for (const field of formSpec(schema).fields) {
      const value = getAt(copy.settings, field.path)
      if (isSealed(value)) {
        setAt(
          copy.settings,
          field.path,
          JSON.parse(
            await vault.open(
              value[SEALED_KEY],
              `${context(profile.kind, profile.id)}:${field.path}`,
            ),
          ),
        )
      }
    }
    return copy
  }

  const blobsOf = (profile: ConfigProfile): string[] => {
    const out: string[] = []
    const walk = (v: unknown): void => {
      if (isSealed(v)) out.push(v[SEALED_KEY])
      else if (isRecord(v)) for (const x of Object.values(v)) walk(x)
    }
    walk(profile.settings)
    return out
  }

  return {
    list: async (query) => {
      const rows = await inner.list(query)
      if (options.onUnreadable === undefined) return Promise.all(rows.map(open))
      const out: ConfigProfile[] = []
      for (const row of rows) {
        try {
          out.push(await open(row))
        } catch (error) {
          options.onUnreadable({ kind: row.kind, id: row.id, error })
        }
      }
      return out
    },
    get: async (kind, id) => {
      const profile = await inner.get(kind, id)
      return profile === undefined ? undefined : open(profile)
    },
    put: async (profile) => inner.put(await seal(profile)),
    delete: (kind, id) => inner.delete(kind, id),
    ...(inner.subscribe === undefined
      ? {}
      : {
          subscribe: (l: () => void) =>
            (inner.subscribe as NonNullable<ProfileStore['subscribe']>)(l),
        }),
    reseal: async () => {
      if (vault.needsReseal === undefined) return 0
      let count = 0
      for (const raw of await inner.list()) {
        if (!applies(raw.kind) || !blobsOf(raw).some((b) => vault.needsReseal?.(b) === true))
          continue
        try {
          await inner.put(await seal(await open(raw)))
          count++
        } catch (error) {
          if (options.onUnreadable === undefined) throw error
          options.onUnreadable({ kind: raw.kind, id: raw.id, error })
        }
      }
      return count
    },
  }
}
