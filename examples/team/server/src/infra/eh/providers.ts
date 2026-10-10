/**
 * Model providers of the team server: the `eharness/providers` manager over the app's pieces.
 *
 * - definitions: OpenRouter (`@openrouter/ai-sdk-provider`) and the Vercel AI Gateway (`ai`);
 * - profiles: environment variables are read-only `env` profiles (`OPENROUTER_API_KEY`,
 *   `OPENROUTER_BASE_URL`, `AI_GATEWAY_API_KEY`); everything saved from the web lives in
 *   `config_profiles` with its secrets AES-GCM encrypted (`profile-store.ts`, `secret-box.ts`);
 * - catalogs (prices, context windows): cached in `catalog_cache`; `TEAM_OFFLINE=1` never fetches;
 * - several instances: a profile change appends a `providers-changed` event, the others tail the
 *   feed and reload their manager.
 *
 * `createProviderService` implements `ProvidersPort` (the HTTP routes) and is the source of the
 * `ModelConfig` the agent factory resolves models with (`provider.ts`).
 */
import type { Database } from 'bun:sqlite'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createGateway } from 'ai'
import {
  createProviderManager,
  gatewayProvider,
  openRouterProvider,
  type ProfileStore,
  type ProviderManager,
  type PublicProfile,
} from 'eharness/providers'
import type { ProvidersPort } from '../../app/ports.ts'
import { conflict, DomainError, invalid, notFound } from '../../domain/errors.ts'
import type {
  ModelView,
  ProfileView,
  ProviderDefinitionView,
  TestResultView,
} from '../../domain/providers.ts'
import { sqliteCatalogCache } from './catalog-cache.ts'

type Env = Record<string, string | undefined>

/** Model of a provider when neither the profile nor `TEAM_MODEL` names one. */
export const DEFAULT_MODEL: Record<string, string> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  gateway: 'anthropic/claude-sonnet-4.6',
}

export interface ProviderServiceOptions {
  sqlite: Database
  /**
   * The server's profile store (`sqliteProfileStore`): provider profiles, connections and
   * credentials share the table and the secret box. The caller appends `providers-changed` for
   * `provider` rows (with this service's `instance`).
   */
  store: ProfileStore
  /** Id of this instance: its own `providers-changed` events are ignored. */
  instance?: string
  /** Default `process.env`: env profiles, `TEAM_PROVIDER`, `TEAM_MODEL`. */
  env?: Env
  /** Never fetch the public model catalogs (default: `TEAM_OFFLINE=1`). */
  offline?: boolean
  fetch?: typeof fetch
  /** Reads the event feed (other instances' changes). */
  feed?: {
    lastSeq(): number
    events(
      after: number,
      limit: number,
    ): Array<{ seq: number; type: string; payload: Record<string, unknown> }>
  }
  /** Poll interval of the feed (ms, default 1000; 0 = off). */
  pollMs?: number
  warn?: (message: string) => void
}

export interface ProviderService extends ProvidersPort {
  manager: ProviderManager
  /** Load profiles and the catalogs (never throws). */
  ready(): Promise<void>
  /** Bumps whenever the profiles change on this or another instance (cache key of agents). */
  rev(): number
  /** Profiles as of now (synchronous). */
  profiles(): readonly ProfileView[]
  /** The profile agents without their own pick use, or undefined when there is none. */
  defaultProfileId(): string | undefined
  /** `TEAM_MODEL` when `profileId` is the env default profile, else the provider's default model. */
  defaultModelOf(profileId: string): string
  /** Env override of the Auto classifier (`TEAM_CLASSIFIER_MODEL`) and of search (`TEAM_SEARCH_MODEL`). */
  env: Env
  close(): void
}

function mapError(error: unknown): never {
  if (error instanceof DomainError) throw error
  const e = error as { code?: unknown; message?: string; details?: Record<string, unknown> }
  if (e?.code === 'EH_CONFIG_INVALID') {
    const reason = String(e.details?.reason ?? 'invalid')
    const message = e.message ?? 'invalid provider configuration'
    if (reason === 'profile-not-found')
      throw notFound('provider profile', String(e.details?.profileId ?? ''))
    if (reason === 'read-only') throw conflict(message, 'READ_ONLY_PROFILE')
    if (reason === 'profile-exists') throw conflict(message, 'PROFILE_EXISTS')
    throw new DomainError('invalid', reason.toUpperCase().replaceAll('-', '_'), message, e.details)
  }
  throw error
}

/** `kind` of provider rows in the profile table. */
export const PROVIDER_KIND = 'provider'

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const instance = options.instance ?? crypto.randomUUID()
  const store = options.store
  const manager = createProviderManager({
    definitions: [openRouterProvider({ createOpenRouter }), gatewayProvider({ createGateway })],
    store,
    env,
    cache: sqliteCatalogCache(options.sqlite),
    catalogs: { offline: options.offline ?? env.TEAM_OFFLINE === '1' },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    onWarning: (message) => warn(message),
  })

  let views: ProfileView[] = []
  let definitions: ProviderDefinitionView[] = []
  let revision = 0
  let readyPromise: Promise<void> | undefined

  const envDefaultId = (): string | undefined => {
    const forced = env.TEAM_PROVIDER
    const ids = new Set(views.filter((p) => p.source === 'env' && p.enabled).map((p) => p.id))
    if (forced !== undefined && forced !== '' && ids.has(forced)) return forced
    if (ids.has('openrouter')) return 'openrouter'
    if (ids.has('gateway')) return 'gateway'
    return undefined
  }

  const toView = (p: PublicProfile): ProfileView => ({
    id: p.id,
    definitionId: p.definitionId,
    label: p.label,
    enabled: p.enabled,
    source: p.source === 'env' ? 'env' : 'store',
    settings: p.settings,
    ...(p.models === undefined ? {} : { models: p.models as ProfileView['models'] & object }),
    updatedAt: p.updatedAt,
    isDefault: false,
  })

  async function refresh(): Promise<void> {
    const list = await manager.listProfiles()
    views = list.map(toView)
    revision++
  }

  async function loadDefinitions(): Promise<void> {
    const { providers } = await manager.describe()
    definitions = providers.map((d) => ({
      id: d.id,
      label: d.label,
      ...(d.doc === undefined ? {} : { doc: d.doc }),
      ...(d.defaultModel === undefined ? {} : { defaultModel: d.defaultModel }),
      fields: d.form.fields as ProviderDefinitionView['fields'],
      jsonSchema: d.form.jsonSchema,
      envMap: d.envMap,
      canListModels: d.canListModels,
    }))
  }

  const defaultProfileId = (): string | undefined =>
    envDefaultId() ?? views.find((p) => p.enabled && p.source === 'store')?.id

  async function reloadFromFeed(): Promise<void> {
    await manager.reload()
    await refresh()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const startFeed = (): void => {
    const { feed } = options
    const pollMs = options.pollMs ?? 1000
    if (feed === undefined || pollMs <= 0) return
    let after = feed.lastSeq()
    let busy = false
    timer = setInterval(() => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          let changed = false
          for (;;) {
            const batch = feed.events(after, 100)
            if (batch.length === 0) break
            for (const e of batch) {
              after = e.seq
              if (e.type === 'providers-changed' && e.payload.instance !== instance) changed = true
            }
          }
          if (changed) await reloadFromFeed()
        } catch (error) {
          warn(`reloading provider profiles failed: ${String(error)}`)
        } finally {
          busy = false
        }
      })()
    }, pollMs)
    timer.unref()
  }

  const ready = (): Promise<void> => {
    readyPromise ??= (async () => {
      await manager.ready()
      await loadDefinitions()
      await refresh()
      startFeed()
      // prices and context windows; a failure leaves the catalog empty, never fatal
      await manager.loadCatalogs().then(
        (r) => void r.refresh?.catch(() => undefined),
        (error) => warn(`model catalogs unavailable: ${String(error)}`),
      )
    })()
    return readyPromise
  }

  const withDefault = (): ProfileView[] => {
    const def = defaultProfileId()
    return views.map((v) => ({ ...v, isDefault: v.id === def }))
  }

  const published = (id: string): ProfileView => {
    const v = views.find((p) => p.id === id)
    if (v === undefined) throw notFound('provider profile', id)
    return { ...v, isDefault: v.id === defaultProfileId() }
  }

  const loadCatalogsLater = (): void => {
    void manager.loadCatalogs().then(
      (r) => r.refresh?.catch(() => undefined),
      () => undefined,
    )
  }

  const toModelView = (m: Awaited<ReturnType<ProviderManager['models']>>[number]): ModelView => ({
    id: m.id,
    name: m.name,
    ...(m.description === undefined ? {} : { description: m.description }),
    ...(m.info?.contextWindow === undefined ? {} : { contextWindow: m.info.contextWindow }),
    ...(m.info?.maxOutputTokens === undefined ? {} : { maxOutputTokens: m.info.maxOutputTokens }),
    ...(m.info?.pricing === undefined ? {} : { pricing: { ...m.info.pricing } }),
    ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
    ...(m.tools === undefined ? {} : { tools: m.tools }),
    source: m.source,
  })

  return {
    manager,
    env,
    ready,
    rev: () => revision,
    profiles: () => views,
    defaultProfileId,
    defaultModelOf(profileId) {
      const view = views.find((p) => p.id === profileId)
      if (profileId === envDefaultId() && env.TEAM_MODEL) return env.TEAM_MODEL
      const definition = definitions.find((d) => d.id === view?.definitionId)
      return (
        definition?.defaultModel ??
        DEFAULT_MODEL[view?.definitionId ?? ''] ??
        (DEFAULT_MODEL.openrouter as string)
      )
    },
    async describe() {
      await ready()
      return { providers: definitions, profiles: withDefault() }
    },
    profileIds: () => views.map((p) => p.id),
    async create(input) {
      await ready()
      try {
        const profile = await manager.putProfile({
          providerId: input.providerId,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        })
        await refresh()
        loadCatalogsLater()
        return published(profile.id)
      } catch (error) {
        return mapError(error)
      }
    },
    async update(id, patch) {
      await ready()
      try {
        await manager.putProfile({
          id,
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.settings === undefined ? {} : { settings: patch.settings }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.models === undefined ? {} : { models: patch.models }),
        })
        await refresh()
        return published(id)
      } catch (error) {
        // an edit of an id that does not exist would otherwise create nothing and say "provider required"
        if (!views.some((p) => p.id === id)) throw notFound('provider profile', id)
        return mapError(error)
      }
    },
    async remove(id) {
      await ready()
      if (!views.some((p) => p.id === id)) throw notFound('provider profile', id)
      try {
        await manager.deleteProfile(id)
        await refresh()
      } catch (error) {
        return mapError(error)
      }
    },
    async test(id): Promise<TestResultView> {
      await ready()
      if (!views.some((p) => p.id === id)) throw notFound('provider profile', id)
      return manager.test(id)
    },
    async models(id, o) {
      await ready()
      if (!views.some((p) => p.id === id)) throw notFound('provider profile', id)
      try {
        return (await manager.models(id, { refresh: o.refresh })).map(toModelView)
      } catch (error) {
        if (error instanceof DomainError) throw error
        const e = error as { code?: unknown; message?: string }
        throw invalid(e.message ?? 'could not list models', 'MODELS_UNAVAILABLE')
      }
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      manager.dispose()
    },
  }
}
