/**
 * Read-only clipping of large tool and data payloads (`?clip=` of `GET /sessions/:id/messages`).
 * Storage and the model wire are never touched.
 *
 * @see docs/specs/26-http.md#22-clipped-reads
 */
import type { UIMessage } from 'ai'

/** Bounds of `?clip=` (characters of JSON). */
export const CLIP_MIN = 200
export const CLIP_MAX = 100_000

/**
 * The value that replaces a clipped `input`, `output` or data `data`. A plain JSON object, so any
 * AI SDK `Chat` accepts it; the client tells it with `isClippedPart`.
 */
export interface ClippedValue {
  eharnessClipped: true
  /** Length of the original JSON (or text, for a string) in characters. */
  chars: number
  /** The first `clip` characters of the original text or JSON. */
  preview: string
}

function sizeOf(value: unknown): { text: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return { text: value }
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : { text }
  } catch {
    return undefined
  }
}

function clipValue(value: unknown, clip: number): ClippedValue | undefined {
  const s = sizeOf(value)
  if (s === undefined) return undefined
  const jsonLength = typeof value === 'string' ? JSON.stringify(value).length : s.text.length
  if (jsonLength <= clip) return undefined
  return { eharnessClipped: true, chars: s.text.length, preview: s.text.slice(0, clip) }
}

/** Clip one part; returns the same object when nothing is over the limit. */
function clipPart(part: UIMessage['parts'][number], clip: number): UIMessage['parts'][number] {
  const p = part as Record<string, unknown>
  const type = typeof p.type === 'string' ? p.type : ''
  if (type.startsWith('data-')) {
    const data = clipValue(p.data, clip)
    return data === undefined ? part : ({ ...p, data } as unknown as typeof part)
  }
  if (type === 'reasoning') {
    // reasoning is shown collapsed; long thoughts and their provider payload (signatures,
    // encrypted reasoning) are the bulk of a long run's history
    const json = JSON.stringify(p)
    if (json.length <= clip) return part
    const text = typeof p.text === 'string' ? p.text : ''
    return {
      type: 'reasoning',
      text: text.length > clip ? text.slice(0, clip) : text,
      ...(p.state === undefined ? {} : { state: p.state }),
      providerMetadata: { eharness: { clipped: true, chars: json.length } },
    } as unknown as typeof part
  }
  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    const output = clipValue(p.output, clip)
    const input = clipValue(p.input, clip)
    if (output === undefined && input === undefined) return part
    return {
      ...p,
      ...(output === undefined ? {} : { output }),
      ...(input === undefined ? {} : { input }),
    } as unknown as typeof part
  }
  return part
}

/**
 * The read view of `messages`: tool `input`/`output` and data `data` over `clip` are previews; a
 * reasoning part over `clip` keeps a text preview and is marked in `providerMetadata.eharness`.
 */
export function clipMessages<M extends UIMessage>(messages: M[], clip: number): M[] {
  return messages.map((m) => {
    let changed = false
    const parts = m.parts.map((part) => {
      const next = clipPart(part, clip)
      if (next !== part) changed = true
      return next
    })
    return changed ? { ...m, parts } : m
  })
}

/** Parse `?clip=`; `null` when absent, `undefined` when invalid. */
export function parseClip(raw: string | null): number | null | undefined {
  if (raw === null || raw === '') return null
  if (!/^\d{1,6}$/.test(raw)) return undefined
  const n = Number(raw)
  return n >= CLIP_MIN && n <= CLIP_MAX ? n : undefined
}
