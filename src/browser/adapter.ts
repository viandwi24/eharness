/**
 * Adapters and the registry (spec 35 §2): an adapter is one engine family (settings per mode,
 * capabilities, how to connect); the registry holds them, builds profile forms with the providers
 * form builder and validates, merges and redacts profile settings.
 *
 * @see docs/specs/35-browser.md#2-adapters-and-the-registry
 */
import type { z } from 'zod/v4'
import { HarnessError, isRecord } from '../index.ts'
import { mergeSecretPatch } from '../providers/form.ts'
import {
  formSpec,
  type ProviderFormSpec,
  redactSettings,
  validateSettings,
} from '../providers/index.ts'
import type { BrowserRuntime, RuntimeEndpoint } from './runtime.ts'
import type {
  BrowserCapabilities,
  BrowserConnection,
  BrowserEndpoint,
  BrowserProfile,
  ConnectContext,
  PublicBrowserProfile,
} from './types.ts'

/** The two ways a profile reaches a browser. */
export type BrowserMode = 'manual' | 'managed'

/** Definition of {@link defineBrowserAdapter}. */
export interface BrowserAdapterDef<
  M extends z.ZodObject = z.ZodObject,
  G extends z.ZodObject = z.ZodObject,
> {
  /** `[a-z0-9-]+`, unique in a registry. */
  id: string
  label: string
  description?: string
  /** Connect to an endpoint someone else runs. */
  manual?: {
    /** Zod settings; `ehMeta()` for form hints and secret fields (spec 23 §2). */
    settings: M
    endpoint(settings: z.infer<M>): BrowserEndpoint | Promise<BrowserEndpoint>
  }
  /** The app downloads, prepares and starts the engine (needs a runtime from the app). */
  managed?: {
    settings: G
    /** One runtime serves every managed profile of this adapter. */
    runtime: BrowserRuntime
    /** Map the profile's settings to what `runtime.start` reads. Default: the settings as they are. */
    runtimeSettings?(settings: z.infer<G>): Record<string, unknown>
    /** Map a started engine to an endpoint. Default: `{ protocol: 'cdp', url: cdpUrl }`. */
    endpoint?(started: RuntimeEndpoint, settings: z.infer<G>): BrowserEndpoint
  }
  /** What the engine can do in a mode (a function when it depends on the settings). */
  capabilities:
    | BrowserCapabilities
    | ((mode: BrowserMode, settings: Record<string, unknown>) => BrowserCapabilities)
  connect(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<BrowserConnection>
  /** A cheap check that the endpoint answers; returns the engine version. Default: connect and close. */
  test?(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<{ version: string }>
}

/** A registered adapter (settings types erased). */
export interface BrowserAdapter {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly modes: readonly BrowserMode[]
  /** The settings schema of a mode. */
  schema(mode: BrowserMode): z.ZodObject | undefined
  /** The runtime of managed mode, when the app passed one. */
  runtime(): BrowserRuntime | undefined
  capabilities(mode: BrowserMode, settings: Record<string, unknown>): BrowserCapabilities
  /** The endpoint of a manual profile. */
  manualEndpoint(settings: Record<string, unknown>): Promise<BrowserEndpoint>
  /** The settings `runtime.start` receives for a managed profile. */
  runtimeSettings(settings: Record<string, unknown>): Record<string, unknown>
  /** The endpoint of a started managed engine. */
  managedEndpoint(started: RuntimeEndpoint, settings: Record<string, unknown>): BrowserEndpoint
  connect(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<BrowserConnection>
  test(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<{ version: string }>
}

/** What a UI shows of an adapter. */
export interface BrowserAdapterInfo {
  id: string
  label: string
  description?: string
  modes: BrowserMode[]
  /** Per mode, with default settings (a profile's real settings may change them). */
  capabilities: Partial<Record<BrowserMode, BrowserCapabilities>>
}

/** The adapters of an app. */
export interface BrowserRegistry {
  get(id: string): BrowserAdapter | undefined
  list(): BrowserAdapterInfo[]
  /** Profile forms by mode, from the adapter's settings schemas. Empty for an unknown adapter. */
  forms(id: string): { manual?: ProviderFormSpec; managed?: ProviderFormSpec }
  /** Parse settings with the adapter's schema (defaults applied). Throws `EH_CONFIG_INVALID`. */
  validate(
    id: string,
    mode: BrowserMode,
    settings: Record<string, unknown>,
  ): Record<string, unknown>
  /**
   * Apply an edit from a form without resending secrets (`''` or `{ keep: true }` keeps one), then
   * validate. Throws `EH_CONFIG_INVALID`.
   */
  merge(
    id: string,
    mode: BrowserMode,
    stored: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown>
  /** The profile with every secret replaced by `{ set, hint? }`. Safe to send to a browser. */
  publicProfile(profile: BrowserProfile): PublicBrowserProfile
}

const ID = /^[a-z0-9][a-z0-9-]*$/

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new HarnessError('EH_CONFIG_INVALID', `browser: ${message}`, {
    details: { plugin: 'browser', ...details },
  })
}

/**
 * Define a browser adapter: one engine family with settings per mode, capabilities and a way to
 * connect. At least one mode is required.
 *
 * @example
 * ```ts
 * const adapter = defineBrowserAdapter({
 *   id: 'my-engine',
 *   label: 'My engine',
 *   manual: { settings, endpoint: (s) => ({ protocol: 'cdp', url: s.url }) },
 *   capabilities: { snapshot: true, screenshot: true, liveView: 'poll', takeover: true, tabs: false, persistentProfile: false },
 *   connect: async (endpoint, ctx) => myConnection(endpoint, ctx),
 * })
 * ```
 */
export function defineBrowserAdapter<M extends z.ZodObject, G extends z.ZodObject>(
  def: BrowserAdapterDef<M, G>,
): BrowserAdapter {
  if (!ID.test(def.id)) invalid(`adapter id "${def.id}" must match [a-z0-9-]+`)
  const modes: BrowserMode[] = []
  if (def.manual !== undefined) modes.push('manual')
  if (def.managed !== undefined) modes.push('managed')
  if (modes.length === 0) invalid(`adapter "${def.id}" has no mode (give manual, managed or both)`)
  const caps = (mode: BrowserMode, settings: Record<string, unknown>): BrowserCapabilities =>
    typeof def.capabilities === 'function'
      ? def.capabilities(mode, settings)
      : { ...def.capabilities }
  return {
    id: def.id,
    label: def.label,
    ...(def.description === undefined ? {} : { description: def.description }),
    modes,
    schema: (mode) => (mode === 'manual' ? def.manual?.settings : def.managed?.settings),
    runtime: () => def.managed?.runtime,
    capabilities: caps,
    manualEndpoint: async (settings) => {
      if (def.manual === undefined) invalid(`adapter "${def.id}" has no manual mode`)
      return def.manual.endpoint(settings as z.infer<M>)
    },
    runtimeSettings: (settings) =>
      def.managed?.runtimeSettings?.(settings as z.infer<G>) ?? settings,
    managedEndpoint: (started, settings) =>
      def.managed?.endpoint?.(started, settings as z.infer<G>) ?? {
        protocol: 'cdp',
        url: started.cdpUrl,
        ...(started.headers === undefined ? {} : { headers: started.headers }),
        ...(started.liveUrl === undefined ? {} : { liveUrl: started.liveUrl }),
      },
    connect: (endpoint, ctx) => def.connect(endpoint, ctx),
    test: async (endpoint, ctx) => {
      if (def.test !== undefined) return def.test(endpoint, ctx)
      const connection = await def.connect(endpoint, ctx)
      await connection.close()
      return { version: 'unknown' }
    },
  }
}

/** Build a registry. Duplicate ids throw `EH_CONFIG_INVALID`. */
export function createBrowserRegistry(adapters: readonly BrowserAdapter[]): BrowserRegistry {
  const map = new Map<string, BrowserAdapter>()
  for (const adapter of adapters) {
    if (map.has(adapter.id)) invalid(`duplicate adapter id "${adapter.id}"`)
    map.set(adapter.id, adapter)
  }
  const schemaOf = (id: string, mode: BrowserMode): z.ZodObject => {
    const adapter = map.get(id)
    if (adapter === undefined) invalid(`unknown adapter "${id}"`, { reason: 'unknown-adapter' })
    const schema = adapter.schema(mode)
    if (schema === undefined) {
      invalid(`adapter "${id}" does not offer ${mode} mode`, { reason: 'unknown-mode' })
    }
    return schema
  }
  return {
    get: (id) => map.get(id),
    list: () =>
      [...map.values()].map((a) => ({
        id: a.id,
        label: a.label,
        ...(a.description === undefined ? {} : { description: a.description }),
        modes: [...a.modes],
        capabilities: Object.fromEntries(
          a.modes.map((m) => [m, a.capabilities(m, defaultsOf(a.schema(m)))]),
        ) as Partial<Record<BrowserMode, BrowserCapabilities>>,
      })),
    forms: (id) => {
      const adapter = map.get(id)
      if (adapter === undefined) return {}
      const out: { manual?: ProviderFormSpec; managed?: ProviderFormSpec } = {}
      const manual = adapter.schema('manual')
      const managed = adapter.schema('managed')
      if (manual !== undefined) out.manual = formSpec(manual)
      if (managed !== undefined) out.managed = formSpec(managed)
      return out
    },
    validate: (id, mode, settings) =>
      validateSettings(schemaOf(id, mode), settings, `${id} ${mode} settings`),
    merge: (id, mode, stored, patch) => {
      const schema = schemaOf(id, mode)
      // a secret that is also an endpoint (a CDP URL with its key) is "kept" by leaving it out of
      // the patch: `mergeSecretPatch` would read a keep marker as a change of the endpoint
      const given = { ...patch }
      for (const field of formSpec(schema).fields) {
        if (!field.secret || field.endpoint !== true || field.path.includes('.')) continue
        const v = given[field.path]
        if (v === undefined || v === '' || (isRecord(v) && v.keep === true))
          delete given[field.path]
      }
      return validateSettings(
        schema,
        mergeSecretPatch(schema, stored, given),
        `${id} ${mode} settings`,
      )
    },
    publicProfile: (profile) => {
      const schema = map.get(profile.adapter)?.schema(profile.mode)
      const settings = schema === undefined ? {} : redactSettings(schema, profile.settings)
      return { ...structuredClone({ ...profile, settings: {} }), settings }
    },
  }
}

/** The settings the schema produces from nothing (to ask an adapter its default capabilities). */
function defaultsOf(schema: z.ZodObject | undefined): Record<string, unknown> {
  if (schema === undefined) return {}
  const parsed = schema.safeParse({})
  return parsed.success ? (parsed.data as Record<string, unknown>) : {}
}
