/**
 * Fullscreen pages on the terminal's alternate screen.
 *
 * Ink 8's `alternateScreen` render option is fixed for the lifetime of the instance, so it cannot
 * toggle per page, and `<Static>` scrollback (the conversation) lives on the primary screen. The
 * pages therefore switch the screen by hand, in four ordered steps that keep Ink's idea of "the
 * live area" truthful on both screens:
 *
 * 1. `entering`: the live area (prompt, footer, dialogs) is hidden. Ink erases it on the primary
 *    screen and keeps `<Static>` untouched. After `waitUntilRenderFlush()` the cursor sits where
 *    the live area started.
 * 2. `open`: `ESC[?1049h` saves that cursor, switches to the alternate screen and clears it. The
 *    page renders as the (only) live area, one row shorter than the terminal so Ink never takes
 *    its "frame fills the viewport" full-clear path.
 * 3. `leaving`: the page is hidden; Ink erases its frame on the alternate screen.
 * 4. `closed`: `ESC[?1049l` restores the primary screen and the saved cursor; the live area renders
 *    again from the same spot.
 *
 * While a page is open the held `<Static>` state is frozen by the caller, so nothing is printed to
 * the alternate screen and nothing is printed twice afterwards.
 */
import { useApp, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageSpec } from './spec.ts'

/** Enter the alternate screen (saves the cursor) and clear it. */
export const ALT_SCREEN_ON = '\x1b[?1049h\x1b[2J\x1b[H'
/** Leave the alternate screen (restores the cursor). */
export const ALT_SCREEN_OFF = '\x1b[?1049l'

const FLUSH_CAP_MS = 150

/** Phase of the page host. */
export type PageView =
  | { phase: 'closed' }
  | { phase: 'entering' | 'open' | 'leaving'; page: PageSpec }

/** What {@link usePageHost} returns. */
export interface PageHost {
  view: PageView
  /** The page being shown or transitioning, if any. */
  page: PageSpec | null
  /** True from `entering` to `leaving`: the live area must be hidden. */
  active: boolean
  /** Open a page (replaces the open one without leaving the alternate screen). */
  open(page: PageSpec): void
  /** Close the open page (a transcript with a `parent` returns to it). */
  close(): void
}

/** The state machine behind fullscreen pages. */
export function usePageHost(): PageHost {
  const { waitUntilRenderFlush } = useApp()
  const { stdout } = useStdout()
  const [view, setView] = useState<PageView>({ phase: 'closed' })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    if (view.phase !== 'entering' && view.phase !== 'leaving') return
    let cancelled = false
    const { phase } = view
    void (async () => {
      // a stream that never calls the write callback (test doubles) must not hang the page
      await Promise.race([waitUntilRenderFlush(), new Promise((r) => setTimeout(r, FLUSH_CAP_MS))])
      if (cancelled) return
      if (phase === 'entering') {
        stdout.write(ALT_SCREEN_ON)
        setView({ phase: 'open', page: view.page })
      } else {
        stdout.write(ALT_SCREEN_OFF)
        setView({ phase: 'closed' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view, stdout, waitUntilRenderFlush])

  // leave the alternate screen if the app unmounts while a page is open
  useEffect(
    () => () => {
      if (viewRef.current.phase === 'open') {
        try {
          stdout.write(ALT_SCREEN_OFF)
        } catch {}
      }
    },
    [stdout],
  )

  const open = useCallback((page: PageSpec) => {
    const current = viewRef.current
    if (current.phase === 'closed') setView({ phase: 'entering', page })
    else if (current.phase === 'open') setView({ phase: 'open', page })
  }, [])

  const close = useCallback(() => {
    const current = viewRef.current
    if (current.phase !== 'open') return
    const parent =
      current.page.kind === 'transcript' || current.page.kind === 'agent'
        ? current.page.parent
        : undefined
    setView(parent ? { phase: 'open', page: parent } : { phase: 'leaving', page: current.page })
  }, [])

  return {
    view,
    page: view.phase === 'closed' ? null : view.page,
    active: view.phase !== 'closed',
    open,
    close,
  }
}
