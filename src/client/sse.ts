/**
 * Server-sent events parser. Pure: feed it decoded text chunks, it emits complete events. The
 * feed reads the stream with `fetch` (not `EventSource`) so it can send headers.
 *
 * @see docs/specs/27-client.md#4-activity-feed
 */

/** One complete SSE message. */
export interface SseMessage {
  id?: string
  event: string
  data: string
  retry?: number
}

/** An incremental SSE parser. */
export interface SseParser {
  push(chunk: string): void
  reset(): void
}

/** Default longest line (characters) the parser buffers before it discards it. */
export const DEFAULT_SSE_MAX_LINE_CHARS: number = 1024 * 1024
/** Default most `data` characters of one event before the event is dropped. */
export const DEFAULT_SSE_MAX_EVENT_CHARS: number = 4 * 1024 * 1024

/** Limits of {@link createSseParser}: a hostile or broken server cannot grow the buffer forever. */
export interface SseParserLimits {
  /** A line longer than this is discarded (never buffered whole). Default 1 MiB. */
  maxLineChars?: number
  /** An event whose `data` is longer than this is dropped. Default 4 MiB. */
  maxEventChars?: number
}

/**
 * Create a parser; `onMessage` runs for every complete event that has data. Oversized lines and
 * events are dropped silently (the stream goes on).
 */
export function createSseParser(
  onMessage: (message: SseMessage) => void,
  limits: SseParserLimits = {},
): SseParser {
  const maxLine = limits.maxLineChars ?? DEFAULT_SSE_MAX_LINE_CHARS
  const maxEvent = limits.maxEventChars ?? DEFAULT_SSE_MAX_EVENT_CHARS
  let discarding = false
  let dataChars = 0
  let tooBig = false
  let buffer = ''
  let id: string | undefined
  let event = ''
  let data: string[] = []
  let retry: number | undefined
  let lastId: string | undefined
  let skipLf = false

  const dispatch = (): void => {
    if (id !== undefined) lastId = id
    if (data.length > 0 && !tooBig) {
      const message: SseMessage = { event: event || 'message', data: data.join('\n') }
      if (lastId !== undefined) message.id = lastId
      if (retry !== undefined) message.retry = retry
      onMessage(message)
    }
    id = undefined
    event = ''
    data = []
    dataChars = 0
    tooBig = false
    retry = undefined
  }

  const line = (l: string): void => {
    if (l === '') {
      dispatch()
      return
    }
    if (l.startsWith(':')) return // comment / keep-alive
    const i = l.indexOf(':')
    const field = i < 0 ? l : l.slice(0, i)
    let value = i < 0 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      dataChars += value.length + 1
      if (dataChars > maxEvent) {
        tooBig = true
        data = []
      } else if (!tooBig) data.push(value)
    } else if (field === 'event') event = value
    else if (field === 'id') {
      if (!value.includes('\0')) id = value
    } else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  return {
    push(chunk) {
      if (discarding) {
        const at = chunk.search(/[\r\n]/)
        if (at < 0) return
        discarding = false
        skipLf = chunk[at] === '\r' && at === chunk.length - 1
        if (chunk[at] === '\r' && chunk[at + 1] === '\n') chunk = chunk.slice(at + 2)
        else chunk = chunk.slice(at + 1)
      }
      buffer += chunk
      let start = 0
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i]
        if (skipLf && i === start) {
          skipLf = false
          if (c === '\n') {
            start = i + 1
            continue
          }
        }
        if (c === '\n' || c === '\r') {
          line(buffer.slice(start, i))
          start = i + 1
          if (c === '\r') {
            if (buffer[i + 1] === '\n') {
              i++
              start = i + 1
            } else if (i + 1 >= buffer.length) skipLf = true
          }
        }
      }
      buffer = buffer.slice(start)
      if (buffer.length > maxLine) {
        buffer = ''
        discarding = true
      }
    },
    reset() {
      buffer = ''
      id = undefined
      event = ''
      data = []
      retry = undefined
      skipLf = false
      discarding = false
      dataChars = 0
      tooBig = false
    },
  }
}
