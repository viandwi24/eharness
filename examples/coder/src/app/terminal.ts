/**
 * Terminal state the UI changes and a crash or signal must undo: the alternate screen (fullscreen
 * pages, `ui/pages/host.ts`), the cursor and raw input mode. `restoreTerminal` is idempotent and
 * synchronous so it can run from signal handlers and the `exit` event.
 */

const ALT_SCREEN_OFF = '\x1b[?1049l'
const SHOW_CURSOR = '\x1b[?25h'
const BRACKETED_PASTE_OFF = '\x1b[?2004l'

let altScreenActive = false

/** Called by the page host when it enters or leaves the alternate screen. */
export function markAltScreen(active: boolean): void {
  altScreenActive = active
}

/** Leave the alternate screen, show the cursor and turn raw mode off. Never throws. */
export function restoreTerminal(): void {
  try {
    if (process.stdout.isTTY) {
      let out = ''
      if (altScreenActive) out += ALT_SCREEN_OFF
      out += BRACKETED_PASTE_OFF + SHOW_CURSOR
      process.stdout.write(out)
    }
    altScreenActive = false
  } catch {
    // the terminal is gone: nothing to restore
  }
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false)
  } catch {
    // stdin already closed
  }
}
