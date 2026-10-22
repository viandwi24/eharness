/**
 * The vault of the channel log: its own key, separate from `TEAM_SECRET_KEY` (platform terms ask
 * for encryption at rest with a key stored apart). `TEAM_CHANNEL_KEY` = 32 bytes base64
 * (`openssl rand -base64 32`); without it a dev key lives next to the database (`channel.key`,
 * git-ignored) and an in-memory database gets a throwaway key.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type SecretVault, webCryptoVault } from 'eharness/providers'
import { generateSecretKey, parseSecretKey, withKeyFileFallback } from '../eh/secret-vault.ts'

const keyId = (key: Uint8Array): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 8)

export function channelVault(keys: readonly Uint8Array<ArrayBuffer>[]): SecretVault {
  if (keys.length === 0) throw new Error('at least one channel key is needed')
  const table: Record<string, Uint8Array> = {}
  for (const key of keys) table[keyId(key)] = key
  return webCryptoVault({ keys: table, current: keyId(keys[0] as Uint8Array) })
}

export function channelVaultFromEnv(
  options: {
    env?: Record<string, string | undefined>
    dataDir?: string | undefined
    warn?: (message: string) => void
  } = {},
): SecretVault {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((m) => console.warn(m))
  const previous = (env.TEAM_CHANNEL_KEY_PREVIOUS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => parseSecretKey(s, 'TEAM_CHANNEL_KEY_PREVIOUS'))
  const configured = env.TEAM_CHANNEL_KEY?.trim()
  if (configured) {
    return channelVault(
      withKeyFileFallback(
        [parseSecretKey(configured, 'TEAM_CHANNEL_KEY'), ...previous],
        options.dataDir === undefined ? undefined : join(options.dataDir, 'channel.key'),
        'TEAM_CHANNEL_KEY',
        warn,
      ),
    )
  }
  if (options.dataDir === undefined) {
    return channelVault([parseSecretKey(generateSecretKey()), ...previous])
  }
  const file = join(options.dataDir, 'channel.key')
  let text: string
  if (existsSync(file)) text = readFileSync(file, 'utf8')
  else {
    text = generateSecretKey()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${text}\n`, { mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // best effort
    }
    warn(
      `WARNING: TEAM_CHANNEL_KEY is not set: the channel log is encrypted with a dev key stored in ${file}. Set TEAM_CHANNEL_KEY outside development. Never commit this file.`,
    )
  }
  return channelVault([parseSecretKey(text, file), ...previous])
}
