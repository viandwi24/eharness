/**
 * `SecretVault`: the generic port that encrypts secrets at rest (provider profiles, connection
 * settings, OAuth credentials, flow scratch), plus an AES-GCM vault over Web Crypto and a
 * plaintext one for tests.
 *
 * @see docs/specs/23-providers.md#8-sealing-secrets-at-rest
 */
import { HarnessError } from '../index.ts'
import type { SecretVault } from './types.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function fail(reason: string, message: string): HarnessError {
  return new HarnessError('EH_CONFIG_INVALID', message, { details: { reason } })
}

function b64u(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64u(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Keys of {@link webCryptoVault}: one raw key, or several with the id used for new seals. */
export type VaultKeys = Uint8Array | { keys: Record<string, Uint8Array>; current: string }

/**
 * A vault over AES-256-GCM (`crypto.subtle`). Keys are 32 raw bytes (from your secret manager).
 * Each seal uses a fresh random IV and authenticates `context`, so a blob cannot be replayed for
 * another row or flow. Output: `v2.<keyId>.<base64url(iv || ciphertext)>`. For **rotation** pass
 * several keys and the id of the current one: old blobs still open, `needsReseal` reports blobs
 * sealed with another key (see `sealedProfileStore().reseal()`).
 */
export function webCryptoVault(keys: VaultKeys): SecretVault {
  const table: Record<string, Uint8Array> =
    keys instanceof Uint8Array ? { k0: keys } : { ...keys.keys }
  const current = keys instanceof Uint8Array ? 'k0' : keys.current
  for (const [id, key] of Object.entries(table)) {
    if (key.byteLength !== 32)
      throw fail('vault-key', `webCryptoVault: key '${id}' must be 32 bytes (AES-256).`)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
      throw fail('vault-key', 'webCryptoVault: invalid key id.')
  }
  if (table[current] === undefined)
    throw fail('vault-key', 'webCryptoVault: the current key is missing.')
  const imported = new Map<string, Promise<CryptoKey>>()
  const cryptoKey = (id: string): Promise<CryptoKey> => {
    let p = imported.get(id)
    if (p === undefined) {
      p = crypto.subtle.importKey('raw', (table[id] as Uint8Array).slice(), 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ])
      imported.set(id, p)
    }
    return p
  }
  return {
    keyId: current,
    async seal(plaintext, context) {
      const iv = new Uint8Array(12)
      crypto.getRandomValues(iv)
      const cipher = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
          await cryptoKey(current),
          encoder.encode(plaintext),
        ),
      )
      const out = new Uint8Array(iv.length + cipher.length)
      out.set(iv)
      out.set(cipher, iv.length)
      return `v2.${current}.${b64u(out)}`
    },
    async open(sealed, context) {
      const [tag, id, body] = sealed.split('.')
      if (tag !== 'v2' || id === undefined || body === undefined || table[id] === undefined) {
        throw fail('vault-open', 'The sealed value is not valid or its key is unknown.')
      }
      try {
        const bytes = fromB64u(body)
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) },
          await cryptoKey(id),
          bytes.slice(12),
        )
        return decoder.decode(plain)
      } catch {
        throw fail('vault-open', 'The sealed value could not be opened.')
      }
    },
    needsReseal: (sealed) => !sealed.startsWith(`v2.${current}.`),
  }
}

/**
 * A vault that does not encrypt (base64url with the context bound). **Tests only**: whatever is
 * kept with it is readable by whoever can read the store.
 */
export function plaintextVault(): SecretVault {
  return {
    keyId: 'plain',
    seal: async (plaintext, context) =>
      `plain.${b64u(encoder.encode(context))}.${b64u(encoder.encode(plaintext))}`,
    open: async (sealed, context) => {
      const [tag, ctx, body] = sealed.split('.')
      if (tag !== 'plain' || ctx === undefined || body === undefined) {
        throw fail('vault-open', 'The sealed value is not valid.')
      }
      if (decoder.decode(fromB64u(ctx)) !== context) {
        throw fail('vault-open', 'The sealed value could not be opened.')
      }
      return decoder.decode(fromB64u(body))
    },
    needsReseal: () => false,
  }
}

/** Reads blobs of an older sealing format (see {@link withLegacyVault}). */
export interface LegacyOpener {
  /** True for blobs this opener understands (by their prefix). */
  matches(sealed: string): boolean
  /** Open a legacy blob; reject when it cannot be opened. */
  open(sealed: string, context: string): Promise<string>
}

/**
 * Read an older sealing format, write the current one. `open` routes legacy blobs to `legacy`,
 * everything else to `vault`; `seal` always uses `vault`; `needsReseal` is true for legacy blobs
 * (and whatever `vault` flags), so `sealedProfileStore().reseal()` migrates them in place.
 * Use it when an app moves from its own secret box to {@link webCryptoVault}.
 */
export function withLegacyVault(vault: SecretVault, legacy: LegacyOpener): SecretVault {
  return {
    ...(vault.keyId === undefined ? {} : { keyId: vault.keyId }),
    seal: (plaintext, context) => vault.seal(plaintext, context),
    open: (sealed, context) =>
      legacy.matches(sealed) ? legacy.open(sealed, context) : vault.open(sealed, context),
    needsReseal: (sealed) => legacy.matches(sealed) || vault.needsReseal?.(sealed) === true,
  }
}
