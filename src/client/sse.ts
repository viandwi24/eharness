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

/** Create a parser; `onMessage` runs for every complete event that has data. */
export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = ''
  let id: string | undefined
  let event = ''
  let data: string[] = []
  let retry: number | undefined
  let lastId: string | undefined
  let skipLf = false

  const dispatch = (): void => {
    if (id !== undefined) lastId = id
    if (data.length > 0) {
      const message: SseMessage = { event: event || 'message', data: data.join('\n') }
      if (lastId !== undefined) message.id = lastId
      if (retry !== undefined) message.retry = retry
      onMessage(message)
    }
    id = undefined
    event = ''
    data = []
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
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') {
      if (!value.includes('\0')) id = value
    } else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  return {
    push(chunk) {
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
    },
    reset() {
      buffer = ''
      id = undefined
      event = ''
      data = []
      retry = undefined
      skipLf = false
    },
  }
}
