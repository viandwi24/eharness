/**
 * Binary file helpers (spec 08 §12): binary sniffing, media type detection, image dimensions and
 * base64. Pure Web APIs (`Uint8Array`, `TextDecoder`, `btoa`), no Node built-ins.
 *
 * @see docs/specs/08-filesystem-plugin.md#12-binary-files-and-images
 */

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Bytes inspected for a NUL byte by {@link looksBinary}. */
const SNIFF_BYTES = 8000

/**
 * True when `bytes` are not text: a NUL byte in the first 8000 bytes, or not valid UTF-8. The one
 * rule adapters use to tell binary from text files, so they agree.
 *
 * @example
 * ```ts
 * looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) // true
 * ```
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes
  if (head.includes(0)) return true
  try {
    strictUtf8.decode(bytes)
    return false
  } catch {
    return true
  }
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  wasm: 'application/wasm',
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte)

/**
 * Media type of a file: magic bytes first (PNG, JPEG, GIF, WebP, PDF, BMP, ZIP, gzip), then the
 * file extension. `undefined` when neither is known. Never trusts the extension over the bytes
 * for the formats the model can see.
 *
 * @example
 * ```ts
 * detectMediaType(pngBytes, '/shot.bin') // 'image/png'
 * detectMediaType(new Uint8Array(), '/a.pdf') // 'application/pdf'
 * ```
 */
export function detectMediaType(bytes: Uint8Array, path: string): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length > 14) return 'image/bmp'
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  if (startsWith(bytes, [0x1f, 0x8b])) return 'application/gzip'
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXTENSION_TYPES[base.slice(dot + 1).toLowerCase()]
}

/** Media types of images the model can be shown. */
export const MODEL_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

/**
 * Pixel size of a PNG, GIF, JPEG or WebP image read from its header, or `undefined` when the
 * header is not understood (dimensions are informational only).
 */
export function imageDimensions(
  bytes: Uint8Array,
  mediaType: string,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (mediaType === 'image/png' && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    if (mediaType === 'image/gif' && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    }
    if (mediaType === 'image/jpeg') {
      let at = 2
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) {
          at++
          continue
        }
        const marker = bytes[at + 1] as number
        if (marker === 0xff) {
          at++
          continue
        }
        // standalone markers carry no length
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          at += 2
          continue
        }
        const isFrame =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isFrame) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
        at += 2 + view.getUint16(at + 2)
      }
      return undefined
    }
    if (mediaType === 'image/webp' && bytes.length >= 30) {
      const chunk = String.fromCharCode(
        bytes[12] as number,
        bytes[13] as number,
        bytes[14] as number,
        bytes[15] as number,
      )
      if (chunk === 'VP8X') {
        const w =
          1 + (bytes[24] as number) + ((bytes[25] as number) << 8) + ((bytes[26] as number) << 16)
        const h =
          1 + (bytes[27] as number) + ((bytes[28] as number) << 8) + ((bytes[29] as number) << 16)
        return { width: w, height: h }
      }
      if (chunk === 'VP8 ') {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        }
      }
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
  } catch {
    // truncated header
  }
  return undefined
}

/** Base64 of `bytes`, in chunks so large files never overflow the call stack (`btoa` only). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}
