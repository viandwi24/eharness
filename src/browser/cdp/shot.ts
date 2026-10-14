/**
 * Screenshots (spec 35 §4.3): JPEG quality 70 (PNG for engines without JPEG), `maxWidth` through
 * the capture clip scale (CSS pixels scaled down, never up), viewport or full page (height capped),
 * element clip, and a SHA-1 hash via `crypto.subtle` for "unchanged".
 */
import { call, errorText, objectIdOf } from './page.ts'
import { resolveRef } from './snapshot.ts'
import type { PageSession, Shot } from './types.ts'

/** Options of {@link takeScreenshot}. */
export interface ShotOptions {
  fullPage?: boolean
  ref?: string
  /** CSS pixels. Default 1280. */
  maxWidth?: number
  /** `png` for engines without JPEG (Lightpanda). Default `jpeg`. */
  format?: 'jpeg' | 'png'
  /** JPEG quality. Default 70. */
  quality?: number
}

/** Decode base64 without `Buffer`. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** SHA-1 of `bytes` as lowercase hex. */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Metrics {
  cssVisualViewport?: {
    pageX?: number
    pageY?: number
    clientWidth?: number
    clientHeight?: number
  }
  cssContentSize?: { width?: number; height?: number }
}

/**
 * Capture the viewport, the full page or one element.
 *
 * @returns the shot, or an `ERROR:` / `STALE:` string.
 */
/** Connections whose engine refused JPEG screenshots (Lightpanda: PNG only). */
const pngOnly = new WeakSet<object>()

export async function takeScreenshot(
  page: PageSession,
  options: ShotOptions = {},
  signal?: AbortSignal,
): Promise<Shot | string> {
  // an engine that takes PNG only (Lightpanda) is remembered per connection after its first refusal
  let format = options.format ?? (pngOnly.has(page.cdp) ? 'png' : 'jpeg')
  const maxWidth = Math.max(16, Math.floor(options.maxWidth ?? 1280))
  try {
    const metrics = await call<Metrics>(page, 'Page.getLayoutMetrics', undefined, signal)
    const vp = metrics.cssVisualViewport ?? {}
    let clip = {
      x: vp.pageX ?? 0,
      y: vp.pageY ?? 0,
      width: vp.clientWidth ?? 1280,
      height: vp.clientHeight ?? 800,
    }
    let beyond = false
    if (options.ref) {
      const entry = await resolveRef(page, options.ref, signal)
      if (typeof entry === 'string') return entry
      try {
        await call(
          page,
          'DOM.scrollIntoViewIfNeeded',
          { backendNodeId: entry.backendNodeId },
          signal,
        )
      } catch {}
      const box = await call<{ model?: { border?: number[] } }>(
        page,
        'DOM.getBoxModel',
        { backendNodeId: entry.backendNodeId },
        signal,
      ).catch(() => undefined)
      const q = box?.model?.border
      if (!q || q.length < 8) {
        const found = await objectIdOf(page, entry.backendNodeId, signal).catch(() => undefined)
        return found
          ? `ERROR: ${options.ref} has no visible box to capture.`
          : `STALE: ${options.ref} is no longer on the page. Take a new snapshot.`
      }
      const xs = [q[0], q[2], q[4], q[6]] as number[]
      const ys = [q[1], q[3], q[5], q[7]] as number[]
      // Box model coordinates are viewport-relative; the clip is in page coordinates.
      const x = Math.min(...xs) + (vp.pageX ?? 0)
      const y = Math.min(...ys) + (vp.pageY ?? 0)
      clip = {
        x,
        y,
        width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      }
    } else if (options.fullPage) {
      clip = {
        x: 0,
        y: 0,
        width: metrics.cssContentSize?.width ?? clip.width,
        height: Math.min(page.limits.shotMaxHeight, metrics.cssContentSize?.height ?? clip.height),
      }
      beyond = true
    }
    const scale = Math.min(1, maxWidth / clip.width)
    const params: Record<string, unknown> = {
      format,
      clip: { ...clip, scale },
      fromSurface: true,
      captureBeyondViewport: beyond,
    }
    if (format === 'jpeg') params.quality = options.quality ?? 70
    let res: { data?: string }
    try {
      res = await call<{ data?: string }>(page, 'Page.captureScreenshot', params, signal)
    } catch (error) {
      if (format !== 'jpeg' || !/unsupported screenshot format/i.test(errorText(error))) throw error
      pngOnly.add(page.cdp)
      format = 'png'
      delete params.quality
      res = await call<{ data?: string }>(
        page,
        'Page.captureScreenshot',
        { ...params, format },
        signal,
      )
    }
    if (typeof res.data !== 'string' || res.data === '') {
      return 'ERROR: the browser returned no image.'
    }
    const bytes = base64ToBytes(res.data)
    return {
      bytes,
      mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
      width: Math.max(1, Math.round(clip.width * scale)),
      height: Math.max(1, Math.round(clip.height * scale)),
      hash: await sha1Hex(bytes),
    }
  } catch (error) {
    return signal?.aborted ? 'ERROR: aborted.' : `ERROR: ${errorText(error)}`
  }
}
