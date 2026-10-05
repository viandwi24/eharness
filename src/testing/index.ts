/**
 * `eharness/testing`: runner-agnostic conformance suites and test helpers.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/engineering/testing.md
 */

export {
  type FileSystemConformanceOptions,
  type FileSystemUnderTest,
  fileSystemConformance,
} from './file-system.conformance.ts'
export {
  type IdGeneratorConformanceOptions,
  idGeneratorConformance,
} from './id-generator.conformance.ts'
export {
  type InboxAdapterConformanceOptions,
  inboxAdapterConformance,
} from './inbox-adapter.conformance.ts'
export {
  type MessageAdapterConformanceOptions,
  messageAdapterConformance,
} from './message-adapter.conformance.ts'
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
  SKILL_SOURCE_FIXTURE,
  type SkillSourceConformanceOptions,
  skillSourceConformance,
} from './skill-source.conformance.ts'
export {
  type StateAdapterConformanceOptions,
  stateAdapterConformance,
} from './state-adapter.conformance.ts'
export type { ConformanceCase } from './types.ts'
