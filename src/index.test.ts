import { describe, expect, test } from 'bun:test'
import { HarnessError, version } from './index.ts'

describe('core entry', () => {
  test('exports a semver version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('HarnessError carries its code', () => {
    const error = new HarnessError('EH_CONFIG_INVALID', 'bad config')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('EH_CONFIG_INVALID')
    expect(error.name).toBe('HarnessError')
  })
})
