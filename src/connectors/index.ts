/**
 * `eharness/connectors`: the library half of a connectors system. Connector definitions (code),
 * connections (settings, secrets, tokens, status) at workspace or agent scope, per-agent
 * enablement with capability modes, a server-driven setup flow engine (closed view vocabulary),
 * OAuth 2.1 helpers (PKCE, discovery, dynamic registration, device grant, refresh), activation
 * into plugins, tool sources and permission rules, and built-in connectors for the shipped
 * plugins.
 *
 * Imports core only through `src/index.ts` and the generic configuration machinery of
 * `eharness/providers` (ADR-0049). Fetches only through an injected `fetch`; no Node-only code.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/24-connectors.md
 */

export {
  type ActivateOptions,
  type AppRules,
  activateConnectors,
  type CompiledTool,
  type CompileRulesOptions,
  compileConnectorRules,
  DEFAULT_BUILTIN_ORDER,
  mergeConnectorRules,
} from './activate.ts'
export {
  type BuiltinCapabilityLabel,
  type BuiltinConnectorsOptions,
  type BuiltinFactory,
  type BuiltinId,
  type BuiltinInput,
  type BuiltinLabel,
  type BuiltinMemoryRoot,
  builtinConnectionId,
  builtinConnectors,
  type EnsureBuiltinOptions,
  ensureBuiltinConnections,
} from './builtin.ts'
export {
  type CredentialManager,
  type CredentialManagerOptions,
  createCredentialManager,
  inMemoryRefreshLock,
  type RefreshLock,
} from './credentials.ts'
export {
  type ConnectorDescription,
  capabilitiesOf,
  connectorSchema,
  defineConnector,
  describeConnector,
  publicConnection,
} from './definition.ts'
export {
  type EnablementSubject,
  isConnectionEnabled,
  mostRestrictive,
  type ResolvedModes,
  resolveModes,
} from './enablement.ts'
export {
  advanceFlow,
  type CompleteOAuthResult,
  completeOAuth,
  defaultFlowSteps,
  flowCompletion,
  type OAuthCallback,
  publicFlow,
  type StartFlowParams,
  startFlow,
} from './flow.ts'
export {
  type AuthorizationServerMetadata,
  discoverMcpAuthorization,
  type McpAuthorization,
  type OAuthFetchOptions,
} from './oauth.ts'
export {
  capabilitiesFromTools,
  type RemoteMcpConnectorOptions,
  type RemoteToolInfo,
  remoteMcpConnector,
} from './remote-mcp.ts'
export {
  type ConnectionPatch,
  type ConnectorService,
  type ConnectorServiceOptions,
  createConnectorService,
  type ServiceAdvance,
  type ServiceFlow,
  type StartConnectParams,
} from './service.ts'
export {
  CONNECTION_KIND,
  CREDENTIALS_KIND,
  connectionStoreFromProfiles,
  credentialStoreFromProfiles,
  type InMemoryConnectionStoreOptions,
  inMemoryConnectionStore,
  inMemoryCredentialStore,
  inMemoryEnablementStore,
  inMemoryFlowStore,
} from './store.ts'
export type {
  ActivatedConnectors,
  ActiveConnection,
  AdvanceResult,
  AgentEnablement,
  AnyConnectorDefinition,
  CapabilityDef,
  CapabilityKind,
  CapabilityMode,
  ChooseOption,
  ChooseSpec,
  ChooseView,
  ClientConfigContext,
  ConfirmView,
  ConnectionCredentials,
  ConnectionEnablement,
  ConnectionRecord,
  ConnectionRuntime,
  ConnectionSession,
  ConnectionStatus,
  ConnectionStore,
  ConnectorActivation,
  ConnectorActivationContext,
  ConnectorAuth,
  ConnectorCallContext,
  ConnectorContribution,
  ConnectorDefinition,
  ConnectorRules,
  ConnectorScope,
  ConnectorSource,
  ConnectorTestResult,
  ConnectorToolKinds,
  ConnectorWarning,
  CredentialStore,
  DeviceCodeAuth,
  DeviceCodeView,
  EnablementState,
  EnablementStore,
  ErrorView,
  FlowAction,
  FlowCompletion,
  FlowDeps,
  FlowInput,
  FlowState,
  FlowStatus,
  FlowStepContext,
  FlowStepDef,
  FlowStore,
  FlowView,
  FlowViewBody,
  FormView,
  McpSourceSpec,
  OAuth2Auth,
  OAuthClient,
  OAuthEndpoints,
  OAuthTokens,
  OAuthView,
  PublicConnection,
  PublicFlow,
  QrView,
  ResolvedCapability,
  ResolvedFlowDeps,
  ScopeDefaults,
  StatusView,
  StepInput,
  StepOutcome,
  ToolOrigin,
} from './types.ts'
