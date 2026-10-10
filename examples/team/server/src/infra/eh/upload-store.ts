/** Uploads live in the library file store (`/uploads/**`), so agents can read them too. */
import type { Database } from 'bun:sqlite'
import type { UploadStore } from '../../app/ports.ts'
import { mediaTypeOfName } from '../../domain/chat.ts'
import { libraryFs } from './library-fs.ts'

export function sqliteUploadStore(sqlite: Database): UploadStore {
  const fs = libraryFs(sqlite)
  return {
    async put(path, bytes, mediaType) {
      const result = await fs.writeBytes?.(path, bytes, { ifVersion: null })
      if (result === undefined || !result.ok) throw new Error(`upload not stored: ${path}`)
      const meta = await fs.stat?.(path)
      return {
        path,
        version: result.version,
        size: bytes.byteLength,
        mediaType: meta?.mediaType ?? mediaTypeOfName(path) ?? mediaType,
      }
    },
    async get(path) {
      const file = await fs.readBytes?.(path)
      if (file === null || file === undefined) return undefined
      return {
        bytes: file.bytes,
        mediaType:
          file.mediaType ??
          file.meta.mediaType ??
          mediaTypeOfName(path) ??
          'application/octet-stream',
      }
    },
  }
}
