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
): Promise<P[]> {
  if (resolver === undefined) return parts as P[]
  const out: P[] = []
  for (const part of parts) {
    if (
      part.type !== 'file' ||
      typeof part.url !== 'string' ||
      typeof part.mediaType !== 'string' ||
      /^data:/i.test(part.url)
    ) {
      out.push(part)
      continue
    }
    const filename = typeof part.filename === 'string' ? part.filename : undefined
    let resolved: ResolveInputFile | null | undefined
    try {
      resolved = await resolver(part.url, {
        sessionId: ctx.sessionId,
        mediaType: part.mediaType,
        ...(filename === undefined ? {} : { filename }),
      })
    } catch {
      resolved = null
    }
    if (resolved === undefined) {
      out.push(part)
      continue
    }
    const mediaType = resolved?.mediaType ?? part.mediaType
    const url = resolved === null ? undefined : urlOfResolved(resolved, mediaType)
    if (url === undefined) {
      out.push({
        type: 'text',
        text: FILE_UNAVAILABLE.replace('{mediaType}', part.mediaType)
          .replace('{filename}', filename ?? '')
          .replace(' ]', ']'),
      } as unknown as P)
      continue
    }
    out.push({ ...part, url, mediaType })
  }
  return out
}
