/**
 * A ZIP reader for the workspace import: stored and deflated entries (`DecompressionStream`, a Web
 * API), with the limits of an untrusted file. It refuses what it cannot read safely: encryption,
 * zip64, other compression methods, duplicate names, a declared size over the limits, a deflated
 * entry that inflates to more (or less) than it declared, and a wrong CRC-32.
 */
import { crc32 } from '../artifacts/zip.ts'

export interface ZipReadLimits {
  /** Compressed size of the whole file. */
  zipBytes: number
  entries: number
  /** Uncompressed size of one entry. */
  entryBytes: number
  /** Uncompressed size of all entries together. */
  totalBytes: number
}

/** The zip cannot be read (corrupt, over a limit, or something this reader refuses). */
export class ZipError extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** Inflate raw deflate data, giving up as soon as the output passes `expected` bytes. */
async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const out = new Uint8Array(expected)
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (at + value.byteLength > expected) {
      await reader.cancel()
      throw new ZipError('an entry inflates to more than it declares (zip bomb?)')
    }
    out.set(value, at)
    at += value.byteLength
  }
  if (at !== expected) throw new ZipError('an entry inflates to less than it declares')
  return out
}

export async function readZip(
  buf: Uint8Array,
  limits: ZipReadLimits,
): Promise<Map<string, Uint8Array>> {
  if (buf.byteLength > limits.zipBytes) {
    throw new ZipError(`the zip is larger than ${Math.floor(limits.zipBytes / 1048576)} MB`)
  }
  if (buf.byteLength < 22) throw new ZipError('this is not a zip file')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let end = buf.byteLength - 22
  const stop = Math.max(0, end - 65_535)
  while (end >= stop && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < stop) throw new ZipError('this is not a zip file (no end of central directory)')
  const count = view.getUint16(end + 10, true)
  const cdSize = view.getUint32(end + 12, true)
  let at = view.getUint32(end + 16, true)
  if (count === 0xffff || cdSize === 0xffff_ffff || at === 0xffff_ffff) {
    throw new ZipError('zip64 files are not supported')
  }
  if (count > limits.entries) throw new ZipError(`the zip has more than ${limits.entries} entries`)
  if (at + cdSize > end) throw new ZipError('the central directory is out of range')
  const out = new Map<string, Uint8Array>()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.byteLength || view.getUint32(at, true) !== 0x02014b50) {
      throw new ZipError('the central directory is damaged')
    }
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const csize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    if (csize === 0xffff_ffff || size === 0xffff_ffff || local === 0xffff_ffff) {
      throw new ZipError('zip64 files are not supported')
    }
    if ((flags & 1) !== 0) throw new ZipError('encrypted zip entries are not supported')
    let name: string
    try {
      name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLen))
    } catch {
      throw new ZipError('an entry name is not valid UTF-8')
    }
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (out.has(name)) throw new ZipError(`duplicate entry: ${name}`)
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${name}`)
    if (size > limits.entryBytes) {
      throw new ZipError(`${name} is larger than ${Math.floor(limits.entryBytes / 1048576)} MB`)
    }
    total += size
    if (total > limits.totalBytes) {
      throw new ZipError(`the zip holds more than ${Math.floor(limits.totalBytes / 1048576)} MB`)
    }
    if (local + 30 > buf.byteLength || view.getUint32(local, true) !== 0x04034b50) {
      throw new ZipError(`the local header of ${name} is damaged`)
    }
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (dataAt + csize > buf.byteLength) throw new ZipError(`${name} runs past the end of the file`)
    const raw = buf.subarray(dataAt, dataAt + csize)
    let bytes: Uint8Array
    if (method === 0) {
      if (csize !== size) throw new ZipError(`${name}: sizes of a stored entry differ`)
      bytes = raw.slice()
    } else {
      try {
        bytes = await inflate(raw, size)
      } catch (error) {
        if (error instanceof ZipError) throw new ZipError(`${name}: ${error.message}`)
        throw new ZipError(`${name} cannot be inflated`)
      }
    }
    if (crc32(bytes) !== crc) throw new ZipError(`${name}: checksum mismatch (corrupt zip)`)
    out.set(name, bytes)
  }
  return out
}
