import { describe, expect, test } from 'bun:test'
import { byteLength, contentVersion } from './version.ts'

describe('contentVersion (spec 08 §1)', () => {
  test('is the SHA-1 hex of the UTF-8 content', async () => {
    expect(await contentVersion('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(await contentVersion('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    const unicode = await contentVersion('ø ✓ 🚀')
    expect(unicode).toMatch(/^[0-9a-f]{40}$/)
    expect(await contentVersion('ø ✓ 🚀')).toBe(unicode)
    expect(await contentVersion('ø ✓ 🚀 ')).not.toBe(unicode)
  })

  test('byteLength counts UTF-8 bytes', () => {
    expect(byteLength('')).toBe(0)
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('ø')).toBe(2)
    expect(byteLength('🚀')).toBe(4)
  })
})
