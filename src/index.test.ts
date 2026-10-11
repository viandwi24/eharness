import { describe, expect, test } from 'bun:test'
import snapshot from '../scripts/exports.snapshot.json'
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

  test('runtime exports match the committed export snapshot', () => {
    // one list to maintain: `bun scripts/exports-snapshot.ts --write` (see src/exports.test.ts)
    expect(Object.keys(core).sort()).toEqual(snapshot.eharness)
  })
})
