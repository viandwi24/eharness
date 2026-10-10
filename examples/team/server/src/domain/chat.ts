/** Chat conventions and upload policy (docs/plans/P32-team-example.md §5.2). Pure. */
import { invalid } from './errors.ts'
import { UPLOADS_ROOT } from './library.ts'

/** The DM chat of an agent is one eharness session. */
export const dmSessionId = (agentId: string): string => `dm:${agentId}`

/** Largest file a chat message may carry (library upload and data URLs). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Media types a message attachment may have; anything else is rejected before it is stored. */
export const ALLOWED_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
]

export const isAllowedMediaType = (mediaType: string): boolean =>
  ALLOWED_MEDIA_TYPES.includes(mediaType.toLowerCase().split(';')[0]?.trim() ?? '')

/** `library:` references name an uploaded file: `library:///uploads/<day>/<id>-<name>`. */
export const LIBRARY_URL_PREFIX = 'library://'

export const libraryUrl = (path: string): string =>
  `${LIBRARY_URL_PREFIX}${path.split('/').map(encodeURIComponent).join('/')}`

/** The path of a `library:` URL, only when it points inside the uploads folder. */
export function uploadPathOfUrl(url: string): string | undefined {
  if (!url.startsWith(LIBRARY_URL_PREFIX)) return undefined
  let path: string
  try {
    path = decodeURIComponent(url.slice(LIBRARY_URL_PREFIX.length))
  } catch {
    throw invalid(`malformed file reference: ${url}`, 'INVALID_FILE_REF')
  }
  if (!path.startsWith(`${UPLOADS_ROOT}/`) || path.split('/').includes('..')) {
    throw invalid('only files under /uploads can be attached', 'INVALID_FILE_REF')
  }
  return path
}

/** A file name safe to use inside a path: no separators, no control characters, bounded. */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').normalize('NFKC')
  const cleaned = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned === '' ? 'file' : cleaned).slice(-80)
}

/** `/uploads/<yyyy-mm-dd>/<id>-<name>`: unique per upload, listable by day. */
export function uploadPath(now: number, id: string, fileName: string): string {
  const day = new Date(now).toISOString().slice(0, 10)
  return `${UPLOADS_ROOT}/${day}/${id}-${safeFileName(fileName)}`
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
}

/** Media type from a file name's extension (the file store keeps none for text files). */
export const mediaTypeOfName = (name: string): string | undefined =>
  EXTENSION_TYPES[name.split('.').pop()?.toLowerCase() ?? '']
