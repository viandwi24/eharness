/**
 * Resolution of stored file references for the model (`inputFiles.resolve`, internal).
 *
 * @see docs/specs/03-messages.md#6-projection-to-the-model
 */
import type { InputFilesConfig, ResolveInputFile } from '../agent/types.ts'
import { FILE_UNAVAILABLE } from './texts.ts'

type FileResolver = NonNullable<InputFilesConfig['resolve']>

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** The `FileUIPart` url of a resolved file: its URL, or a `data:` URL over its bytes. */
function urlOfResolved(resolved: ResolveInputFile, mediaType: string): string | undefined {
  if (resolved.url !== undefined) return resolved.url
  if (resolved.data === undefined) return undefined
  const base64 = typeof resolved.data === 'string' ? resolved.data : base64Of(resolved.data)
  return `data:${mediaType};base64,${base64}`
}

/** Longest text file projected inline (characters); the rest is cut with a note. */
export const INLINE_TEXT_MAX_CHARS = 100_000

/** Media types read as text: sent as a text part, never as a file part (some upstreams reject those). */
export function isTextLike(mediaType: string): boolean {
  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? ''
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/yaml' ||
    type === 'application/x-yaml' ||
    type === 'application/csv' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  )
}

/** The text part content of a text-like `data:` URL, or `undefined` (not inline text). */
function inlineText(
  url: string,
  mediaType: string,
  filename: string | undefined,
): string | undefined {
  if (!isTextLike(mediaType)) return undefined
  const match = /^data:([^,]*?),(.*)$/is.exec(url)
  if (match === null) return undefined
  let bytes: Uint8Array
  try {
    if (/;base64$/i.test(match[1] ?? '')) {
      const binary = atob(decodeURIComponent(match[2] ?? ''))
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    } else bytes = new TextEncoder().encode(decodeURIComponent(match[2] ?? ''))
  } catch {
    return undefined
  }
  const full = new TextDecoder().decode(bytes)
  const cut = full.length > INLINE_TEXT_MAX_CHARS
  const body = cut ? full.slice(0, INLINE_TEXT_MAX_CHARS) : full
  const head = `[Attachment ${filename ?? 'file'} (${mediaType}, ${bytes.length} bytes)]`
  return `${head}\n${body}${cut ? `\n[truncated: showing the first ${INLINE_TEXT_MAX_CHARS} of ${full.length} characters]` : ''}`
}

type PartLike = { type: string; url?: unknown; mediaType?: unknown; filename?: unknown }

/**
 * Replace the `file` parts of a message whose URL the app resolves. Returns the parts unchanged
 * when `resolver` is absent or no URL was resolved. `data:` URLs are never passed to the resolver;
 * a resolver that returns `undefined` leaves the part as is; one that returns `null` or throws
 * turns the part into the `FILE_UNAVAILABLE` text (storage is never touched).
 */
export async function resolveFileParts<P extends PartLike>(
  parts: readonly P[],
  resolver: FileResolver | undefined,
  ctx: { sessionId: string },
  describe?: InputFilesConfig['describe'],
  /** A note for a file the current model cannot take (replaces the part, never resolved). */
  refuse?: (file: { mediaType: string; filename?: string }) => string | undefined,
): Promise<P[]> {
  const out: P[] = []
  for (const part of parts) {
    if (part.type === 'file' && typeof part.mediaType === 'string' && refuse !== undefined) {
      const name = typeof part.filename === 'string' ? part.filename : undefined
      const note = refuse({
        mediaType: part.mediaType,
        ...(name === undefined ? {} : { filename: name }),
      })
      if (note !== undefined) {
        out.push({ type: 'text', text: note } as unknown as P)
        continue
      }
    }
    if (
      part.type !== 'file' ||
      typeof part.url !== 'string' ||
      typeof part.mediaType !== 'string'
    ) {
      out.push(part)
      continue
    }
    if (/^data:/i.test(part.url)) {
      const text = inlineText(
        part.url,
        part.mediaType,
        typeof part.filename === 'string' ? part.filename : undefined,
      )
      out.push(text === undefined ? part : ({ type: 'text', text } as unknown as P))
      continue
    }
    const filename = typeof part.filename === 'string' ? part.filename : undefined
    const file = {
      url: part.url,
      mediaType: part.mediaType,
      ...(filename === undefined ? {} : { filename }),
    }
    let resolved: ResolveInputFile | null | undefined
    try {
      resolved =
        resolver === undefined
          ? undefined
          : await resolver(file.url, {
              sessionId: ctx.sessionId,
              mediaType: file.mediaType,
              ...(filename === undefined ? {} : { filename }),
            })
    } catch {
      resolved = null
    }
    const mediaType = resolved?.mediaType ?? part.mediaType
    const url =
      resolved === undefined || resolved === null ? undefined : urlOfResolved(resolved, mediaType)
    if (resolved === undefined) out.push(part)
    else if (url === undefined) {
      out.push({
        type: 'text',
        text: FILE_UNAVAILABLE.replace('{mediaType}', part.mediaType)
          .replace('{filename}', filename ?? '')
          .replace(' ]', ']'),
      } as unknown as P)
      continue
    } else {
      const text = inlineText(url, mediaType, filename)
      if (text !== undefined) out.push({ type: 'text', text } as unknown as P)
      else out.push({ ...part, url, mediaType })
    }
    let note: string | undefined
    try {
      note = describe?.(file)
    } catch {
      note = undefined
    }
    if (note !== undefined && note !== '') out.push({ type: 'text', text: note } as unknown as P)
  }
  return out
}
