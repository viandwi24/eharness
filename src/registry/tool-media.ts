/**
 * Tool media offload (internal): the base64 media parts of an MCP-style tool result are written to
 * the session's `toolMedia` service and replaced in the stored output by a small reference, so
 * screenshots do not pile up in the message store (spec 09 §4).
 *
 * @see docs/specs/09-tools-and-mcp.md#4-tool-output-limits
 */
import type { HarnessWarning } from '../errors.ts'
import {
  base64ToBytes,
  bytesToBase64,
  type OffloadedMediaPart,
  type ReadToolMedia,
  type StoredMediaRef,
} from '../messages/tool-media.ts'

/** Minimal shape of the `toolMedia` service (declared by the filesystem plugin, spec 08 §2). */
export interface ToolMediaSink {
  /** Store media bytes; `null` when the file system cannot hold binary files. */
  put(
    sessionId: string,
    toolCallId: string,
    index: number,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<{ path: string; version: string; bytes: number } | null>
  /** The stored file, or `null` when it is gone. */
  read(path: string): Promise<{ bytes: Uint8Array; version: string } | null>
}

function isRawMedia(
  part: unknown,
): part is { type: 'image' | 'audio'; data: string; mimeType?: string } {
  if (typeof part !== 'object' || part === null) return false
  const p = part as { type?: unknown; data?: unknown }
  return (p.type === 'image' || p.type === 'audio') && typeof p.data === 'string'
}

/**
 * Replace the media parts of an MCP-style output (`{ content: [...] }`) by references. Anything
 * else, and parts that cannot be written, are kept as they are (never throws).
 */
export async function offloadToolMedia(
  toolName: string,
  toolCallId: string,
  output: unknown,
  deps: {
    sessionId: string | undefined
    toolMedia: ToolMediaSink | undefined
    warn(warning: HarnessWarning, key?: string): void
  },
): Promise<unknown> {
  const sink = deps.toolMedia
  if (sink === undefined || deps.sessionId === undefined) return output
  if (typeof output !== 'object' || output === null) return output
  const content = (output as { content?: unknown }).content
  if (!Array.isArray(content) || !content.some(isRawMedia)) return output
  const next = [...content]
  for (const [index, part] of content.entries()) {
    if (!isRawMedia(part)) continue
    const mediaType = part.mimeType ?? (part.type === 'image' ? 'image/png' : 'audio/wav')
    try {
      const bytes = base64ToBytes(part.data)
      if (bytes === undefined) continue
      const stored = await sink.put(deps.sessionId, toolCallId, index, bytes, mediaType)
      if (stored === null) continue
      const ref: StoredMediaRef = {
        type: 'media-ref',
        path: stored.path,
        version: stored.version,
        mediaType,
        bytes: stored.bytes,
      }
      const replaced: OffloadedMediaPart = { type: part.type, mimeType: mediaType, ref }
      next[index] = replaced
    } catch (error) {
      deps.warn(
        {
          code: 'W_TOOL_MEDIA_OFFLOAD',
          message: `Media of tool '${toolName}' could not be stored (${error instanceof Error ? error.message : String(error)}); it stays in the output.`,
          details: { tool: toolName, toolCallId, index },
        },
        `${toolCallId}:${index}`,
      )
    }
  }
  return { ...(output as object), content: next }
}

/** Cached base64 of a stored tool media file (path + version), per `toolMedia` service (= per session). */
const mediaCaches = new WeakMap<ToolMediaSink, Map<string, string>>()
/** Most files kept per session cache (the newest few are projected on every step). */
const MEDIA_CACHE_ENTRIES = 16

/** `project()`'s `readMedia` over the session's `toolMedia` service: version-checked, cached, never throws. */
export function toolMediaReader(sink: ToolMediaSink | undefined): ReadToolMedia | undefined {
  if (sink === undefined) return undefined
  let cache = mediaCaches.get(sink)
  if (cache === undefined) {
    cache = new Map()
    mediaCaches.set(sink, cache)
  }
  const hits = cache
  return async (ref) => {
    const key = `${ref.path}\u0000${ref.version}`
    const hit = hits.get(key)
    if (hit !== undefined) {
      hits.delete(key)
      hits.set(key, hit)
      return hit
    }
    try {
      const file = await sink.read(ref.path)
      if (file === null || file.version !== ref.version) return null
      const data = bytesToBase64(file.bytes)
      hits.set(key, data)
      while (hits.size > MEDIA_CACHE_ENTRIES) hits.delete(hits.keys().next().value as string)
      return data
    } catch {
      return null
    }
  }
}
