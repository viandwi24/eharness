/**
 * Content versions (spec 08 §1): SHA-1 hex of the UTF-8 content via Web Crypto.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */

const encoder = new TextEncoder()

/**
 * The recommended file version: SHA-1 hex of the UTF-8 content. Equal content → equal version,
 * so stale detection depends on content identity only (never mtime or counters).
 *
 * @example
 * ```ts
 * await contentVersion('') // 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
 * ```
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export async function contentVersion(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(content))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Size of `content` in UTF-8 bytes. */
export function byteLength(content: string): number {
  return encoder.encode(content).byteLength
}

/**
 * Version of raw bytes (spec 08 §12): SHA-1 hex of the bytes. For bytes that are valid UTF-8
 * text (without a BOM) it equals {@link contentVersion} of the decoded text.
 *
 * @example
 * ```ts
 * await bytesVersion(new TextEncoder().encode('')) // 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
 * ```
 */
export async function bytesVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>)
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}
