/** Channels gateway (docs/plans/P41-team-channels.md, phase L1): platform neutral, no platform names. */

export type {
  ApprovalAnswerInput,
  ChannelGateway,
  ConnectionInfo,
  GatewayDeps,
  HandleResult,
  PendingView,
  WakeInput,
} from './gateway.ts'
export { createChannelGateway } from './gateway.ts'
export type { MockAdapter, MockKind, MockOptions, MockSay, MockSent } from './mock-adapter.ts'
export { createMockAdapter, MOCK_CAPABILITIES } from './mock-adapter.ts'
export * from './model.ts'
export type { ChannelsPluginOptions } from './plugin.ts'
export { CHANNEL_READ_TOOLS, CHANNEL_TOOLS, channels } from './plugin.ts'
export type { ConnectionConfig, ConnectionConfigInput, ScopePolicy } from './policy.ts'
export { ConnectionConfigSchema } from './policy.ts'
export * from './types.ts'
export { channelVault, channelVaultFromEnv } from './vault.ts'
