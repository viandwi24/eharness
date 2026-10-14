/**
 * Shared types of the CDP core (`src/browser/cdp/*`). The module surface (`adapter.ts`) re-exports
 * the public ones under the names of spec 35 §4.
 *
 * @see docs/specs/35-browser.md
 */
import type { CdpClient } from './client.ts'

/** The page a tool talks about: always plain data, never a handle. */
export interface PageInfo {
  url: string
  title: string
}

/** Tunable sizes and waits (spec 35 §4, `BrowserLimits`). */
export interface CdpLimits {
  /** Snapshot size cap in characters. Default 20 000. */
  snapshotChars: number
  /** `read` size cap in characters. Default 30 000. */
  readChars: number
  /** Longest `wait untilText`, ms. Default 10 000. */
  waitMs: number
  /** Default per-command timeout, ms. Default 30 000. */
  timeoutMs: number
  /** Navigation timeout, ms. Default 30 000. */
  navigateMs: number
  /** Longest settle after an action, ms. Default 2 000. */
  settleMs: number
  /** Network quiet period that counts as idle, ms. Default 300. */
  quietMs: number
  /** Full-page screenshot height cap in CSS pixels. Default 8 000. */
  shotMaxHeight: number
}

/** The defaults of {@link CdpLimits}. */
export const DEFAULT_CDP_LIMITS: CdpLimits = {
  snapshotChars: 20_000,
  readChars: 30_000,
  waitMs: 10_000,
  timeoutMs: 30_000,
  navigateMs: 30_000,
  settleMs: 2_000,
  quietMs: 300,
  shotMaxHeight: 8_000,
}

/** What a stored ref points at (spec 35 §4.1). */
export interface RefEntry {
  ref: string
  /** The newest snapshot that listed this element. */
  snapshotId: string
  frameId: string
  /** The frame's document (loader id) when the ref was issued. */
  loaderId: string
  backendNodeId: number
  role: string
  name: string
  /** Set for a node inside a cross-site (out-of-process) iframe: the action says "not supported". */
  unsupported?: string
}

/** Refs and snapshot ids of one lease (the counters never restart, so a ref is never reused). */
export interface RefStore {
  readonly entries: Map<string, RefEntry>
  /** Newest snapshot id, if any. */
  lastSnapshotId?: string
  nextSnapshotId(): string
  /** The ref of an element already listed in this document, or a new one. */
  refFor(frameId: string, loaderId: string, backendNodeId: number): string
  /** Forget every ref (hand back, tab switch). The counters keep going. */
  clear(): void
}

/** One attached page (tab): its flattened session, refs and network state. */
export interface PageSession {
  cdp: CdpClient
  targetId: string
  sessionId: string
  refs: RefStore
  limits: CdpLimits
  /** Frame ids of cross-site iframes attached as their own targets. */
  oopifs: Set<string>
  /** Requests in flight and the time of the last network event. */
  net: { inflight: Map<string, number>; lastActivity: number }
  /** One-line notes (a dialog was dismissed, ...) shown with the next result, then cleared. */
  notes: string[]
  /** Stop listening and forget the page. */
  dispose(): void
}

/** `browser_snapshot` result. */
export interface Snapshot {
  id: string
  text: string
  page: PageInfo
  /** Offset for the next call when `text` was truncated. */
  nextOffset?: number
  /** Refs listed in this snapshot. */
  refCount: number
}

/** `browser_act` input (flat on purpose, spec 35 §4.2). */
export interface ActInput {
  ref?: string
  kind:
    | 'click'
    | 'double_click'
    | 'hover'
    | 'fill'
    | 'type'
    | 'press'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'scroll'
    | 'wait'
  text?: string
  key?: string
  values?: string[]
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  ms?: number
  untilText?: string
}

/** `browser_act` result. A failure keeps `error` (an `ERROR:`/`STALE:`/`BLOCKED:` string). */
export interface ActResult {
  page: PageInfo
  navigated: boolean
  changed: boolean
  /** Status text for the model, e.g. `Clicked e5 (button "Submit")`. */
  summary: string
  note?: string
  error?: string
}

/** A screenshot (spec 35 §4.3). */
export interface Shot {
  bytes: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** SHA-1 of `bytes`, hex. */
  hash: string
}

/** One tab as the model sees it. */
export interface TabInfo {
  /** `t1`, `t2`, ... stable for the connection. */
  id: string
  url: string
  title: string
  active: boolean
}

/** Remote input from a person (spec 35 §7); coordinates are CSS pixels of the frame. */
export type LiveInput =
  | {
      type: 'mouse'
      event: 'move' | 'down' | 'up' | 'wheel'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      deltaX?: number
      deltaY?: number
      modifiers?: number
    }
  | {
      type: 'key'
      event: 'down' | 'up' | 'char'
      key: string
      code?: string
      text?: string
      modifiers?: number
    }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }

/** One live frame. `width`/`height` are the CSS pixel size input coordinates refer to. */
export interface LiveFrame {
  seq: number
  data: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  at: number
}

/** Live view without the manager's controller rules (those are phase C). */
export interface LiveFeed {
  info: { width: number; height: number; liveView: 'screencast' | 'poll' }
  frames: ReadableStream<LiveFrame>
  /** Returns an `ERROR:` string for a bad event, otherwise nothing. */
  input(event: LiveInput): Promise<string | undefined>
  close(): Promise<void>
}
