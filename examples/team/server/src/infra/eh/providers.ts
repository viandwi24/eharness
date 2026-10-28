/**
 * Model providers of the team server: the `eharness/providers` manager over the app's pieces.
 *
 * - definitions: OpenRouter (`@openrouter/ai-sdk-provider`), the Vercel AI Gateway (`ai`), any
 *   OpenAI-compatible endpoint and the local servers Ollama, LM Studio, vLLM and llama.cpp
 *   (`@ai-sdk/openai-compatible`). Local servers report the context they run each model with; the
 *   listing is warmed at boot and after a profile change, so the catalog knows it before a model
 *   list is opened (a model runs cut at its server's context otherwise);
 * - profiles: environment variables are read-only `env` profiles (`OPENROUTER_API_KEY`,
 *   `OPENROUTER_BASE_URL`, `AI_GATEWAY_API_KEY`); everything saved from the web lives in
 *   `config_profiles`, sealed by the server's one vault (`profile-store.ts`, `secret-vault.ts`);
 * - catalogs (prices, context windows): cached in `catalog_cache`; `TEAM_OFFLINE=1` never fetches;
 * - several instances: a profile change appends a `providers-changed` event; the shared change
 *   feed (`change-feed.ts`) makes the others reload their manager.
 *
 * `createProviderService` implements `ProvidersPort` (the HTTP routes) and is the source of the
 * `ModelConfig` the agent factory resolves models with (`provider.ts`).
 */
import type { Database } from 'bun:sqlite'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createGateway, generateText, type LanguageModel, stepCountIs, tool } from 'ai'
import {
  createProviderManager,
  gatewayProvider,
  llamaCppProvider,
  lmStudioProvider,
  ollamaProvider,
  openAICompatibleProvider,
  openRouterProvider,
  type ProfileStore,
  type ProviderManager,
  type PublicProfile,
  vllmProvider,
} from 'eharness/providers'
import { z } from 'zod'
import type { ProvidersPort } from '../../app/ports.ts'
import { DomainError, invalid, notFound } from '../../domain/errors.ts'
import type {
  ModelView,
  ProfileView,
  ProviderDefinitionView,
  TestResultView,
  ToolProbeView,
} from '../../domain/providers.ts'
import { sqliteCatalogCache } from './catalog-cache.ts'
import type { ChangeFeed } from './change-feed.ts'
import { mapConfigError } from './config-errors.ts'
import { SEARCH_MODEL } from './web-search.ts'

type Env = Record<string, string | undefined>

/** Model of a provider when neither the profile nor `TEAM_MODEL` names one. */
export const DEFAULT_MODEL: Record<string, string> = {
  openrouter: 'anthropic/claude-sonnet-5.5',
  gateway: 'anthropic/claude-sonnet-4.6',
}

export interface ProviderServiceOptions {
  sqlite: Database
  /**
   * The server's sealed profile store (`sealedProfileStore` over `sqliteProfileStore`): provider
   * profiles, connections and credentials share the table and the vault. The caller appends
   * `providers-changed` for `provider` rows.
   */
  store: ProfileStore
  /** Default `process.env`: env profiles, `TEAM_PROVIDER`, `TEAM_MODEL`. */
  env?: Env
  /** Never fetch the public model catalogs (default: `TEAM_OFFLINE=1`). */
  offline?: boolean
  fetch?: typeof fetch
  /** Other instances' changes (`providers-changed`) reload the manager. */
  changes?: ChangeFeed
  warn?: (message: string) => void
  /** Wraps the model of a tool probe (the Logs page records it). Late-bound by the caller. */
  observeProbe?: (model: LanguageModel) => LanguageModel
}

/** A local model may load from disk first: give a probe time. */
const PROBE_TIMEOUT_MS = 120_000
const PROBE_WORD = 'pong'

/**
 * Ask the model to call one tool with a fixed input. `tools: true` when it did, with that input;
 * a model that answers in text, or calls with a wrong input, cannot be trusted with agent tools.
 */
export async function probeModelTools(model: LanguageModel): Promise<ToolProbeView> {
  const started = Date.now()
  let input: unknown
  try {
    const result = await generateText({
      model,
      instructions:
        'You are a connectivity check. Always answer by calling the tool you are given.',
      prompt: `Call the tool "echo" with the word "${PROBE_WORD}".`,
      tools: {
        echo: tool({
          description: 'Echo a word back.',
          inputSchema: z.object({ word: z.string() }),
          execute: async (i) => {
            input = i
            return 'ok'
          },
        }),
      },
      stopWhen: stepCountIs(1),
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - started
    const word = (input as { word?: unknown } | undefined)?.word
    if (typeof word === 'string' && word.trim().toLowerCase() === PROBE_WORD)
      return {
        ok: true,
        tools: true,
        message: 'Calls tools: agents can use this model.',
        latencyMs,
      }
    if (input !== undefined)
      return {
        ok: true,
        tools: false,
        message: `Called the tool with the wrong input (${JSON.stringify(input).slice(0, 80)}): tool use is unreliable.`,
        latencyMs,
      }
    const text = result.text.trim().replace(/\s+/g, ' ').slice(0, 120)
    return {
      ok: true,
      tools: false,
      message: `Answered in text instead of calling the tool${text ? ` ("${text}")` : ''}. The model or the server does not support tool calling (vLLM needs --enable-auto-tool-choice, llama.cpp --jinja).`,
      latencyMs,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      tools: false,
      message: `The model did not answer: ${message.replace(/\s+/g, ' ').slice(0, 300)}`,
      latencyMs: Date.now() - started,
    }
  }
}

export interface ProviderService extends ProvidersPort {
  manager: ProviderManager
  /** Load profiles and the catalogs (never throws). */
  ready(): Promise<void>
  /** Read the profiles from the store again (after rows were written behind the manager's back). */
  reload(): Promise<void>
  /** Bumps whenever the profiles change on this or another instance (cache key of agents). */
  rev(): number
  /** Profiles as of now (synchronous). */
  profiles(): readonly ProfileView[]
  /** The profile agents without their own pick use, or undefined when there is none. */
  defaultProfileId(): string | undefined
  /** `TEAM_MODEL` when `profileId` is the env default profile, else the provider's default model. */
  defaultModelOf(profileId: string): string
  /** The environment the service was started with (profiles, `TEAM_PROVIDER`, `TEAM_MODEL`). */
  env: Env
  close(): void
}

const mapError = (error: unknown): never =>
  mapConfigError(error, {
    noun: 'provider profile',
    idKey: 'profileId',
    notFoundReasons: ['profile-not-found'],
    conflicts: { 'read-only': 'READ_ONLY_PROFILE', 'profile-exists': 'PROFILE_EXISTS' },
  })

/** Definitions whose model list comes from the server itself (context windows included). */
const LOCAL_DEFINITIONS = [ollamaProvider, lmStudioProvider, vllmProvider, llamaCppProvider]
/** Profiles of these are listed in the background at boot and after a change (`warm`). */
const SELF_LISTED = new Set(['ollama', 'lmstudio', 'vllm', 'llamacpp', 'openai-compatible'])

/** `kind` of provider rows in the profile table. */
export const PROVIDER_KIND = 'provider'

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const store = options.store
  const manager = createProviderManager({
    definitions: [
      openRouterProvider({ createOpenRouter }),
      gatewayProvider({ createGateway }),
      ...LOCAL_DEFINITIONS.map((make) => make({ createOpenAICompatible })),
      openAICompatibleProvider({
        createOpenAICompatible,
        label: 'Custom (OpenAI-compatible)',
        apiKeyOptional: true,
      }),
    ],
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

  /**
   * List the models of self-listed profiles in the background: their context windows live in the
   * listing, and the catalog reads it (never throws; a server that is down is listed later).
   */
  const warm = (ids?: readonly string[]): void => {
    for (const v of views) {
      if (!v.enabled || !SELF_LISTED.has(v.definitionId)) continue
      if (ids !== undefined && !ids.includes(v.id)) continue
      void manager.models(v.id).catch(() => undefined)
    }
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
    warm()
  }

  options.changes?.on('providers-changed', reloadFromFeed)

  const ready = (): Promise<void> => {
    readyPromise ??= (async () => {
      await manager.ready()
      await loadDefinitions()
      await refresh()
      warm()
      // prices and context windows; a failure leaves the catalog empty, never fatal
      await manager.loadCatalogs().then(
        (r) => void r.refresh?.catch(() => undefined),
        (error) => warn(`model catalogs unavailable: ${String(error)}`),
      )
    })()
    return readyPromise
  }

  const modelOfProfile = (v: ProfileView): string => {
    if (v.id === envDefaultId() && env.TEAM_MODEL) return env.TEAM_MODEL
    const definition = definitions.find((d) => d.id === v.definitionId)
    return (
      definition?.defaultModel ??
      DEFAULT_MODEL[v.definitionId] ??
      (DEFAULT_MODEL.openrouter as string)
    )
  }

  const withDefault = (): ProfileView[] => {
    const def = defaultProfileId()
    return views.map((v) => ({ ...v, isDefault: v.id === def, defaultModel: modelOfProfile(v) }))
  }

  const published = (id: string): ProfileView => {
    const v = views.find((p) => p.id === id)
    if (v === undefined) throw notFound('provider profile', id)
    return { ...v, isDefault: v.id === defaultProfileId(), defaultModel: modelOfProfile(v) }
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
    ...(m.reasoning === undefined
      ? m.info?.thinking === undefined
        ? {}
        : { reasoning: true }
      : { reasoning: m.reasoning }),
    ...(m.info?.thinking === undefined ? {} : { thinking: structuredClone(m.info.thinking) }),
    ...(m.tools === undefined ? {} : { tools: m.tools }),
    source: m.source,
    ...(m.enabled === undefined ? {} : { enabled: m.enabled }),
  })

  return {
    manager,
    env,
    ready,
    async reload() {
      await ready()
      await reloadFromFeed()
    },
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
    defaultModelSource(profileId) {
      return profileId === envDefaultId() && env.TEAM_MODEL ? 'env' : 'built-in'
    },
    searchModelOf(profileId) {
      const kind = views.find((p) => p.id === profileId && p.enabled)?.definitionId
      return kind === 'openrouter' || kind === 'gateway' ? SEARCH_MODEL[kind] : undefined
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
        warm([profile.id])
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
        warm([id])
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
    async probeTools(id, modelId) {
      await ready()
      if (!views.some((p) => p.id === id && p.enabled)) throw notFound('provider profile', id)
      let model: LanguageModel
      try {
        model = manager.resolve({ profile: id, model: modelId })
      } catch (error) {
        const e = error as { message?: string }
        throw invalid(e.message ?? 'unknown model', 'MODEL_UNAVAILABLE')
      }
      return probeModelTools(options.observeProbe?.(model) ?? model)
    },
    async models(id, o) {
      await ready()
      if (!views.some((p) => p.id === id)) throw notFound('provider profile', id)
      try {
        return (
          await manager.models(id, {
            refresh: o.refresh,
            ...(o.all === true ? { includeDisabled: true } : {}),
          })
        ).map(toModelView)
      } catch (error) {
        if (error instanceof DomainError) throw error
        const e = error as { code?: unknown; message?: string }
        throw invalid(e.message ?? 'could not list models', 'MODELS_UNAVAILABLE')
      }
    },
    close() {
      manager.dispose()
    },
  }
}
