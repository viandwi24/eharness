/** Errors the use cases raise; the HTTP layer maps `kind` to a status. */
export type DomainErrorKind = 'invalid' | 'not_found' | 'conflict' | 'forbidden'

export class DomainError extends Error {
  readonly kind: DomainErrorKind
  readonly code: string
  constructor(kind: DomainErrorKind, code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.kind = kind
    this.code = code
  }
}

export const invalid = (message: string, code = 'INVALID'): DomainError =>
  new DomainError('invalid', code, message)
export const notFound = (what: string, id: string): DomainError =>
  new DomainError('not_found', 'NOT_FOUND', `${what} not found: ${id}`)
export const conflict = (message: string, code = 'CONFLICT'): DomainError =>
  new DomainError('conflict', code, message)
