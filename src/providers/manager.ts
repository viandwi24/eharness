/**
 * The provider manager: profiles + definitions → models, merged model lists, a model catalog for
 * the agent, connection tests and form descriptions.
 *
 * @see docs/specs/23-providers.md#4-the-provider-manager
 */
import type { LanguageModel } from 'ai'
import {
  HarnessError,
  lookupModel,
  type ModelCatalog,
  type ModelInfo,
  modelsDevCatalog,
  openRouterCatalog,
} from '../index.ts'
import {
  type CatalogCache,
  type LoadCatalogOptions,
  loadModelsDev,
  loadOpenRouterModels,
  memoryCatalogCache,
  parseModelsDevModels,
  parseOpenRouterModels,
} from './catalog-loader.ts'
import { fromEnv } from './env.ts'
import {
  formSpec,
  mergeSecretPatch,
  redactProfile,
  scrub,
  secretValuesOf,
  validateSettings,
} from './form.ts'
import { memoryProfileStore } from './store.ts'
import type {
  AnyProviderDefinition,
  ListedModel,
  ModelEntry,
  ModelRef,
  ProfileModels,
  ProfileStore,
  ProviderDescription,
  ProviderInstance,
  ProviderProfile,
  PublicProfile,
  TestResult,
} from './types.ts'

/** Catalog loading options of the manager. */
export interface ManagerCatalogOptions {
  /** Never fetch; use the cache (and `data`) only. */
  offline?: boolean
  /** Default 24 h. */
  ttlMs?: number
  /** Default 3 s. */
  timeoutMs?: number
  modelsDevUrl?: string
  openRouterUrl?: string
  /** Raw catalog JSON supplied by the app (bundled snapshot, tests): used instead of fetching. */
  data?: { modelsDev?: unknown; openRouter?: unknown }
}

/** Options of {@link createProviderManager}. */
export interface ProviderManagerOptions {
  definitions: readonly AnyProviderDefinition[]
  /** Default: a fresh memory store. May also hold profiles of other kinds. */
  store?: ProfileStore
  /** The only network access. Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Where raw catalog JSON is cached. Default: in memory. */
  cache?: CatalogCache
  catalogs?: ManagerCatalogOptions
  /** Environment: profiles from `envMap`, read-only, never persisted (`fromEnv`). */
  env?: Record<string, string | undefined>
  /** Profiles persisted once, when the store has no provider profile yet. */
  seed?: ProviderProfile[]
  now?: () => number
  /** Non-fatal problems (a failed live listing, a failed catalog refresh). Messages carry no secrets. */
  onWarning?: (message: string, details: { profileId?: string }) => void
  /** How long a live model list is reused. Default 5 min. */
  listTtlMs?: number
}

/** Input of {@link ProviderManager.putProfile}. */
export interface ProfileInput {
  /** Existing profile to edit, or the id of a new one (default: the provider id, then `-2`, …). */
  id?: string
  /** Required for a new profile. */
  providerId?: string
  label?: string
  /** A patch: absent fields keep, secrets follow `mergeSecretPatch`. */
  settings?: Record<string, unknown>
  enabled?: boolean
  /** `null` clears the model policy. */
  models?: ProfileModels | null
}

/** The provider manager. */
export interface ProviderManager {
  /** Load (and seed) profiles. Idempotent; `resolve` needs it to have completed. */
  ready(): Promise<void>
  /** Re-read the store. */
  reload(): Promise<void>
  /** Definitions as form specs and the redacted profiles. */
  describe(): Promise<{ providers: ProviderDescription[]; profiles: PublicProfile[] }>
  listProfiles(): Promise<PublicProfile[]>
  getProfile(id: string): Promise<PublicProfile | undefined>
  /** Create or edit a store profile. Env profiles are read-only. */
  putProfile(input: ProfileInput): Promise<PublicProfile>
  deleteProfile(id: string): Promise<void>
  /** `'profile:model'` (first `:` splits) or `{ profile, model }` → model. Sync, cached. */
  resolve(ref: ModelRef): LanguageModel
  /** Merged model list: profile extras > live listing > catalogs. */
  models(
    profileId: string,
    options?: { refresh?: boolean; includeDisabled?: boolean },
  ): Promise<ModelEntry[]>
  /**
   * Load the catalogs the enabled profiles need. `refresh` resolves when a background refresh of
   * stale data finished (the manager then uses the new data).
   */
  loadCatalogs(options?: { refresh?: boolean }): Promise<{ refresh?: Promise<void> }>
  /** A catalog for the agent's `models` option: prices and sizes the models this manager made. */
  catalog(): ModelCatalog
  /** Test a profile's connection. The message never contains a secret. */
  test(profileId: string): Promise<TestResult>
  /** Drop cached models and listings (of one profile, or all). */
  invalidate(profileId?: string): void
  /** Stop listening to the store. */
  dispose(): void
}

/** Split `'profile:model'` on the FIRST `:` (model ids may contain `:` and `/`). */
export function parseModelRef(ref: ModelRef): { profile: string; model: string } {
  if (typeof ref !== 'string') return { profile: ref.profile, model: ref.model }
  const i = ref.indexOf(':')
  if (i <= 0 || i === ref.length - 1) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `Invalid model reference "${ref}": use "profile:model".`,
      {
        details: { reason: 'model-ref-invalid' },
      },
    )
  }
  return { profile: ref.slice(0, i), model: ref.slice(i + 1) }
}

/** `{ profile, model }` → `'profile:model'`. */
export function formatModelRef(profile: string, model: string): string {
  return `${profile}:${model}`
}

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KIND = 'provider'

function fail(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', message, { details: { reason, ...details } })
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function globMatch(pattern: string, id: string): boolean {
  if (!pattern.includes('*')) return pattern === id
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${re}$`).test(id)
}

function allowed(models: ProfileModels | undefined, id: string): boolean {
  if (models === undefined) return true
  if (models.extra?.some((x) => x.id === id))
    return !(models.deny ?? []).some((p) => globMatch(p, id))
  if (models.allow !== undefined && !models.allow.some((p) => globMatch(p, id))) return false
  return !(models.deny ?? []).some((p) => globMatch(p, id))
}

const nonEmpty = (info: ModelInfo | undefined): ModelInfo | undefined =>
  info !== undefined && Object.keys(info).length > 0 ? info : undefined

function mergeInfo(...parts: Array<ModelInfo | undefined>): ModelInfo | undefined {
  const out: ModelInfo = {}
  for (const part of parts) if (part !== undefined) Object.assign(out, part)
  return nonEmpty(out)
}

interface Built {
  key: string
  instance: ProviderInstance
  models: Map<string, LanguageModel>
}

type Source = 'modelsDev' | 'openRouter'

/**
 * Create a {@link ProviderManager}.
 *
 * @example
 * ```ts
 * const providers = createProviderManager({
 *   definitions: [openRouterProvider({ createOpenRouter }), gatewayProvider({})],
 *   store: memoryProfileStore(),
 *   env: process.env,
 * })
 * await providers.ready()
 * await providers.loadCatalogs()
 * const agent = defineHarnessAgent({
 *   model: providers.resolve('openrouter:anthropic/claude-sonnet-4.6'),
 *   models: providers.catalog(),
 * })
 * ```
 */
export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  const defs = new Map<string, AnyProviderDefinition>()
  for (const def of options.definitions) {
    if (defs.has(def.id))
      throw fail('duplicate-provider', `Duplicate provider definition "${def.id}".`)
    defs.set(def.id, def)
  }
  const store = options.store ?? memoryProfileStore()
  const doFetch: typeof fetch =
    options.fetch ?? (((...args) => globalThis.fetch(...args)) as typeof fetch)
  const cache = options.cache ?? memoryCatalogCache()
  const now = options.now ?? Date.now
  const listTtl = options.listTtlMs ?? 5 * 60 * 1000
  const cat = options.catalogs ?? {}
  const warn = (message: string, details: { profileId?: string } = {}): void => {
    try {
      options.onWarning?.(message, details)
    } catch {
      // ignore
    }
  }

  let snapshot: Map<string, ProviderProfile> | undefined
  let readyPromise: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined
  const built = new Map<string, Built>()
  const live = new Map<string, { key: string; at: number; models: ListedModel[] }>()
  const objectRefs = new WeakMap<object, { profileId: string; modelId: string }>()
  const stringRefs = new Map<string, { profileId: string; modelId: string }>()
  const raw: Partial<Record<Source, unknown>> = { ...cat.data }
  const records: Partial<Record<Source, Record<string, ModelInfo>>> = {}
  const inflight = new Map<Source, Promise<{ refresh?: Promise<void> }>>()
  let fallback: Record<string, ModelInfo> | undefined

  const env =
    options.env === undefined
      ? []
      : (fromEnv(options.definitions, options.env, { now }) as ProviderProfile[])

  // Loads can overlap (a store change notification while another change is being written): only
  // the newest one may replace the snapshot, an older read would bring back stale profiles.
  let loadSeq = 0
  let latestLoad: Promise<void> = Promise.resolve()
  function load(): Promise<void> {
    const seq = ++loadSeq
    latestLoad = readAndApply(seq)
    return latestLoad
  }

  async function readAndApply(seq: number): Promise<void> {
    const rows = (await store.list({ kind: KIND })).filter(
      (p): p is ProviderProfile => p.kind === KIND,
    )
    if (rows.length === 0 && options.seed !== undefined && options.seed.length > 0) {
      for (const p of options.seed) {
        const row: ProviderProfile = { ...structuredClone(p), kind: KIND, source: 'store' }
        await store.put(row)
        rows.push(row)
      }
    }
    if (seq !== loadSeq) return latestLoad
    const next = new Map<string, ProviderProfile>()
    for (const p of rows) next.set(p.id, p)
    for (const p of env) next.set(p.id, p)
    snapshot = next
    for (const id of [...built.keys()]) {
      const p = next.get(id)
      if (p === undefined || built.get(id)?.key !== stable(p.settings)) built.delete(id)
    }
    for (const id of [...live.keys()]) if (!next.has(id)) live.delete(id)
  }

  function ready(): Promise<void> {
    readyPromise ??= load().then(() => {
      if (store.subscribe !== undefined) {
        unsubscribe = store.subscribe(() => {
          load().catch((e) => warn(`Reloading profiles failed: ${String(e)}`))
        })
      }
    })
    readyPromise.catch(() => {
      readyPromise = undefined
    })
    return readyPromise
  }

  function profiles(): Map<string, ProviderProfile> {
    if (snapshot === undefined) {
      throw fail('not-ready', 'Provider profiles are not loaded: await manager.ready() first.')
    }
    return snapshot
  }

  function profileOf(id: string): ProviderProfile {
    const p = profiles().get(id)
    if (p === undefined)
      throw fail('profile-not-found', `Unknown provider profile "${id}".`, { profileId: id })
    return p
  }

  function defOf(profile: ProviderProfile): AnyProviderDefinition {
    const def = defs.get(profile.definitionId)
    if (def === undefined) {
      throw fail(
        'unknown-provider',
        `Profile "${profile.id}" uses unknown provider "${profile.definitionId}".`,
        {
          profileId: profile.id,
          providerId: profile.definitionId,
        },
      )
    }
    return def
  }

  function build(profile: ProviderProfile, def: AnyProviderDefinition): Built {
    const key = stable(profile.settings)
    const hit = built.get(profile.id)
    if (hit !== undefined && hit.key === key) return hit
    const settings = validateSettings(
      def.settings,
      profile.settings,
      `settings of profile "${profile.id}" (${def.id})`,
    )
    let instance: ProviderInstance
    try {
      instance = def.create(settings)
    } catch (error) {
      const secrets = secretValuesOf(def.settings, profile.settings)
      throw fail(
        'create-failed',
        `Provider "${def.id}" could not be created: ${scrub(String(error), secrets)}`,
        {
          profileId: profile.id,
        },
      )
    }
    const entry: Built = { key, instance, models: new Map() }
    built.set(profile.id, entry)
    return entry
  }

  function resolve(ref: ModelRef): LanguageModel {
    const { profile: pid, model: mid } = parseModelRef(ref)
    const profile = profileOf(pid)
    if (!profile.enabled)
      throw fail('profile-disabled', `Provider profile "${pid}" is disabled.`, { profileId: pid })
    if (!allowed(profile.models, mid)) {
      throw fail('model-not-allowed', `Model "${mid}" is not allowed by profile "${pid}".`, {
        profileId: pid,
      })
    }
    const entry = build(profile, defOf(profile))
    let model = entry.models.get(mid)
    if (model === undefined) {
      model = entry.instance.languageModel(mid)
      entry.models.set(mid, model)
    }
    const info = { profileId: pid, modelId: mid }
    if (typeof model === 'string') stringRefs.set(model, info)
    else objectRefs.set(model as object, info)
    return model
  }

  function setSource(source: Source, data: unknown): void {
    raw[source] = data
    fallback = undefined
    records[source] = undefined
  }

  function recordOf(source: Source): Record<string, ModelInfo> | undefined {
    if (raw[source] === undefined) return undefined
    records[source] ??=
      source === 'openRouter' ? openRouterCatalog(raw.openRouter) : modelsDevCatalog(raw.modelsDev)
    return records[source]
  }

  function sourcesOf(def: AnyProviderDefinition): Source[] {
    const out: Source[] = []
    if (def.catalog?.kind === 'openrouter') out.push('openRouter')
    if (def.catalog?.modelsDevKey !== undefined) out.push('modelsDev')
    return out
  }

  function ensureSource(source: Source, force: boolean): Promise<{ refresh?: Promise<void> }> {
    if (cat.data?.[source] !== undefined) return Promise.resolve({})
    if (raw[source] !== undefined && !force) return Promise.resolve({})
    const pending = inflight.get(source)
    if (pending !== undefined) return pending
    const opts: LoadCatalogOptions = {
      fetch: doFetch,
      cache,
      now,
      force,
      ...(cat.offline !== undefined ? { offline: cat.offline } : {}),
      ...(cat.ttlMs !== undefined ? { ttlMs: cat.ttlMs } : {}),
      ...(cat.timeoutMs !== undefined ? { timeoutMs: cat.timeoutMs } : {}),
      ...(source === 'modelsDev' && cat.modelsDevUrl ? { url: cat.modelsDevUrl } : {}),
      ...(source === 'openRouter' && cat.openRouterUrl ? { url: cat.openRouterUrl } : {}),
    }
    const run = (async (): Promise<{ refresh?: Promise<void> }> => {
      const loaded = await (source === 'openRouter'
        ? loadOpenRouterModels(opts)
        : loadModelsDev(opts))
      if (loaded.data !== undefined) setSource(source, loaded.data)
      else warn(`Catalog "${source}" is unavailable (offline or fetch failed).`)
      if (loaded.refresh === undefined) return {}
      return {
        refresh: loaded.refresh.then((data) => {
          if (data !== undefined) setSource(source, data)
        }),
      }
    })().finally(() => inflight.delete(source))
    inflight.set(source, run)
    return run
  }

  async function loadCatalogs(o: { refresh?: boolean } = {}): Promise<{ refresh?: Promise<void> }> {
    await ready()
    const needed = new Set<Source>()
    for (const p of profiles().values()) {
      const def = defs.get(p.definitionId)
      if (p.enabled && def !== undefined) for (const s of sourcesOf(def)) needed.add(s)
    }
    const refreshes: Array<Promise<void>> = []
    for (const s of needed) {
      const r = await ensureSource(s, o.refresh === true)
      if (r.refresh !== undefined) refreshes.push(r.refresh)
    }
    return refreshes.length > 0 ? { refresh: Promise.all(refreshes).then(() => undefined) } : {}
  }

  function catalogInfo(def: AnyProviderDefinition, modelId: string): ModelInfo | undefined {
    const parts: Array<ModelInfo | undefined> = []
    const hint = def.catalog
    if (hint?.modelsDevKey !== undefined) {
      const rec = recordOf('modelsDev')
      parts.push(
        Array.isArray(hint.modelsDevKey)
          ? rec?.[modelId]
          : rec?.[`${hint.modelsDevKey}/${modelId}`],
      )
    }
    if (hint?.kind === 'openrouter') parts.push(recordOf('openRouter')?.[modelId])
    return mergeInfo(...parts)
  }

  function infoFor(profile: ProviderProfile, modelId: string): ModelInfo | undefined {
    const def = defs.get(profile.definitionId)
    if (def === undefined) return undefined
    const l = live.get(profile.id)?.models.find((m) => m.id === modelId)?.info
    const extra = profile.models?.extra?.find((x) => x.id === modelId)
    const extraInfo: ModelInfo | undefined = extra
      ? nonEmpty({
          ...(extra.contextWindow !== undefined ? { contextWindow: extra.contextWindow } : {}),
          ...(extra.maxOutputTokens !== undefined
            ? { maxOutputTokens: extra.maxOutputTokens }
            : {}),
          ...(extra.pricing !== undefined ? { pricing: extra.pricing } : {}),
        })
      : undefined
    return mergeInfo(catalogInfo(def, modelId), l, extraInfo)
  }

  function fallbackRecord(): Record<string, ModelInfo> {
    fallback ??= { ...recordOf('modelsDev'), ...recordOf('openRouter') }
    return fallback
  }

  function catalog(): ModelCatalog {
    return (model) => {
      const ref =
        typeof model === 'string' ? stringRefs.get(model) : objectRefs.get(model as object)
      const profile = ref === undefined ? undefined : snapshot?.get(ref.profileId)
      if (ref !== undefined && profile !== undefined) {
        const info = infoFor(profile, ref.modelId)
        if (info !== undefined) return info
      }
      return lookupModel(fallbackRecord(), model)
    }
  }

  async function liveList(
    profile: ProviderProfile,
    def: AnyProviderDefinition,
    refresh: boolean,
  ): Promise<ListedModel[] | undefined> {
    if (def.listModels === undefined) return undefined
    const key = stable(profile.settings)
    const hit = live.get(profile.id)
    if (hit !== undefined && hit.key === key && !refresh && now() - hit.at < listTtl)
      return hit.models
    try {
      const settings = validateSettings(def.settings, profile.settings)
      const models = await def.listModels(settings, {
        fetch: doFetch,
        signal: AbortSignal.timeout(10_000),
      })
      live.set(profile.id, { key, at: now(), models })
      return models
    } catch (error) {
      warn(
        `Listing models of "${profile.id}" failed: ${scrub(String(error), secretValuesOf(def.settings, profile.settings))}`,
        {
          profileId: profile.id,
        },
      )
      return undefined
    }
  }

  async function models(
    profileId: string,
    o: { refresh?: boolean; includeDisabled?: boolean } = {},
  ): Promise<ModelEntry[]> {
    await ready()
    const profile = profileOf(profileId)
    const def = defOf(profile)
    const refresh = o.refresh === true
    await Promise.all(sourcesOf(def).map((s) => ensureSource(s, refresh)))
    const liveModels = await liveList(profile, def, refresh)
    const byId = new Map<string, ModelEntry>()
    if (liveModels !== undefined) {
      for (const m of liveModels) {
        const info = mergeInfo(catalogInfo(def, m.id), m.info)
        byId.set(m.id, { ...m, name: m.name ?? m.id, ...(info ? { info } : {}), source: 'live' })
      }
    } else {
      const fromCatalog: ListedModel[] = []
      if (def.catalog?.kind === 'openrouter' && raw.openRouter !== undefined) {
        fromCatalog.push(...parseOpenRouterModels(raw.openRouter))
      }
      if (def.catalog?.modelsDevKey !== undefined && raw.modelsDev !== undefined) {
        fromCatalog.push(...parseModelsDevModels(raw.modelsDev, def.catalog.modelsDevKey))
      }
      for (const m of fromCatalog) byId.set(m.id, { ...m, name: m.name ?? m.id, source: 'catalog' })
    }
    const extras: ModelEntry[] = []
    for (const x of profile.models?.extra ?? []) {
      const { id, name, ...rest } = x
      const before = byId.get(id)
      const info = mergeInfo(before?.info, rest)
      byId.delete(id)
      extras.push({
        ...before,
        id,
        name: name ?? before?.name ?? id,
        ...(info ? { info } : {}),
        source: 'extra',
      })
    }
    const keep = (m: ModelEntry): boolean =>
      o.includeDisabled === true || allowed(profile.models, m.id)
    const mark = (m: ModelEntry): ModelEntry =>
      o.includeDisabled === true ? { ...m, enabled: allowed(profile.models, m.id) } : m
    const rest = [...byId.values()]
      .filter(keep)
      .map(mark)
      .sort(
        (a, b) =>
          Number(b.tools === true) - Number(a.tools === true) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
    return [...extras.filter(keep).map(mark), ...rest]
  }

  async function test(profileId: string): Promise<TestResult> {
    await ready()
    const profile = profileOf(profileId)
    const def = defOf(profile)
    const secrets = secretValuesOf(def.settings, profile.settings)
    let settings: Record<string, unknown>
    try {
      settings = validateSettings(def.settings, profile.settings)
    } catch (error) {
      return {
        ok: false,
        message: scrub(error instanceof Error ? error.message : String(error), secrets),
      }
    }
    const started = now()
    const ctx = { fetch: doFetch, signal: AbortSignal.timeout(10_000) }
    try {
      let result: TestResult
      if (def.test !== undefined) result = await def.test(settings, ctx)
      else if (def.listModels !== undefined) {
        const list = await def.listModels(settings, ctx)
        result = { ok: true, message: `${list.length} models` }
      } else result = { ok: true, message: 'Settings are valid (no live check for this provider).' }
      return {
        ...result,
        ...(result.message !== undefined ? { message: scrub(result.message, secrets) } : {}),
        latencyMs: result.latencyMs ?? now() - started,
      }
    } catch (error) {
      return {
        ok: false,
        message: scrub(error instanceof Error ? error.message : String(error), secrets),
        latencyMs: now() - started,
      }
    }
  }

  function describeDef(def: AnyProviderDefinition): ProviderDescription {
    return {
      id: def.id,
      label: def.label,
      ...(def.doc !== undefined ? { doc: def.doc } : {}),
      ...(def.defaultModel !== undefined ? { defaultModel: def.defaultModel } : {}),
      form: formSpec(def.settings),
      envMap: { ...(def.envMap as Record<string, string> | undefined) },
      canListModels: def.listModels !== undefined || def.catalog !== undefined,
      canTest: true,
    }
  }

  function publicOf(profile: ProviderProfile): PublicProfile {
    return redactProfile(defOf(profile).settings, profile)
  }

  async function putProfile(input: ProfileInput): Promise<PublicProfile> {
    await ready()
    const map = profiles()
    const existing = input.id === undefined ? undefined : map.get(input.id)
    if (existing?.source === 'env') {
      throw fail(
        'read-only',
        `Profile "${existing.id}" comes from the environment and is read-only.`,
        { profileId: existing.id },
      )
    }
    let id: string
    let providerId: string
    if (existing !== undefined) {
      id = existing.id
      providerId = existing.definitionId
      if (input.providerId !== undefined && input.providerId !== providerId) {
        throw fail(
          'provider-immutable',
          `Profile "${id}" belongs to provider "${providerId}"; create a new profile instead.`,
        )
      }
    } else {
      if (input.providerId === undefined)
        throw fail('provider-required', 'providerId is required for a new profile.')
      providerId = input.providerId
      id = input.id ?? providerId
      if (input.id === undefined) for (let n = 2; map.has(id); n++) id = `${providerId}-${n}`
      if (!PROFILE_ID.test(id))
        throw fail(
          'profile-id-invalid',
          `Invalid profile id "${id}": use letters, digits, ".", "_" and "-" (no ":").`,
        )
      if (map.has(id)) throw fail('profile-exists', `Profile "${id}" already exists.`)
    }
    const def = defs.get(providerId)
    if (def === undefined)
      throw fail('unknown-provider', `Unknown provider "${providerId}".`, { providerId })
    const settings = mergeSecretPatch(def.settings, existing?.settings ?? {}, input.settings ?? {})
    validateSettings(def.settings, settings, `settings of profile "${id}" (${providerId})`)
    const models = input.models === null ? undefined : (input.models ?? existing?.models)
    const profile: ProviderProfile = {
      id,
      kind: KIND,
      definitionId: providerId,
      label: input.label ?? existing?.label ?? def.label,
      settings,
      enabled: input.enabled ?? existing?.enabled ?? true,
      ...(models !== undefined ? { models: structuredClone(models) } : {}),
      source: 'store',
      updatedAt: now(),
    }
    await store.put(profile)
    // the current snapshot: a reload may have replaced the one read before the write
    profiles().set(id, profile)
    invalidate(id)
    return publicOf(profile)
  }

  async function deleteProfile(id: string): Promise<void> {
    await ready()
    const existing = profiles().get(id)
    if (existing === undefined) return
    if (existing.source === 'env') {
      throw fail('read-only', `Profile "${id}" comes from the environment and is read-only.`, {
        profileId: id,
      })
    }
    await store.delete(KIND, id)
    profiles().delete(id)
    invalidate(id)
  }

  function invalidate(profileId?: string): void {
    if (profileId === undefined) {
      built.clear()
      live.clear()
    } else {
      built.delete(profileId)
      live.delete(profileId)
    }
  }

  return {
    ready,
    reload: async () => {
      await ready()
      await load()
    },
    describe: async () => {
      await ready()
      return {
        providers: [...defs.values()].map(describeDef),
        profiles: [...profiles().values()].filter((p) => defs.has(p.definitionId)).map(publicOf),
      }
    },
    listProfiles: async () => {
      await ready()
      return [...profiles().values()].filter((p) => defs.has(p.definitionId)).map(publicOf)
    },
    getProfile: async (id) => {
      await ready()
      const p = profiles().get(id)
      return p === undefined || !defs.has(p.definitionId) ? undefined : publicOf(p)
    },
    putProfile,
    deleteProfile,
    resolve,
    models,
    loadCatalogs,
    catalog,
    test,
    invalidate,
    dispose: () => {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
