/**
 * File parts on the wire (internal): degrading expired file URLs and resolving input files.
 */
import type { ModelMessage } from 'ai'
import type { InputFilesConfig } from '../agent/types.ts'
import { FILE_UNAVAILABLE } from '../messages/texts.ts'
import type { SessionRuntime } from '../session/runtime.ts'

/**
 * Replace the file parts of earlier turns (wire before `turnStart`) whose URL is `url` with the
 * `FILE_UNAVAILABLE` text. True when one was replaced.
 */
export function degradeFile(wire: ModelMessage[], turnStart: number, url: string): boolean {
  const target = normalizeUrl(url)
  const matches = (part: { type: string; data?: unknown }): boolean =>
    part.type === 'file' && fileUrlOf(part.data) === target
  let replaced = false
  for (let i = 0; i < Math.min(turnStart, wire.length); i++) {
    const message = wire[i] as ModelMessage
    if (message.role !== 'user' || typeof message.content === 'string') continue
    if (!message.content.some(matches)) continue
    replaced = true
    wire[i] = {
      ...message,
      content: message.content.map((part) =>
        part.type === 'file' && matches(part)
          ? {
              type: 'text' as const,
              text: FILE_UNAVAILABLE.replace('{mediaType}', part.mediaType)
                .replace('{filename}', part.filename ?? '')
                .replace(' ]', ']'),
            }
          : part,
      ),
    }
  }
  return replaced
}

export function normalizeUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** The URL of a model file part's `data` (bare string / `URL`, or `{ type: 'url', url }`). */
export function fileUrlOf(data: unknown): string | undefined {
  if (data instanceof URL) return data.href
  if (typeof data === 'string')
    return /^[a-z][a-z0-9+.-]*:/i.test(data) ? normalizeUrl(data) : undefined
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'url') {
    return normalizeUrl(String((data as { url?: unknown }).url))
  }
  return undefined
}

export function fileResolution(rt: SessionRuntime): {
  resolve?: NonNullable<InputFilesConfig['resolve']>
  sessionId: string
} {
  const resolve = rt.agent.config.inputFiles?.resolve
  return { sessionId: rt.id, ...(resolve === undefined ? {} : { resolve }) }
}
