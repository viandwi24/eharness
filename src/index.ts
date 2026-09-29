/**
 * eharness core API.
 *
 * Placeholder entry point created in P0 (bootstrap). The real surface lands in P1+.
 * @see docs/architecture.md#2-package--exports
 */

/** Package version of this build. */
export const version: string = '0.0.1'

/**
 * Error thrown by eharness for programmer and configuration errors.
 *
 * Stub created in P0; the full error model (codes, `details`, `isHarnessError`) lands in P1.
 * @see docs/specs/10-errors-and-stop-reasons.md#1-errors-thrown
 */
export class HarnessError extends Error {
  /** Stable machine-readable error code (`EH_*`). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
  }
}
