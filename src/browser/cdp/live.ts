/**
 * Live view and remote input (spec 35 §7): `Page.startScreencast` with ack-on-read backpressure, a
 * poll mode (a screenshot every 500 ms, sent only when the hash changed), and the mapping of
 * `LiveInput` to `Input.*` commands. The manager adds controller rules on top (phase C).
 */

import { keyDefinition, keyEvents, parseKeyCombo } from './keys.ts'
import { call, errorText } from './page.ts'
import { base64ToBytes, takeScreenshot } from './shot.ts'
import type { LiveFeed, LiveFrame, LiveInput, PageSession } from './types.ts'

/** Options of {@link startLive}. */
export interface LiveOptions {
  mode: 'screencast' | 'poll'
  /** Poll interval, ms. Default 500. */
  pollMs?: number
  /** JPEG quality of screencast frames. Default 60. */
  quality?: number
  /** Widest frame in CSS pixels. Default 1280. */
  maxWidth?: number
  /** PNG frames for poll mode on engines without JPEG. */
  format?: 'jpeg' | 'png'
  /** Resolve the page that input goes to (follows tab switches). Default: the started page. */
  currentPage?: () => PageSession | undefined
}

const BUTTONS = { left: 1, right: 2, middle: 4 } as const

/** A CDP command. */
export interface CdpCommand {
  method: string
  params: Record<string, unknown>
}

/**
 * Map one `LiveInput` to CDP commands. Pure. Returns an `ERROR:` string for a malformed event.
 */
export function mapLiveInput(event: LiveInput): CdpCommand[] | string {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  switch (event.type) {
    case 'mouse': {
      if (!finite(event.x) || !finite(event.y)) return 'ERROR: mouse input needs numeric x and y.'
      const button = event.button ?? 'left'
      const base = {
        x: event.x,
        y: event.y,
        modifiers: event.modifiers ?? 0,
        pointerType: 'mouse',
      }
      switch (event.event) {
        case 'move':
          return [
            {
              method: 'Input.dispatchMouseEvent',
              params: { type: 'mouseMoved', ...base, button: 'none' },
            },
          ]
        case 'down':
          return [
            {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mousePressed',
                ...base,
                button,
                buttons: BUTTONS[button],
                clickCount: event.clickCount ?? 1,
              },
            },
          ]
        case 'up':
          return [
            {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseReleased',
                ...base,
                button,
                buttons: 0,
                clickCount: event.clickCount ?? 1,
              },
            },
          ]
        case 'wheel':
          return [
            {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseWheel',
                ...base,
                deltaX: finite(event.deltaX) ? event.deltaX : 0,
                deltaY: finite(event.deltaY) ? event.deltaY : 0,
              },
            },
          ]
        default:
          return `ERROR: unknown mouse event "${String((event as { event?: unknown }).event)}".`
      }
    }
    case 'key': {
      if (typeof event.key !== 'string' || event.key === '') return 'ERROR: key input needs a key.'
      const def = keyDefinition(event.key)
      const modifiers = event.modifiers ?? 0
      const base: Record<string, unknown> = {
        key: event.key,
        code: event.code ?? def?.code ?? '',
        modifiers,
        ...(def ? { windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode } : {}),
      }
      if (event.event === 'up')
        return [{ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } }]
      if (event.event === 'char') {
        const text = event.text ?? (event.key.length === 1 ? event.key : undefined)
        if (text === undefined) return 'ERROR: a char key event needs text.'
        return [
          {
            method: 'Input.dispatchKeyEvent',
            params: { type: 'char', ...base, text, unmodifiedText: text },
          },
        ]
      }
      if (event.event === 'down') {
        const text = event.text
        return [
          {
            method: 'Input.dispatchKeyEvent',
            params: text
              ? { type: 'keyDown', ...base, text, unmodifiedText: text }
              : { type: 'rawKeyDown', ...base },
          },
        ]
      }
      return `ERROR: unknown key event "${String((event as { event?: unknown }).event)}".`
    }
    case 'text':
      if (typeof event.text !== 'string') return 'ERROR: text input needs text.'
      return [{ method: 'Input.insertText', params: { text: event.text } }]
    case 'navigate':
      if (typeof event.url !== 'string' || event.url === '') return 'ERROR: navigate needs a url.'
      return [{ method: 'Page.navigate', params: { url: event.url } }]
    default:
      return 'ERROR: unknown input type.'
  }
}

/** Send a key combination such as `Control+a` (used by tests and by `press`). */
export function comboCommands(input: string): CdpCommand[] | string {
  const combo = parseKeyCombo(input)
  if (typeof combo === 'string') return combo
  return keyEvents(combo).map((params) => ({ method: 'Input.dispatchKeyEvent', params }))
}

/**
 * Start a live feed of the page. `frames` is pull-based: in screencast mode a frame is acked to
 * Chrome only after the consumer read the previous one, so a slow viewer slows the browser instead
 * of growing a queue.
 */
export async function startLive(page: PageSession, options: LiveOptions): Promise<LiveFeed> {
  const screencast = options.mode === 'screencast'
  const maxWidth = options.maxWidth ?? 1280
  const metrics = await call<{
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
  }>(page, 'Page.getLayoutMetrics').catch(() => ({}) as { cssVisualViewport?: undefined })
  const info = {
    width: metrics.cssVisualViewport?.clientWidth ?? 1280,
    height: metrics.cssVisualViewport?.clientHeight ?? 800,
    liveView: options.mode,
  }

  let seq = 0
  let closed = false
  let unacked: number | undefined
  let stream: ReadableStreamDefaultController<LiveFrame> | undefined
  const cleanups: Array<() => void> = []

  const ack = (id: number): void => {
    void call(page, 'Page.screencastFrameAck', { sessionId: id }).catch(() => {})
  }
  const stop = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const c of cleanups.splice(0)) c()
    if (screencast) await call(page, 'Page.stopScreencast').catch(() => {})
    try {
      stream?.close()
    } catch {}
  }

  const frames = new ReadableStream<LiveFrame>(
    {
      async start(controller) {
        stream = controller
        cleanups.push(page.cdp.onClose(() => void stop()))
        if (screencast) {
          cleanups.push(
            page.cdp.on('Page.screencastFrame', (p, sid) => {
              if (sid !== page.sessionId || closed) return
              const ackId = typeof p.sessionId === 'number' ? p.sessionId : undefined
              const meta = (p.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
              if (typeof p.data !== 'string') {
                if (ackId !== undefined) ack(ackId)
                return
              }
              if (meta.deviceWidth) info.width = meta.deviceWidth
              if (meta.deviceHeight) info.height = meta.deviceHeight
              if (unacked !== undefined && ackId !== undefined) {
                // Chrome waits for the ack, so this is unexpected: keep the order, drop the extra.
                ack(ackId)
                return
              }
              unacked = ackId
              controller.enqueue({
                seq: ++seq,
                data: base64ToBytes(p.data),
                mediaType: 'image/jpeg',
                width: info.width,
                height: info.height,
                at: Date.now(),
              })
            }),
          )
          await call(page, 'Page.startScreencast', {
            format: 'jpeg',
            quality: options.quality ?? 60,
            maxWidth,
            maxHeight: maxWidth,
            everyNthFrame: 1,
          })
        } else {
          let last = ''
          let busy = false
          const tick = async (): Promise<void> => {
            if (busy || closed || (controller.desiredSize ?? 0) <= 0) return
            busy = true
            try {
              const shot = await takeScreenshot(page, {
                maxWidth,
                ...(options.format === undefined ? {} : { format: options.format }),
                quality: options.quality ?? 60,
              })
              if (typeof shot !== 'string' && shot.hash !== last && !closed) {
                last = shot.hash
                controller.enqueue({
                  seq: ++seq,
                  data: shot.bytes,
                  mediaType: shot.mediaType,
                  width: info.width,
                  height: info.height,
                  at: Date.now(),
                })
              }
            } finally {
              busy = false
            }
          }
          const timer = setInterval(() => void tick(), options.pollMs ?? 500)
          cleanups.push(() => clearInterval(timer))
          void tick()
        }
      },
      pull() {
        // The consumer drained the queue: the previous frame was read, ack it so Chrome sends more.
        if (unacked !== undefined) {
          ack(unacked)
          unacked = undefined
        }
      },
      cancel() {
        return stop()
      },
    },
    { highWaterMark: 1 },
  )

  return {
    info,
    frames,
    async input(event) {
      const commands = mapLiveInput(event)
      if (typeof commands === 'string') return commands
      const target = options.currentPage?.() ?? page
      try {
        for (const c of commands) await call(target, c.method, c.params)
      } catch (error) {
        return `ERROR: ${errorText(error)}`
      }
      return undefined
    },
    close: stop,
  }
}
