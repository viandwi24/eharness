/** Key names for `press` and for live key input (`Enter`, `Control+a`) → CDP key events. */

/** A key as CDP wants it. */
export interface KeyDef {
  key: string
  code: string
  keyCode: number
  /** Text the key inserts when no modifier other than Shift is held. */
  text?: string
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

const ALIASES: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  ' ': 'space',
  spacebar: 'space',
}

/** Modifier bits of `Input.dispatchKeyEvent`. */
export const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 } as const

const MODIFIER_NAMES: Record<string, keyof typeof MODIFIER_BITS> = {
  alt: 'alt',
  option: 'alt',
  control: 'control',
  ctrl: 'control',
  controlormeta: 'control',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  shift: 'shift',
}

/** Editing commands Chrome runs for a shortcut (`Control+a` selects all in headless too). */
const COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
}

/** The definition of one key name, or `undefined` when unknown. */
export function keyDefinition(name: string): KeyDef | undefined {
  const lower = name.toLowerCase()
  const named = NAMED[ALIASES[lower] ?? lower]
  if (named) return named
  const fn = /^f([1-9]|1[0-2])$/.exec(lower)
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) }
  if ([...name].length === 1) {
    const ch = name
    if (/[a-z]/i.test(ch)) {
      const upper = ch.toUpperCase()
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch }
    }
    if (/[0-9]/.test(ch))
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch }
    return { key: ch, code: '', keyCode: ch.charCodeAt(0), text: ch }
  }
  return undefined
}

/** A parsed combination such as `Control+Shift+a`. */
export interface KeyCombo {
  modifiers: number
  def: KeyDef
  /** Editing command for the shortcut, when there is one. */
  commands?: string[]
}

/**
 * Parse `Enter`, `Control+a`, `Shift+Tab`. Returns an `ERROR:` string for an unknown key.
 */
export function parseKeyCombo(input: string): KeyCombo | string {
  const parts = input.length > 1 ? input.split('+') : [input]
  // A literal "+" key: "+" or "Control++".
  if (input.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  const last = parts.pop() ?? ''
  let modifiers = 0
  for (const p of parts) {
    const m = MODIFIER_NAMES[p.toLowerCase()]
    if (!m)
      return `ERROR: unknown modifier "${p}" in key "${input}". Use Control, Shift, Alt or Meta.`
    modifiers |= MODIFIER_BITS[m]
  }
  const def = keyDefinition(last)
  if (!def) {
    return `ERROR: unknown key "${last}". Use a name such as Enter, Tab, Escape, ArrowDown, or a single character.`
  }
  const combo: KeyCombo = { modifiers, def }
  if ((modifiers & (MODIFIER_BITS.control | MODIFIER_BITS.meta)) !== 0) {
    const cmd = COMMANDS[def.key.toLowerCase()]
    if (cmd) combo.commands = [cmd]
  }
  return combo
}

/** The `Input.dispatchKeyEvent` params pair (down, up) of a combination. */
export function keyEvents(combo: KeyCombo): Array<Record<string, unknown>> {
  const { def, modifiers } = combo
  const shiftOnly = (modifiers & ~MODIFIER_BITS.shift) === 0
  const text = shiftOnly ? def.text : undefined
  const shifted = text && modifiers & MODIFIER_BITS.shift ? text.toUpperCase() : text
  const base = {
    modifiers,
    key: modifiers & MODIFIER_BITS.shift && def.key.length === 1 ? def.key.toUpperCase() : def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  }
  const down: Record<string, unknown> = {
    type: shifted ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(shifted ? { text: shifted, unmodifiedText: def.text } : {}),
    ...(combo.commands ? { commands: combo.commands } : {}),
  }
  return [down, { type: 'keyUp', ...base }]
}
