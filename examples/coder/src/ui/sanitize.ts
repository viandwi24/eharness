/** Terminal-safety helpers for text that comes from the model or from tool input. */

// OSC (`ESC ] … BEL|ST`), CSI (`ESC [ … final`), and any other two-character escape.
const ESCAPES = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b\\[[0-?]*[ -/]*[@-~]?',
    '\\u001b[@-Z\\\\-_]?',
  ].join('|'),
  'g',
)
// C0 controls except \t and \n, DEL, and C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Remove ANSI escape sequences and control characters (keeping newline and tab) so untrusted text
 * cannot move the cursor, recolor the screen or spoof the approval prompt.
 */
export function stripControl(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, '')
}

/**
 * Replace tabs with spaces up to the next tab stop. Ink counts a tab as one column while the
 * terminal jumps to the next stop, so a tab in a `cat -n` style file listing makes lines wider than
 * Ink thinks: they wrap or overwrite their neighbours. Expand per line, before rendering.
 */
export function expandTabs(text: string, size = 4): string {
  if (!text.includes('\t')) return text
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\t')) return line
      let out = ''
      for (const ch of line) out += ch === '\t' ? ' '.repeat(size - (out.length % size)) : ch
      return out
    })
    .join('\n')
}
