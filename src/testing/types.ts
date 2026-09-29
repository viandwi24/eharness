/**
 * One named case of a conformance suite. Runner-agnostic: register it with any test runner.
 *
 * @example
 * ```ts
 * for (const c of idGeneratorConformance(() => uuidv7)) test(c.name, c.run)
 * ```
 * @see docs/engineering/testing.md#conformance-suites-public-in-eharnesstesting
 */
export interface ConformanceCase {
  /** Human-readable case name. */
  name: string
  /** Runs the case; rejects (throws) on failure. */
  run: () => Promise<void>
}
