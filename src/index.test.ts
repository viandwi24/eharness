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
      'DENIED_NEW_INPUT',
      'HarnessError',
      'HarnessToolError',
      'INTERRUPTED_CRASH',
      'INTERRUPTED_TURN',
      'INTERRUPTED_UNKNOWN',
      'NOT_EXECUTED_NEW_INPUT',
      'TOOL_OUTPUT_TRUNCATED',
      'createKindMessage',
      'defineDataPart',
      'defineHarnessAgent',
      'defineMessageKind',
      'definePlugin',
      'defineToolSource',
      'isHarnessError',
      'isKindMessage',
      'isUuidV7',
      'uuidv7',
      'version',
    ])
  })
})
