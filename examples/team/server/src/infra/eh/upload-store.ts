/** Uploads live in the library file store (`/uploads/**`), so agents can read them too. */
import type { Database } from 'bun:sqlite'
import type { UploadStore } from '../../app/ports.ts'
import { mediaTypeOfName } from '../../domain/chat.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'

export function sqliteUploadStore(
  sqlite: Database,
  options: { onChange?: (change: LibraryChange) => void } = {},
): UploadStore {
  const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
  return {
    async put(path, bytes, mediaType) {
      const result = await fs.writeBytes?.(path, bytes, { ifVersion: null, mediaType })
      if (result === undefined || !result.ok) throw new Error(`upload not stored: ${path}`)
      const meta = await fs.stat?.(path)
      return {
        path,
        version: result.version,
        size: bytes.byteLength,
        mediaType: meta?.mediaType ?? mediaType,
      }
    },
    async stat(path) {
      const meta = await fs.stat?.(path)
      if (meta === null || meta === undefined) return undefined
      return {
        size: meta.size,
        mediaType: meta.mediaType ?? mediaTypeOfName(path) ?? 'application/octet-stream',
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
