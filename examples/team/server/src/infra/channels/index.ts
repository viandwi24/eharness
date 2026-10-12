/** Channels gateway (docs/plans/P41-team-channels.md, phase L1): platform neutral, no platform names. */

export { delegatedApprovals } from './delegated-approvals.ts'
export type {
  ApprovalAnswerInput,
  ChannelGateway,
  ConnectionInfo,
  GatewayDeps,
  HandleResult,
  PendingView,
  PersonView,
  Requester,
  WakeInput,
} from './gateway.ts'
export { createChannelGateway } from './gateway.ts'
export type {
  AuditRecord,
  CallClass,
  CallContext,
  Governor,
  GovernorLimits,
  GovernorState,
} from './governor.ts'
export {
  BOT_GOVERNOR,
  createGovernor,
  GovernorLimited,
  governAdapter,
  governorLimitsOf,
  USER_GOVERNOR,
} from './governor.ts'
export type { MockAdapter, MockKind, MockOptions, MockSay, MockSent } from './mock-adapter.ts'
export { createMockAdapter, MOCK_CAPABILITIES } from './mock-adapter.ts'
export * from './model.ts'
export type { ChannelsPluginOptions } from './plugin.ts'
export {
  CHANNEL_OWN_WRITE_TOOLS,
  CHANNEL_READ_TOOLS,
  CHANNEL_TOOLS,
  channels,
} from './plugin.ts'
export type { ConnectionConfig, ConnectionConfigInput, ScopePolicy } from './policy.ts'
export { ConnectionConfigSchema } from './policy.ts'
export type { Role } from './roles.ts'
export * from './types.ts'
export { channelVault, channelVaultFromEnv } from './vault.ts'
export { WEB_NOTE_CONNECTION, WEB_OWNER_NOTE_ID, webPersonNote } from './web-person-note.ts'
export type { WebRemindersOptions } from './web-reminders.ts'
export { WEB_REMINDER_DESCRIPTION, webReminders } from './web-reminders.ts'
