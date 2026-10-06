import { describe, expect, test } from 'bun:test'
import * as core from './index.ts'

describe('core entry', () => {
  test('exports a semver version', () => {
    expect(core.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('HarnessError carries its code', () => {
    const error = new core.HarnessError('EH_CONFIG_INVALID', 'bad config')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('EH_CONFIG_INVALID')
    expect(error.name).toBe('HarnessError')
  })

  test('runtime exports', () => {
    expect(Object.keys(core).sort()).toEqual([
      'CLIENT_TOOL_TIMED_OUT',
      'DENIED_NEW_INPUT',
      'FILE_UNAVAILABLE',
      'FINAL_ANSWER_DESCRIPTION',
      'FINAL_ANSWER_RECORDED',
      'FLUSH_APPROVAL_DENIED',
      'HarnessError',
      'HarnessToolError',
      'INTERRUPTED_CRASH',
      'INTERRUPTED_TURN',
      'INTERRUPTED_UNKNOWN',
      'MAX_STEPS_WRAP_UP',
      'NOT_EXECUTED_NEW_INPUT',
      'OUTPUT_INSTRUCTION',
      'OUTPUT_RETRY',
      'PAGE_CONTEXT_PREAMBLE',
      'PROGRESS_NUDGE',
      'TOOL_OUTPUT_PRUNED',
      'TOOL_OUTPUT_TRUNCATED',
      'WAIT_CANCELLED_NEW_INPUT',
      'WAIT_TIMED_OUT',
      'computeCost',
      'createKindMessage',
      'defineDataPart',
      'defineHarnessAgent',
      'defineMessageKind',
      'definePlugin',
      'defineSkill',
      'defineSkillSource',
      'defineToolSource',
      'estimateStepCostUsd',
      'externalTool',
      'handleChatRequest',
      'isHarnessError',
      'isKindMessage',
      'isUuidV7',
      'lookupModel',
      'modelsDevCatalog',
      'neutralizeTags',
      'parseSkillMarkdown',
      'toolTraits',
      'uuidv7',
      'validateSkillPath',
      'version',
    ])
  })
})
