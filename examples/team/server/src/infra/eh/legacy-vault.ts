/**
 * Read an older sealing format, write the current one. Kept in this example (not in the library):
 * it exists only to migrate this app's own `v1:` secret box to `webCryptoVault`.
 */
import type { SecretVault } from 'eharness/providers'

/** Reads blobs of an older sealing format (see {@link withLegacyVault}). */
export interface LegacyOpener {
  /** True for blobs this opener understands (by their prefix). */
  matches(sealed: string): boolean
  /** Open a legacy blob; reject when it cannot be opened. */
  open(sealed: string, context: string): Promise<string>
}

/**
 * `open` routes legacy blobs to `legacy`, everything else to `vault`; `seal` always uses `vault`;
 * `needsReseal` is true for legacy blobs (and whatever `vault` flags), so
 * `sealedProfileStore().reseal()` migrates them in place.
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
