/**
 * Secrets in the workspace zip: optional, encrypted with a passphrase the owner chooses at export.
 *
 * `secrets.enc.json` (format `eharness-team-secrets`, version 1):
 *
 *   { format, version, count,
 *     kdf:    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },   // salt: 16 random bytes, base64
 *     cipher: { name: 'AES-256-GCM', iv },                             // iv: 12 random bytes, base64
 *     data }                                                           // base64 ciphertext + GCM tag
 *
 * The key comes from the passphrase with PBKDF2-SHA256 (at least 600 000 iterations, Web Crypto), the
 * additional authenticated data is `<format>:<version>:<count>`, so a changed count fails like a
 * wrong passphrase. The plaintext is the JSON of the records (`SecretRecord[]`): the stored profile
 * rows of provider profiles, connections (with their credentials) and OAuth client credentials.
 *
 * Nothing here logs, throws or returns a secret value: errors say only that the passphrase is wrong
 * or the file was changed.
 */
import { invalid } from './errors.ts'

export const SECRETS_FILE = 'secrets.enc.json'
export const SECRETS_FORMAT = 'eharness-team-secrets'
export const SECRETS_VERSION = 1
export const PASSPHRASE_MIN = 12
export const PASSPHRASE_MAX = 256
export const KDF_ITERATIONS = 600_000
/** An import refuses a file that asks for more work than this (a hostile iteration count). */
const KDF_ITERATIONS_MAX = 5_000_000

/** One stored row of the profile table (a provider profile, a connection, its credentials, an OAuth client). */
export interface SecretRow {
  kind: string
  id: string
  profile: Record<string, unknown>
}

/** What is exported and restored as one unit: a provider profile, a connection with its credentials, an OAuth client. */
export interface SecretRecord {
  /** `provider/<id>`, `connection/<id>`, `connector-client/<id>`: the item key of the preview. */
  key: string
  /** A readable name (the profile's label); never a value. */
  label: string
  rows: SecretRow[]
}

/** What the secrets file says without the passphrase. */
export interface SecretsHeader {
  count: number
}

export function checkPassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string' || passphrase.length < PASSPHRASE_MIN) {
    throw invalid(
      `The passphrase must be at least ${PASSPHRASE_MIN} characters`,
      'INVALID_PASSPHRASE',
    )
  }
  if (passphrase.length > PASSPHRASE_MAX) {
    throw invalid(
      `The passphrase must be at most ${PASSPHRASE_MAX} characters`,
      'INVALID_PASSPHRASE',
    )
  }
  return passphrase
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}
const unb64 = (text: string): Uint8Array<ArrayBuffer> => {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const aad = (count: number): Uint8Array<ArrayBuffer> =>
  encoder.encode(`${SECRETS_FORMAT}:${SECRETS_VERSION}:${count}`)

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** The bytes of `secrets.enc.json` for these records. */
export async function sealSecrets(
  records: readonly SecretRecord[],
  passphrase: string,
): Promise<Uint8Array> {
  checkPassphrase(passphrase)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS)
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(records.length) },
      key,
      encoder.encode(JSON.stringify(records)),
    ),
  )
  const file = {
    format: SECRETS_FORMAT,
    version: SECRETS_VERSION,
    count: records.length,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: b64(salt) },
    cipher: { name: 'AES-256-GCM', iv: b64(iv) },
    data: b64(cipher),
  }
  return encoder.encode(`${JSON.stringify(file, null, 2)}\n`)
}

const unreadable = (): Error =>
  invalid(
    'The secrets file is not in the format of this export (it was changed or is from another program). Nothing secret was imported.',
    'IMPORT_SECRETS_INVALID',
  )

interface ParsedFile {
  count: number
  iterations: number
  salt: Uint8Array<ArrayBuffer>
  iv: Uint8Array<ArrayBuffer>
  data: Uint8Array<ArrayBuffer>
}

function parseFile(bytes: Uint8Array): ParsedFile {
  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(bytes))
  } catch {
    throw unreadable()
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const kdf = (o.kdf ?? {}) as Record<string, unknown>
  const cipher = (o.cipher ?? {}) as Record<string, unknown>
  if (
    o.format !== SECRETS_FORMAT ||
    o.version !== SECRETS_VERSION ||
    typeof o.count !== 'number' ||
    !Number.isInteger(o.count) ||
    o.count < 0 ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < KDF_ITERATIONS ||
    kdf.iterations > KDF_ITERATIONS_MAX ||
    typeof kdf.salt !== 'string' ||
    cipher.name !== 'AES-256-GCM' ||
    typeof cipher.iv !== 'string' ||
    typeof o.data !== 'string'
  ) {
    throw unreadable()
  }
  try {
    return {
      count: o.count,
      iterations: kdf.iterations,
      salt: unb64(kdf.salt),
      iv: unb64(cipher.iv),
      data: unb64(o.data),
    }
  } catch {
    throw unreadable()
  }
}

/** How many secrets the file holds (needs no passphrase); refuses a file that is not ours. */
export function secretsHeader(bytes: Uint8Array): SecretsHeader {
  return { count: parseFile(bytes).count }
}

const WRONG =
  'The passphrase is wrong, or the secrets file was changed. Nothing secret was imported.'

/** The records of `secrets.enc.json`; a wrong passphrase or a changed file fails with `IMPORT_PASSPHRASE`. */
export async function openSecrets(bytes: Uint8Array, passphrase: string): Promise<SecretRecord[]> {
  const f = parseFile(bytes)
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw invalid('Enter the passphrase of this export to restore its secrets', 'IMPORT_PASSPHRASE')
  }
  let plain: string
  try {
    const key = await deriveKey(passphrase, f.salt, f.iterations)
    plain = decoder.decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: f.iv, additionalData: aad(f.count) },
        key,
        f.data,
      ),
    )
  } catch {
    throw invalid(WRONG, 'IMPORT_PASSPHRASE')
  }
  let records: unknown
  try {
    records = JSON.parse(plain)
  } catch {
    throw invalid(WRONG, 'IMPORT_PASSPHRASE')
  }
  if (!Array.isArray(records) || records.length !== f.count)
    throw invalid(WRONG, 'IMPORT_PASSPHRASE')
  for (const r of records as SecretRecord[]) {
    if (
      r === null ||
      typeof r !== 'object' ||
      typeof r.key !== 'string' ||
      typeof r.label !== 'string' ||
      !Array.isArray(r.rows) ||
      r.rows.some(
        (x) =>
          x === null ||
          typeof x !== 'object' ||
          typeof x.kind !== 'string' ||
          typeof x.id !== 'string' ||
          x.profile === null ||
          typeof x.profile !== 'object',
      )
    ) {
      throw unreadable()
    }
  }
  return records as SecretRecord[]
}
