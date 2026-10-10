/**
 * `eharness/providers`: provider definitions, profiles and a manager that turns them into AI SDK
 * models plus the model catalog (context windows, prices) the agent needs. The configuration
 * machinery (`formSpec`, `redactSettings`, `mergeSecretPatch`, `ConfigProfile`, `ProfileStore`,
 * `fromEnv`) is generic over any zod settings schema.
 *
 * Imports core only through `src/index.ts` (ADR-0008). Unlike the core, this module fetches
 * (model lists, public catalogs), only through an injected `fetch`.
 *
 * @see docs/specs/23-providers.md
 */
export {
  type AnthropicProviderOptions,
  anthropicProvider,
  defineProvider,
  GATEWAY_MODELS_DEV_PROVIDERS,
  type GatewayProviderOptions,
  gatewayProvider,
  type OpenAICompatibleProviderOptions,
  type OpenAIProviderOptions,
  type OpenRouterProviderOptions,
  openAICompatibleProvider,
  openAIProvider,
  openRouterProvider,
  type ProviderFactory,
} from './builtin.ts'
export {
  type CatalogCache,
  type CatalogCacheEntry,
  DEFAULT_CATALOG_TIMEOUT_MS,
  DEFAULT_CATALOG_TTL_MS,
  type LoadCachedJsonOptions,
  type LoadCatalogOptions,
  type LoadedJson,
  loadCachedJson,
  loadModelsDev,
  loadOpenRouterModels,
  MODELS_DEV_URL,
  memoryCatalogCache,
  OPENROUTER_MODELS_URL,
  parseModelsDevModels,
  parseOpenRouterModels,
} from './catalog-loader.ts'
export { type EnvConfigurable, type FromEnvOptions, fromEnv } from './env.ts'
export {
  ehMeta,
  formSpec,
  mergeSecretPatch,
  providerFormSpec,
  type RedactOptions,
  redactProfile,
  redactSettings,
  scrub,
  secretStatus,
  secretValuesOf,
  validateSettings,
} from './form.ts'
export {
  createProviderManager,
  formatModelRef,
  type ManagerCatalogOptions,
  type ProfileInput,
  type ProviderManager,
  type ProviderManagerOptions,
  parseModelRef,
} from './manager.ts'
export { memoryProfileStore } from './store.ts'
export type {
  AnyProviderDefinition,
  ConfigProfile,
  ExtraModel,
  FieldGroup,
  FieldMeta,
  FieldWidget,
  FormField,
  KeepSecret,
  ListedModel,
  ModelEntry,
  ModelRef,
  ProfileModels,
  ProfileStore,
  ProviderCatalogHint,
  ProviderContext,
  ProviderDefinition,
  ProviderDescription,
  ProviderFormSpec,
  ProviderInstance,
  ProviderProfile,
  PublicConfigProfile,
  PublicProfile,
  SecretStatus,
  SettingsSchema,
  ShowWhen,
  TestResult,
} from './types.ts'
