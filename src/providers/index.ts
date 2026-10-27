/**
 * `eharness/providers`: provider definitions, profiles and a manager that turns them into AI SDK
 * models plus the model catalog (context windows, prices) the agent needs. The configuration
 * machinery (`formSpec`, `redactSettings`, `mergeSecretPatch`, `ConfigProfile`, `ProfileStore`,
 * `fromEnv`) is generic over any zod settings schema.
 *
 * Imports core only through `src/index.ts` (ADR-0008). Unlike the core, this module fetches
 * (model lists, public catalogs), only through an injected `fetch`.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/23-providers.md
 */
export {
  type AnthropicProviderOptions,
  anthropicProvider,
  defineProvider,
  type GatewayProviderOptions,
  gatewayProvider,
  type LocalProviderOptions,
  llamaCppProvider,
  lmStudioProvider,
  type OpenAICompatibleProviderOptions,
  type OpenAIProviderOptions,
  type OpenRouterProviderOptions,
  ollamaProvider,
  openAICompatibleProvider,
  openAIProvider,
  openRouterProvider,
  type ProviderFactory,
  vllmProvider,
} from './builtin.ts'
export {
  type CatalogCache,
  type CatalogCacheEntry,
  inMemoryCatalogCache,
  type LoadCatalogOptions,
  loadModelsDev,
  loadOpenRouterModels,
} from './catalog-loader.ts'
export { type EnvConfigurable, type FromEnvOptions, fromEnv } from './env.ts'
export {
  ehMeta,
  formSpec,
  type RedactOptions,
  redactProfile,
  redactSettings,
  secretStatus,
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
export {
  type SealedProfileStore,
  type SealedProfileStoreOptions,
  sealedProfileStore,
} from './sealed.ts'
export { type InMemoryProfileStoreOptions, inMemoryProfileStore } from './store.ts'
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
  SecretVault,
  SettingsSchema,
  ShowWhen,
  TestResult,
} from './types.ts'
export {
  plaintextVault,
  type VaultKeys,
  webCryptoVault,
} from './vault.ts'
