/**
 * Moving the dev keys into the environment can never lock the data: when TEAM_SECRET_KEY or
 * TEAM_CHANNEL_KEY differs from the key file next to the database, the file's key still opens
 * what was sealed with it (and a warning says so); when they are equal nothing changes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelVaultFromEnv } from '../src/infra/channels/vault.ts'
import { generateSecretKey, teamVaultFromEnv } from '../src/infra/eh/secret-vault.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const dataDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-keys-'))
  dirs.push(d)
  return d
}

describe('key file fallback', () => {
  test('a different TEAM_SECRET_KEY still opens secrets sealed with secret.key', async () => {
    const dir = dataDir()
    const warnings: string[] = []
    const warn = (m: string) => void warnings.push(m)
    const before = teamVaultFromEnv({ dataDir: dir, env: {}, warn })
    const sealed = await before.seal('provider-key-value', 'profile:p1')
    // the owner sets a NEW key by mistake
    const after = teamVaultFromEnv({
      dataDir: dir,
      env: { TEAM_SECRET_KEY: generateSecretKey() },
      warn,
    })
    expect(await after.open(sealed, 'profile:p1')).toBe('provider-key-value')
    expect(warnings.some((w) => w.includes('differs from the key in'))).toBe(true)
    // new secrets are sealed with the env key and open as well
    expect(await after.open(await after.seal('x', 'c'), 'c')).toBe('x')
  })

  test('the same key copied into TEAM_SECRET_KEY: no warning, everything opens', async () => {
    const dir = dataDir()
    const before = teamVaultFromEnv({ dataDir: dir, env: {}, warn: () => {} })
    const sealed = await before.seal('v', 'c')
    const fromFile = readFileSync(join(dir, 'secret.key'), 'utf8').trim()
    const warnings: string[] = []
    const after = teamVaultFromEnv({
      dataDir: dir,
      env: { TEAM_SECRET_KEY: fromFile },
      warn: (m) => void warnings.push(m),
    })
    expect(await after.open(sealed, 'c')).toBe('v')
    expect(warnings.filter((w) => w.includes('differs'))).toEqual([])
  })

  test('a different TEAM_CHANNEL_KEY still opens the channel log sealed with channel.key', async () => {
    const dir = dataDir()
    const warnings: string[] = []
    const before = channelVaultFromEnv({ dataDir: dir, env: {}, warn: () => {} })
    const sealed = await before.seal('hello', 'msg:1')
    const after = channelVaultFromEnv({
      dataDir: dir,
      env: { TEAM_CHANNEL_KEY: generateSecretKey() },
      warn: (m) => void warnings.push(m),
    })
    expect(await after.open(sealed, 'msg:1')).toBe('hello')
    expect(warnings.some((w) => w.includes('TEAM_CHANNEL_KEY differs'))).toBe(true)
  })
})
