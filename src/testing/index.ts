/**
 * `eharness/testing`: runner-agnostic conformance suites and test helpers.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * **Stable:** accepted API; changes follow docs/engineering/api-stability.md.
 *
 * @see docs/engineering/testing.md
 */

export {
  type ActivityStoreConformanceOptions,
  type ActivityStoreUnderTest,
  activityStoreConformance,
} from './activity-store.conformance.ts'
export { browserProfileStoreConformance } from './browser.conformance.ts'
export {
  FAKE_PASS,
  type FakeCdpPeer,
  type FakeCdpPeerOptions,
  fakeCdpError,
  fakeCdpPeer,
} from './browser-fake-peer.ts'
export {
  type BudgetLedgerConformanceOptions,
  budgetLedgerConformance,
} from './budget-ledger.conformance.ts'
export {
  type OutboxStoreUnderTest,
  outboxStoreConformance,
} from './channels.conformance.ts'
export {
  type ConnectionStoreUnderTest,
  type CredentialStoreUnderTest,
  connectionStoreConformance,
  credentialStoreConformance,
  type EnablementStoreUnderTest,
  enablementStoreConformance,
  type FlowStoreUnderTest,
  flowStoreConformance,
} from './connectors.conformance.ts'
export {
  type FileSystemConformanceOptions,
  type FileSystemUnderTest,
  fileSystemConformance,
} from './file-system.conformance.ts'
export { handoffStoreConformance } from './handoff.conformance.ts'
export {
  type HttpConformanceOptions,
  type HttpUnderTest,
  httpConformance,
} from './http.conformance.ts'
export {
  type IdGeneratorConformanceOptions,
  idGeneratorConformance,
} from './id-generator.conformance.ts'
export {
  type PersonStoreUnderTest,
  personStoreConformance,
} from './identity.conformance.ts'
export {
  type InboxAdapterConformanceOptions,
  inboxAdapterConformance,
} from './inbox-adapter.conformance.ts'
export {
  type LockConformanceOptions,
  type LockUnderTest,
  lockConformance,
} from './lock.conformance.ts'
export {
  type MessageAdapterConformanceOptions,
  messageAdapterConformance,
} from './message-adapter.conformance.ts'
export {
  type MultiInstanceConformanceOptions,
  type MultiInstanceStorage,
  multiInstanceConformance,
} from './multi-instance.conformance.ts'
export {
  type ProfileStoreConformanceOptions,
  type ProfileStoreUnderTest,
  profileStoreConformance,
} from './profile-store.conformance.ts'
export { scheduleStoreConformance } from './scheduler.conformance.ts'
export { assertValidUIMessage, schemaCheckedMessages } from './schema-checked-messages.ts'
export {
  type ScriptedCallOptions,
  type ScriptedFinishReason,
  type ScriptedModel,
  type ScriptedModelOptions,
  type ScriptedPrompt,
  type ScriptedStep,
  type ScriptedStepInput,
  type ScriptedStreamPart,
  scriptedModel,
} from './scripted-model.ts'
export {
  type ScriptedProviderDefinition,
  type ScriptedProviderOptions,
  scriptedProvider,
} from './scripted-provider.ts'
export {
  assertStoredSessionInvariants,
  type StoredSessionInvariantOptions,
} from './session-invariants.ts'
export {
  SKILL_SOURCE_FIXTURE,
  type SkillSourceConformanceOptions,
  skillSourceConformance,
} from './skill-source.conformance.ts'
export {
  type StateAdapterConformanceOptions,
  stateAdapterConformance,
} from './state-adapter.conformance.ts'
export {
  type StreamLogConformanceOptions,
  streamLogConformance,
} from './stream-log.conformance.ts'
export type { ConformanceCase } from './types.ts'
