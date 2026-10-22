/**
 * Encryption of secrets at rest: ONE `SecretVault` (the library's `webCryptoVault`, AES-256-GCM,
 * blobs `v2.<keyId>.…`) for provider profiles, connections, their credentials and OAuth app
 * credentials. Rows written by earlier versions (`v1:<keyId>:<iv>:<ct>`, no bound context) still
 * open and are re-sealed by `reseal()` at boot (`compose`).
 *
 * Keys come from `TEAM_SECRET_KEY` (32 bytes, base64; generate one with
 * `openssl rand -base64 32`). `TEAM_SECRET_KEY_PREVIOUS` (comma separated) keeps old keys that can
 * still open rows during a rotation. The key id is the first 8 hex characters of the SHA-256 of
 * the key (the same ids the v1 blobs carry). Without `TEAM_SECRET_KEY` the server derives a dev
 * key and persists it next to the database (`secret.key`, git-ignored) with a loud warning; an
 * in-memory database gets a throwaway key. Keys are read on first use, so a server that never
 * stores a secret never creates a key file.
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type SecretVault, webCryptoVault } from 'eharness/providers'
import { type LegacyOpener, withLegacyVault } from './legacy-vault.ts'

const LEGACY_PREFIX = 'v1:'

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

const keyIdOf = (key: Uint8Array): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 8)

const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, 'base64url'))

/** Opens `v1:<keyId>:<iv>:<ciphertext>` blobs of the earlier secret box. */
function legacyV1Opener(keys: readonly Uint8Array<ArrayBuffer>[]): LegacyOpener {
  const byId = new Map<string, Promise<CryptoKey>>()
  for (const key of keys) {
    byId.set(keyIdOf(key), crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']))
  }
  const fail = (message: string): Error => new Error(message)
  return {
    matches: (sealed) => sealed.startsWith(LEGACY_PREFIX),
    async open(sealed, context) {
      const [version, keyId, iv, data, extra] = sealed.split(':')
      if (version !== 'v1' || !keyId || !iv || !data || extra !== undefined) {
        throw fail('stored secret is not in the expected format')
      }
      const key = await byId.get(keyId)
      if (key === undefined) {
        throw fail(
          `stored secret was sealed with key ${keyId}, which is not configured (TEAM_SECRET_KEY / TEAM_SECRET_KEY_PREVIOUS)`,
        )
      }
      let plain: string
      try {
        plain = new TextDecoder().decode(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data)),
        )
      } catch {
        throw fail('stored secret could not be decrypted (wrong key or corrupted data)')
      }
      // connection rows carried `{ c: context, p: plaintext }`; provider rows the plain settings
      try {
        const wrapped = JSON.parse(plain) as { c?: unknown; p?: unknown }
        if (typeof wrapped === 'object' && wrapped !== null && 'c' in wrapped && 'p' in wrapped) {
          if (wrapped.c !== context || typeof wrapped.p !== 'string') {
            throw fail('stored secret does not belong to this row')
          }
          return wrapped.p
        }
      } catch (error) {
        if (error instanceof SyntaxError) return plain
        throw error
      }
      return plain
    },
  }
}

/** A vault over a key ring: `keys[0]` seals, every key opens (v2 and the legacy v1 blobs). */
export function teamVault(keys: readonly Uint8Array<ArrayBuffer>[]): SecretVault {
  if (keys.length === 0) throw new Error('at least one secret key is needed')
  const table: Record<string, Uint8Array> = {}
  for (const key of keys) table[keyIdOf(key)] = key
  const current = keyIdOf(keys[0] as Uint8Array)
  return withLegacyVault(webCryptoVault({ keys: table, current }), legacyV1Opener(keys))
}

export interface TeamVaultOptions {
  env?: Record<string, string | undefined>
  /** Folder of the database file; the dev key lives there. Absent (`:memory:`) = a throwaway key. */
  dataDir?: string | undefined
  warn?: (message: string) => void
}

/** The key ring of this server (see the file comment). A malformed key throws. */
export function secretKeysFromEnv(options: TeamVaultOptions = {}): Uint8Array<ArrayBuffer>[] {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(m))
  const previous = (env.TEAM_SECRET_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => parseSecretKey(s, 'TEAM_SECRET_KEY_PREVIOUS'))
  const configured = env.TEAM_SECRET_KEY?.trim()
  if (configured) {
    return withKeyFileFallback(
      [parseSecretKey(configured), ...previous],
      options.dataDir === undefined ? undefined : join(options.dataDir, 'secret.key'),
      'TEAM_SECRET_KEY',
      warn,
    )
  }

  if (options.dataDir === undefined) {
    warn(
      'warning: TEAM_SECRET_KEY is not set and the database is in memory: secrets use a throwaway key and are lost on exit',
    )
    return [parseSecretKey(generateSecretKey()), ...previous]
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
    `WARNING: TEAM_SECRET_KEY is not set: secrets are encrypted with a dev key stored in ${file}. ` +
      'Anyone who can read that file and the database can read the secrets. Set TEAM_SECRET_KEY (openssl rand -base64 32) outside development. Never commit this file.',
  )
  return [parseSecretKey(text, file), ...previous]
}

/**
 * The vault of this server, created on first use (a malformed key then throws from `seal` /
 * `open`; call {@link secretKeysFromEnv} at boot to fail early). `needsReseal` never needs keys
 * for v1 blobs; for v2 blobs a vault exists already, so the keys are known.
 */
export function lazyTeamVault(create: () => SecretVault): SecretVault {
  let vault: SecretVault | undefined
  const get = (): SecretVault => {
    vault ??= create()
    return vault
  }
  return {
    seal: (plaintext, context) => get().seal(plaintext, context),
    open: (sealed, context) => get().open(sealed, context),
    needsReseal: (sealed) =>
      sealed.startsWith(LEGACY_PREFIX) ? true : get().needsReseal?.(sealed) === true,
  }
}

/** The vault of this server from the environment (lazy). */
export function teamVaultFromEnv(options: TeamVaultOptions = {}): SecretVault {
  return lazyTeamVault(() => teamVault(secretKeysFromEnv(options)))
}

/**
 * A key set from the environment that differs from the dev key file next to the database: the
 * data written before was sealed with the file's key, so that key stays usable for reading (as
 * if listed in `<NAME>_PREVIOUS`) and a warning says so. Setting a new key by mistake can then
 * never lock the data; copy the file's content into the variable to make them equal.
 */
export function withKeyFileFallback(
  keys: Uint8Array<ArrayBuffer>[],
  file: string | undefined,
  name: string,
  warn: (message: string) => void,
): Uint8Array<ArrayBuffer>[] {
  if (file === undefined || !existsSync(file)) return keys
  let fromFile: Uint8Array<ArrayBuffer>
  try {
    fromFile = parseSecretKey(readFileSync(file, 'utf8'), file)
  } catch {
    return keys
  }
  const same = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i])
  if (keys.some((k) => same(k, fromFile))) return keys
  warn(
    `WARNING: ${name} differs from the key in ${file}. Data written before was sealed with the file's key, so it is still used to read it (as ${name}_PREVIOUS). To make them one key, set ${name} to the content of that file.`,
  )
  return [...keys, fromFile]
}
