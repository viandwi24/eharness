/**
 * `eharness/testing`: runner-agnostic conformance suites and test helpers.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 *
 * @see docs/engineering/testing.md
 */

export {
  type IdGeneratorConformanceOptions,
  idGeneratorConformance,
} from './id-generator.conformance.ts'
export type { ConformanceCase } from './types.ts'
