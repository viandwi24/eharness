/**
 * Turn principal helpers (internal): validation of `Principal` input, a detached copy and the
 * equality used to decide whether two inputs may share a turn.
 *
 * @see docs/specs/05-session-and-storage.md#23-turn-principal
 */
import type { Principal } from '../agent/session-types.ts'
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/util.ts'
import type { SessionRuntime } from './runtime.ts'

/** Largest serialized size of a `Principal` (identifiers only; never secrets). */
export const MAX_PRINCIPAL_BYTES: number = 2 * 1024

function jsonProblem(value: unknown, depth: number): string | undefined {
  if (depth > 8) return 'is nested deeper than 8 levels'
  if (value === null || value === undefined) return undefined
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : 'holds a number that is not finite'
    case 'object': {
      if (Array.isArray(value)) {
        for (const item of value) {
          const problem = jsonProblem(item, depth + 1)
          if (problem !== undefined) return problem
        }
        return undefined
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return 'holds a non-plain object'
      for (const item of Object.values(value as Record<string, unknown>)) {
        const problem = jsonProblem(item, depth + 1)
        if (problem !== undefined) return problem
      }
      return undefined
    }
    default:
      return `holds a ${typeof value}, which is not JSON`
  }
}

/**
 * Why `value` is not a usable `Principal` (a non-empty string `id`, JSON values only, at most
 * {@link MAX_PRINCIPAL_BYTES} serialized), or `undefined` when it is.
 */
export function principalProblem(value: unknown): string | undefined {
  if (!isRecord(value) || Array.isArray(value)) return 'must be a plain object'
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return 'must be a plain object'
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return 'needs a non-empty string `id`'
  }
  if (value.id.includes('\u0000') || value.id.includes('\u001f')) {
    return 'has an `id` with a U+0000 or U+001F character (they separate grant keys)'
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    return 'has a `name` that is not a string'
  }
  const problem = jsonProblem(value, 0)
  if (problem !== undefined) return `${problem}`
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PRINCIPAL_BYTES) {
    return `is larger than ${MAX_PRINCIPAL_BYTES} bytes serialized`
  }
  return undefined
}

/** The `EH_INVALID_INPUT` error of an invalid principal (`where` names the option). */
export function principalError(where: string, problem: string): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', `${where}: a principal ${problem}.`, {
    details: { reason: 'principal' },
  })
}

/** A detached JSON copy of a principal that passed {@link principalProblem}. */
export function clonePrincipal(value: Principal): Principal {
  return JSON.parse(JSON.stringify(value)) as Principal
}

/** True when the value is a valid principal (never throws; for payloads of unknown origin). */
export function isPrincipal(value: unknown): value is Principal {
  return principalProblem(value) === undefined
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** Whether two principals are the same value (both absent counts as the same). */
export function samePrincipal(a: Principal | undefined, b: Principal | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return stable(a) === stable(b)
}

/**
 * `ctx.principal` of a session: the running turn's, else the stored session default (the first
 * open with one wins), else this handle's own option, else `undefined`.
 */
export function principalOf(rt: SessionRuntime): Principal | undefined {
  return rt.turn?.principal ?? rt.state.core().principal ?? rt.options.principal
}
