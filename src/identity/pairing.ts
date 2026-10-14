/**
 * Pairing codes and a failure limiter. Codes are 8 characters of an unambiguous alphabet and are
 * stored only as SHA-256 hashes.
 *
 * @see docs/specs/30-identity.md#4-pairing
 */

/** No 0/O, 1/I/L. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8
export const MAX_PENDING_CODES = 3
export const DEFAULT_CODE_TTL_MS = 3_600_000

/** A fresh random code (rejection sampling: no modulo bias). */
export function generatePairingCode(): string {
  const limit = 256 - (256 % PAIRING_ALPHABET.length)
  let out = ''
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < PAIRING_CODE_LENGTH)
        out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]
    }
  }
  return out
}

/** A code as people type it: upper case, no spaces or dashes. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '')
}

/** Hex SHA-256 of the normalized code. */
export async function hashPairingCode(code: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalizePairingCode(code)),
  )
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface PairingGuardOptions {
  /** Failures allowed inside the window before lockout. Default 5. */
  maxFailures?: number
  /** Window in ms. Default one hour. */
  windowMs?: number
}

/** In-memory failure limiter keyed by account (e.g. `telegram:123`). */
export interface PairingGuard {
  /** False while the key is locked out. */
  allowed(key: string, now: number): boolean
  /** Count a failed redeem. */
  failure(key: string, now: number): void
  /** Forget the key (after a successful redeem). */
  success(key: string): void
}

export function pairingGuard(options: PairingGuardOptions = {}): PairingGuard {
  const maxFailures = options.maxFailures ?? 5
  const windowMs = options.windowMs ?? 3_600_000
  const failures = new Map<string, number[]>()
  const recent = (key: string, now: number): number[] => {
    const list = (failures.get(key) ?? []).filter((t) => now - t < windowMs)
    if (list.length === 0) failures.delete(key)
    else failures.set(key, list)
    return list
  }
  return {
    allowed: (key, now) => recent(key, now).length < maxFailures,
    failure(key, now) {
      const list = recent(key, now)
      list.push(now)
      failures.set(key, list)
    },
    success(key) {
      failures.delete(key)
    },
  }
}
