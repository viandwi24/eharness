/**
 * Offloaded tool media (internal): the stored form of an MCP media part (`{ type: 'image', data,
 * mimeType }`) whose bytes live in the `toolMedia` service, and the projection step that puts the
 * bytes back for the model (spec 09 §4, spec 03 §6 step 8).
 *
 * @see docs/specs/09-tools-and-mcp.md#4-tool-output-limits
 */
import type { UIMessage } from 'ai'

/** The reference a stored media part carries instead of its base64 `data`. */
export interface StoredMediaRef {
  type: 'media-ref'
  path: string
  version: string
  mediaType: string
  bytes: number
}

/** A media part of a tool output after the offload: no `data`, a `ref` instead. */
export interface OffloadedMediaPart {
  type: 'image' | 'audio'
  mimeType: string
  ref: StoredMediaRef
}

/** What replaces an offloaded media part the model does not get any more (over `keepImages`). */
export const OLDER_OFFLOADED_MEDIA_NOTE =
  '[An older image from this tool was left out to save context. Take a new one if you need to see it.]'

/** What replaces an offloaded media part whose file is gone. */
export const EXPIRED_OFFLOADED_MEDIA_NOTE =
  '[This image is no longer available (the stored file expired or was removed).]'

/** True for a stored media part that points at a `toolMedia` file. */
export function isOffloadedMediaPart(part: unknown): part is OffloadedMediaPart {
  if (typeof part !== 'object' || part === null) return false
  const p = part as { type?: unknown; ref?: unknown }
  if (p.type !== 'image' && p.type !== 'audio') return false
  const ref = p.ref as Partial<StoredMediaRef> | null | undefined
  return (
    typeof ref === 'object' &&
    ref !== null &&
    ref.type === 'media-ref' &&
    typeof ref.path === 'string' &&
    typeof ref.version === 'string'
  )
}

/** `content` of an MCP-style output, or `undefined`. */
function contentOf(output: unknown): unknown[] | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const content = (output as { content?: unknown }).content
  return Array.isArray(content) ? content : undefined
}

/** Standard base64 of bytes (chunked, no stack overflow on large input). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

/** Bytes of a base64 string, or `undefined` when it is not valid base64. */
export function base64ToBytes(data: string): Uint8Array | undefined {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return undefined
  }
}

/** Reads the base64 of a stored media file, or `null` when it is gone or changed. */
export type ReadToolMedia = (ref: StoredMediaRef) => Promise<string | null>

/**
 * One tool output with every offloaded media part read back (or noted when its file is gone):
 * the live step wire, where the tool's own `toModelOutput` converts the stored output. Returns the
 * same output when it has no offloaded media.
 */
export async function rehydrateOutputMedia(output: unknown, read: ReadToolMedia): Promise<unknown> {
  const content = contentOf(output)
  if (content === undefined || !content.some(isOffloadedMediaPart)) return output
  const next: unknown[] = []
  for (const item of content) {
    if (!isOffloadedMediaPart(item)) {
      next.push(item)
      continue
    }
    let data: string | null = null
    try {
      data = await read(item.ref)
    } catch {
      data = null
    }
    next.push(
      data === null
        ? { type: 'text', text: EXPIRED_OFFLOADED_MEDIA_NOTE }
        : { type: item.type, mimeType: item.mimeType, data },
    )
  }
  return { ...(output as object), content: next }
}

type Part = { type: string; state?: string; output?: unknown }

function isToolPart(part: { type: string }): part is Part {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/**
 * Put the bytes of offloaded media back into the tool outputs of `messages`, newest first: the
 * newest `keep` media (all when `undefined`) are read through `read` and get their `data` back;
 * older ones, and files that are gone, become a text part with a note. Messages without such
 * outputs are returned as they are; stored messages are never mutated.
 */
export async function rehydrateToolMedia<M extends UIMessage>(
  messages: readonly M[],
  opts: { keep: number | undefined; read: ReadToolMedia },
): Promise<readonly M[]> {
  const hasRefs = messages.some((m) =>
    m.parts.some(
      (p) =>
        isToolPart(p) &&
        p.state === 'output-available' &&
        contentOf(p.output)?.some(isOffloadedMediaPart) === true,
    ),
  )
  if (!hasRefs) return messages
  let seen = 0
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i] as M
    let parts: M['parts'] | undefined
    for (let k = message.parts.length - 1; k >= 0; k--) {
      const part = message.parts[k] as Part
      if (!isToolPart(part) || part.state !== 'output-available') continue
      const content = contentOf(part.output)
      if (content === undefined || !content.some(isOffloadedMediaPart)) continue
      const next = [...content]
      for (let j = next.length - 1; j >= 0; j--) {
        const item = next[j]
        if (!isOffloadedMediaPart(item)) continue
        seen++
        if (opts.keep !== undefined && seen > opts.keep) {
          next[j] = { type: 'text', text: OLDER_OFFLOADED_MEDIA_NOTE }
          continue
        }
        let data: string | null = null
        try {
          data = await opts.read(item.ref)
        } catch {
          data = null
        }
        next[j] =
          data === null
            ? { type: 'text', text: EXPIRED_OFFLOADED_MEDIA_NOTE }
            : { type: item.type, mimeType: item.mimeType, data }
      }
      parts ??= [...message.parts] as M['parts']
      parts[k] = { ...part, output: { ...(part.output as object), content: next } } as never
    }
    if (parts !== undefined) out[i] = { ...message, parts }
  }
  return out
}
