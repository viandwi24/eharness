import { isUuidV7 } from '../index.ts'
import type { ConformanceCase } from './types.ts'

/** Options of {@link idGeneratorConformance}. */
export interface IdGeneratorConformanceOptions {
  /** Require UUIDv7 formatted ids. Default true (set false for other time-sortable formats). */
  uuidv7?: boolean
  /**
   * The generator accepts a `floor` argument (the newest known id) and must return an id that
   * sorts after it (spec 03 §8). Default false.
   */
  floor?: boolean
  /** Number of ids generated in the tight loop. Default 10_000. */
  count?: number
}

/**
 * Conformance cases for a message/turn id generator (`config.generateId`).
 *
 * Checks that ids generated in a tight loop are unique and strictly increasing in string order,
 * are well formed, and (optionally) respect a per-session floor.
 *
 * @example
 * ```ts
 * import { idGeneratorConformance } from 'eharness/testing'
 * for (const c of idGeneratorConformance(() => myGenerateId)) test(c.name, c.run)
 * ```
 * @see docs/specs/03-messages.md#8-ids
 */
export function idGeneratorConformance(
  factory: () => (floor?: string) => string,
  options: IdGeneratorConformanceOptions = {},
): ConformanceCase[] {
  const count = options.count ?? 10_000
  const cases: ConformanceCase[] = [
    {
      name: `${count} ids in a tight loop are strictly increasing`,
      run: async () => {
        const generate = factory()
        let previous = generate()
        for (let i = 1; i < count; i++) {
          const id = generate()
          if (!(id > previous)) {
            throw new Error(`id #${i} '${id}' does not sort after '${previous}'`)
          }
          previous = id
        }
      },
    },
    {
      name: 'ids are non-empty strings',
      run: async () => {
        const id = factory()()
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error(`expected a non-empty string, got ${JSON.stringify(id)}`)
        }
      },
    },
  ]
  if (options.uuidv7 !== false) {
    cases.push({
      name: 'ids are lowercase UUIDv7',
      run: async () => {
        const generate = factory()
        for (let i = 0; i < 100; i++) {
          const id = generate()
          if (!isUuidV7(id)) throw new Error(`'${id}' is not a lowercase UUIDv7`)
        }
      },
    })
    cases.push({
      name: 'id timestamp is close to the current time',
      run: async () => {
        const before = Date.now()
        const id = factory()()
        const after = Date.now()
        const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
        if (ms < before - 1000 || ms > after + 1000) {
          throw new Error(`timestamp ${ms} of '${id}' is not within [${before}, ${after}]`)
        }
      },
    })
  }
  if (options.floor === true) {
    cases.push({
      name: 'an id generated with a future floor sorts after the floor',
      run: async () => {
        const generate = factory()
        const future = Date.now() + 60 * 60 * 1000
        const hexMs = future.toString(16).padStart(12, '0')
        const floor = `${hexMs.slice(0, 8)}-${hexMs.slice(8)}-7fff-bfff-ffffffffffff`
        const id = generate(floor)
        if (!(id > floor)) throw new Error(`'${id}' does not sort after floor '${floor}'`)
        const next = generate()
        if (!(next > id))
          throw new Error(`'${next}' after a floor bump does not sort after '${id}'`)
      },
    })
    cases.push({
      name: 'a past floor does not change the timestamp',
      run: async () => {
        const generate = factory()
        const floor = '00000000-0001-7000-8000-000000000000'
        const before = Date.now()
        const id = generate(floor)
        const ms = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
        if (!(id > floor) || ms < before - 1000) {
          throw new Error(`'${id}' was bumped by a past floor`)
        }
      },
    })
  }
  return cases
}
