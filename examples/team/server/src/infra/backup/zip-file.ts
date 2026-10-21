/**
 * A ZIP writer that streams entries to a file (store method): the export of a big library never
 * sits in memory. Limits of plain ZIP (4 GiB, 65 535 entries) throw instead of writing a broken file.
 */
import { closeSync, openSync, writeSync } from 'node:fs'
import { crc32 } from '../artifacts/zip.ts'

const LIMIT = 0xffff_ffff
const enc = new TextEncoder()

export interface ZipFileWriter {
  add(path: string, bytes: Uint8Array, at: number): void
  /** Writes the central directory and closes the file. */
  finish(): void
  /** Closes without finishing (an aborted export). */
  abort(): void
}

const dosTime = (at: number): { time: number; date: number } => {
  const d = new Date(at)
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function zipFileWriter(file: string): ZipFileWriter {
  const fd = openSync(file, 'w')
  const central: Uint8Array[] = []
  let offset = 0
  let count = 0
  let closed = false
  const put = (bytes: Uint8Array): void => {
    let done = 0
    while (done < bytes.byteLength) done += writeSync(fd, bytes, done)
    offset += bytes.byteLength
  }
  return {
    add(path, bytes, at) {
      if (count >= 0xffff) throw new Error('too many files for a zip export (65535)')
      if (bytes.byteLength >= LIMIT || offset + bytes.byteLength + 1024 >= LIMIT) {
        throw new Error('the export is larger than a zip file allows (4 GiB)')
      }
      const name = enc.encode(path)
      const crc = crc32(bytes)
      const { time, date } = dosTime(at)
      const local = new DataView(new ArrayBuffer(30))
      local.setUint32(0, 0x04034b50, true)
      local.setUint16(4, 20, true)
      local.setUint16(6, 0x0800, true)
      local.setUint16(10, time, true)
      local.setUint16(12, date, true)
      local.setUint32(14, crc, true)
      local.setUint32(18, bytes.byteLength, true)
      local.setUint32(22, bytes.byteLength, true)
      local.setUint16(26, name.byteLength, true)
      const start = offset
      put(new Uint8Array(local.buffer))
      put(name)
      put(bytes)
      const cd = new DataView(new ArrayBuffer(46))
      cd.setUint32(0, 0x02014b50, true)
      cd.setUint16(4, 20, true)
      cd.setUint16(6, 20, true)
      cd.setUint16(8, 0x0800, true)
      cd.setUint16(12, time, true)
      cd.setUint16(14, date, true)
      cd.setUint32(16, crc, true)
      cd.setUint32(20, bytes.byteLength, true)
      cd.setUint32(24, bytes.byteLength, true)
      cd.setUint16(28, name.byteLength, true)
      cd.setUint32(42, start, true)
      central.push(new Uint8Array(cd.buffer), name)
      count++
    },
    finish() {
      const start = offset
      for (const c of central) put(c)
      const size = offset - start
      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, count, true)
      end.setUint16(10, count, true)
      end.setUint32(12, size, true)
      end.setUint32(16, start, true)
      put(new Uint8Array(end.buffer))
      closed = true
      closeSync(fd)
    },
    abort() {
      if (!closed) closeSync(fd)
      closed = true
    },
  }
}
