/** Small shared helpers of `eharness/connectors` (Web APIs only). */
import { HarnessError } from '../index.ts'

export { base64url, fromBase64url } from '../providers/base64url.ts'

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/** SHA-256 of a string as bytes. */
export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** SHA-256 of a string as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `EH_CONFIG_INVALID` with `details.reason` (the module's single error shape). */
export function connectorError(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
  cause?: unknown,
): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', message, {
    details: { reason, ...details },
    ...(cause === undefined ? {} : { cause }),
  })
}

/** Lowercase `[a-z0-9-]` slug of at most `max` characters (`''` when nothing is left). */
export function slugify(text: string, max = 32): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}
