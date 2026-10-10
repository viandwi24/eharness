/** Errors the use cases raise; the HTTP layer maps `kind` to a status. */
export type DomainErrorKind = 'invalid' | 'not_found' | 'conflict' | 'forbidden'

export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string
  /** Machine-readable extra data returned as `error.details` (e.g. the current version). */
  readonly details: unknown
  constructor(kind: DomainErrorKind, code: string, message: string, details?: unknown) {
    super(message)
    this.details = details
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
  }
}

export const invalid = (message: string, code = 'INVALID'): DomainError =>
  new DomainError('invalid', code, message)
export const notFound = (what: string, id: string): DomainError =>
  new DomainError('not_found', 'NOT_FOUND', `${what} not found: ${id}`)
export const conflict = (message: string, code = 'CONFLICT', details?: unknown): DomainError =>
  new DomainError('conflict', code, message, details)

/** A 409 for removing something that is still used (`PROFILE_IN_USE` style). */
export function inUse(
  noun: string,
  id: string,
  users: readonly string[],
  code: string,
  details: Record<string, unknown> = {},
): DomainError {
  return conflict(
    `${noun} "${id}" is still used by ${users.join(', ')}: pick another one there first`,
    code,
    details,
  )
}
