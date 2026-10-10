/**
 * Encryption of provider secrets at rest: AES-256-GCM through `crypto.subtle` (Web API only).
 *
 * A sealed value is `v1:<keyId>:<iv base64url>:<ciphertext base64url>`. The key id is the first
 * 8 hex characters of the SHA-256 of the key, so a ring of keys can rotate: new values use the
 * first (current) key, old values open with whichever key carries their id.
 *
 * Keys come from `TEAM_SECRET_KEY` (32 bytes, base64; generate one with
 * `openssl rand -base64 32`). `TEAM_SECRET_KEY_PREVIOUS` (comma separated) keeps old keys that can
 * still open rows during a rotation. Without `TEAM_SECRET_KEY` the server derives a dev key and
 * persists it next to the database (`secret.key`, git-ignored) with a loud warning; an in-memory
 * database gets a throwaway key.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PREFIX = 'v1'

/** What the profile store needs of a box. */
export type SealOpen = Pick<SecretBox, 'seal' | 'open'>

/** A box created on first use (no key file, no warning for servers that never store a profile). */
export function lazySecretBox(create: () => Promise<SecretBox>): SealOpen {
  let box: Promise<SecretBox> | undefined
  const get = (): Promise<SecretBox> => {
    box ??= create()
    return box
  }
  return {
    seal: async (plain) => (await get()).seal(plain),
    open: async (sealed) => (await get()).open(sealed),
  }
}

export interface SecretBox {
  /** Id of the key new values are sealed with. */
  readonly keyId: string
  seal(plain: string): Promise<string>
  /** Throws when the value is malformed, its key is unknown, or it was tampered with. */
  open(sealed: string): Promise<string>
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, 'base64url'))

async function importKey(raw: Uint8Array<ArrayBuffer>): Promise<{ id: string; key: CryptoKey }> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  const id = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { id, key }
}

/** Decode a base64 key; throws a readable error unless it is exactly 32 bytes. */
export function parseSecretKey(text: string, name = 'TEAM_SECRET_KEY'): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Buffer.from(text.trim(), 'base64'))
  if (bytes.length !== 32) {
    throw new Error(`${name} must be 32 bytes, base64 encoded (openssl rand -base64 32)`)
  }
  return bytes
}

export function generateSecretKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

/** A box over a key ring: `keys[0]` seals, every key opens. */
export async function createSecretBox(
  keys: readonly Uint8Array<ArrayBuffer>[],
): Promise<SecretBox> {
  if (keys.length === 0) throw new Error('at least one secret key is needed')
  const ring = await Promise.all(keys.map(importKey))
  const current = ring[0] as { id: string; key: CryptoKey }
  const byId = new Map(ring.map((k) => [k.id, k.key]))
  return {
    keyId: current.id,
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          current.key,
          new TextEncoder().encode(plain),
        ),
      )
      return `${PREFIX}:${current.id}:${b64(iv)}:${b64(data)}`
    },
    async open(sealed) {
      const [version, keyId, iv, data, extra] = sealed.split(':')
      if (version !== PREFIX || !keyId || !iv || !data || extra !== undefined) {
        throw new Error('stored secret is not in the expected format')
      }
      const key = byId.get(keyId)
      if (key === undefined) {
        throw new Error(
          `stored secret was sealed with key ${keyId}, which is not configured (TEAM_SECRET_KEY / TEAM_SECRET_KEY_PREVIOUS)`,
        )
      }
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(iv) },
          key,
          unb64(data),
        )
        return new TextDecoder().decode(plain)
      } catch {
        throw new Error('stored secret could not be decrypted (wrong key or corrupted data)')
      }
    },
  }
}

export interface SecretBoxOptions {
  env?: Record<string, string | undefined>
  /** Folder of the database file; the dev key lives there. Absent (`:memory:`) = a throwaway key. */
  dataDir?: string | undefined
  warn?: (message: string) => void
}

/**
 * The box of this server: `TEAM_SECRET_KEY` (+ `TEAM_SECRET_KEY_PREVIOUS`), else the persisted dev
 * key, else a throwaway key. A malformed key is a boot error.
 */
export async function secretBoxFromEnv(options: SecretBoxOptions = {}): Promise<SecretBox> {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(m))
  const previous = (env.TEAM_SECRET_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => parseSecretKey(s, 'TEAM_SECRET_KEY_PREVIOUS'))
  const configured = env.TEAM_SECRET_KEY?.trim()
  if (configured) return createSecretBox([parseSecretKey(configured), ...previous])

  if (options.dataDir === undefined) {
    warn(
      'warning: TEAM_SECRET_KEY is not set and the database is in memory: provider secrets use a throwaway key and are lost on exit',
    )
    return createSecretBox([parseSecretKey(generateSecretKey()), ...previous])
  }
  const file = join(options.dataDir, 'secret.key')
  let text: string
  if (existsSync(file)) text = readFileSync(file, 'utf8')
  else {
    text = generateSecretKey()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${text}\n`, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // best effort (some file systems)
    }
  }
  warn(
    `WARNING: TEAM_SECRET_KEY is not set: provider secrets are encrypted with a dev key stored in ${file}. ` +
      'Anyone who can read that file and the database can read the secrets. Set TEAM_SECRET_KEY (openssl rand -base64 32) outside development. Never commit this file.',
  )
  return createSecretBox([parseSecretKey(text, file), ...previous])
}
