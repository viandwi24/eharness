/** HMAC-signed, expiring content URL tokens (Web Crypto only). */

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export const randomToken = (bytes = 16): string =>
  b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export interface Signer {
  /** `<exp>.<sig>` for the payload, valid until `exp` (epoch ms, base36 in the token). */
  sign(payload: string, exp: number): Promise<string>
  /** True when the token matches the payload and has not expired. */
  verify(payload: string, token: string, now: number): Promise<boolean>
}

export function createSigner(secret: string): Signer {
  const key = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = async (message: string): Promise<string> =>
    b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(message))))
  return {
    async sign(payload, exp) {
      return `${exp.toString(36)}.${await mac(`${payload}|${exp}`)}`
    },
    async verify(payload, token, now) {
      const dot = token.indexOf('.')
      if (dot < 1) return false
      const exp = Number.parseInt(token.slice(0, dot), 36)
      if (!Number.isFinite(exp) || exp < now) return false
      const expected = await mac(`${payload}|${exp}`)
      const given = token.slice(dot + 1)
      // constant-time compare
      let diff = expected.length ^ given.length
      for (let i = 0; i < Math.max(expected.length, given.length); i++) {
        diff |= (expected.charCodeAt(i) || 0) ^ (given.charCodeAt(i) || 0)
      }
      return diff === 0
    },
  }
}
