/**
 * Library configuration errors (`EH_CONFIG_INVALID` with a `details.reason`) as the app's domain
 * errors: ONE mapping for provider profiles and connections.
 */
import { conflict, DomainError, notFound } from '../../domain/errors.ts'

export interface ConfigErrorNames {
  /** What the row is called in messages (`provider profile`, `connection`). */
  noun: string
  /** `details` key that holds the id of a missing row. */
  idKey: string
  /** `reason` values that mean "no such row". */
  notFoundReasons: readonly string[]
  /** `reason` -> 409 code (`read-only` -> `READ_ONLY_PROFILE`). */
  conflicts?: Readonly<Record<string, string>>
}

/** Rethrow `error` as a {@link DomainError} when it is a configuration error; never returns. */
export function mapConfigError(error: unknown, names: ConfigErrorNames): never {
  if (error instanceof DomainError) throw error
  const e = error as { code?: unknown; message?: string; details?: Record<string, unknown> }
  if (e?.code === 'EH_CONFIG_INVALID') {
    const reason = String(e.details?.reason ?? 'invalid')
    const message = e.message ?? `invalid ${names.noun} configuration`
    if (names.notFoundReasons.includes(reason)) {
      throw notFound(names.noun, String(e.details?.[names.idKey] ?? ''))
    }
    const code = names.conflicts?.[reason]
    if (code !== undefined) throw conflict(message, code)
    throw new DomainError('invalid', reason.toUpperCase().replaceAll('-', '_'), message, e.details)
  }
  throw error
}
