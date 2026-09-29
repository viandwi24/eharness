import { describe, expect, test } from 'bun:test'
import { idGeneratorConformance } from '../testing/index.ts'
import { createUuidV7Generator, isUuidV7, nextId, uuidV7Timestamp, uuidv7 } from './ids.ts'

describe('idGeneratorConformance: default generator', () => {
  for (const c of idGeneratorConformance(() => createUuidV7Generator(), { floor: true })) {
    test(c.name, c.run)
  }
})

describe('idGeneratorConformance: uuidv7 export', () => {
  for (const c of idGeneratorConformance(() => uuidv7)) test(c.name, c.run)
})

describe('UUIDv7', () => {
  test('format and timestamp', () => {
    const before = Date.now()
    const id = createUuidV7Generator()()
    expect(isUuidV7(id)).toBe(true)
    const ms = uuidV7Timestamp(id) ?? 0
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(Date.now())
  })

  test('isUuidV7 rejects other strings', () => {
    expect(isUuidV7('0192f1c3-7c1e-4a3b-9f10-5d2b1c9e4a77')).toBe(false) // v4
    expect(isUuidV7('0192F1C3-7C1E-7A3B-9F10-5D2B1C9E4A77')).toBe(false) // uppercase
    expect(isUuidV7('0192f1c3-7c1e-7a3b-cf10-5d2b1c9e4a77')).toBe(false) // variant 11
    expect(isUuidV7('not-an-id')).toBe(false)
    expect(uuidV7Timestamp('nope')).toBeUndefined()
  })

  test('same millisecond ids use the counter and stay ordered', () => {
    const generate = createUuidV7Generator({ now: () => 1_790_000_000_000 })
    const ids = Array.from({ length: 5000 }, () => generate())
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
    expect(new Set(ids).size).toBe(ids.length)
    // counter overflow bumps the timestamp forward, never backwards
    expect(uuidV7Timestamp(ids.at(-1) ?? '')).toBeGreaterThan(1_790_000_000_000)
  })

  test('clock going backwards keeps ids increasing', () => {
    let clock = 1_790_000_000_000
    const generate = createUuidV7Generator({ now: () => clock })
    const a = generate()
    clock -= 10_000
    const b = generate()
    expect(b > a).toBe(true)
  })

  test('floor bump: timestamp = floor + 1 ms', () => {
    const generate = createUuidV7Generator({ now: () => 1_000 })
    const floorGen = createUuidV7Generator({ now: () => 5_000 })
    const floor = floorGen()
    const id = generate(floor)
    expect(id > floor).toBe(true)
    expect(uuidV7Timestamp(id)).toBe(5_001)
    // the bump does not leak: without a floor the generator uses its own clock again
    expect(uuidV7Timestamp(generate())).toBe(1_000)
    // with the session's newest id as floor, ids keep increasing
    expect(generate(id) > id).toBe(true)
  })

  test('non-UUIDv7 floors are ignored', () => {
    const generate = createUuidV7Generator({ now: () => 1_000 })
    expect(uuidV7Timestamp(generate('zzz'))).toBe(1_000)
  })

  test('nextId respects a floor without shifting the default generator', () => {
    const floor = createUuidV7Generator({ now: () => Date.now() + 10_000 })()
    expect(nextId(floor) > floor).toBe(true)
    expect(uuidv7() < floor).toBe(true)
  })
})
