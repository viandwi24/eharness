/**
 * Tiny runner-agnostic assertion helpers for the conformance suites (internal to
 * `eharness/testing`).
 */

/** JSON with object keys sorted recursively (key order is irrelevant, e.g. Postgres `jsonb`). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Throw when `actual` and `expected` are not JSON deep-equal (ignoring object key order). */
export function assertJsonEqual(actual: unknown, expected: unknown, what: string): void {
  const a = canonicalJson(actual)
  const e = canonicalJson(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

/** Throw with `message` when `condition` is false. */
export function assertTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** A session id that does not collide with other cases (adapters may share one store). */
export function uniqueSessionId(prefix: string): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
