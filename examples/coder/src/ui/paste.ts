/** Large-paste and image chips of the prompt: `[Pasted text #1 +20 lines]`, `[Image #2]`. */
import type { FileUIPart } from 'ai'
import { type Buffer, insert } from './editor.ts'

/** A paste over this many characters becomes a chip. */
export const PASTE_CHIP_CHARS = 800
/** A paste over this many lines becomes a chip. */
export const PASTE_CHIP_LINES = 10

/** Does this pasted text collapse into a chip? */
export function shouldChip(text: string): boolean {
  return text.length > PASTE_CHIP_CHARS || text.split('\n').length > PASTE_CHIP_LINES
}

/** Content behind the chips of one prompt (cleared after each submit). */
export class PasteStore {
  private next = 1
  readonly texts = new Map<number, string>()
  readonly images = new Map<number, FileUIPart>()

  /** Store a pasted text; returns the chip to show in the prompt. */
  addText(text: string): string {
    const id = this.next++
    this.texts.set(id, text)
    return `[Pasted text #${id} +${text.split('\n').length} lines]`
  }

  /** Store an image; returns the chip to show in the prompt. */
  addImage(file: FileUIPart): string {
    const id = this.next++
    this.images.set(id, file)
    return `[Image #${id}]`
  }

  clear(): void {
    this.next = 1
    this.texts.clear()
    this.images.clear()
  }
}

/** A chip found in the prompt text. */
export interface Chip {
  start: number
  end: number
  kind: 'text' | 'image'
  id: number
}

const CHIP = /\[(?:Pasted text #(\d+) \+\d+ lines|Image #(\d+))\]/g

/** Chips in the text that are backed by the store (lookalikes the user typed are plain text). */
export function findChips(text: string, store: PasteStore): Chip[] {
  const chips: Chip[] = []
  for (const m of text.matchAll(CHIP)) {
    const kind = m[1] !== undefined ? 'text' : 'image'
    const id = Number(m[1] ?? m[2])
    if (!(kind === 'text' ? store.texts : store.images).has(id)) continue
    const start = m.index ?? 0
    chips.push({ start, end: start + m[0].length, kind, id })
  }
  return chips
}

/** The submitted text: pasted-text chips expanded to their content. Image chips stay as markers. */
export function expandPastes(text: string, store: PasteStore): string {
  return text.replace(CHIP, (whole, textId?: string) => {
    if (textId === undefined) return whole
    return store.texts.get(Number(textId)) ?? whole
  })
}

/** Images of the prompt in the order their chips appear in the text. */
export function imagesInOrder(text: string, store: PasteStore): FileUIPart[] {
  const files: FileUIPart[] = []
  for (const chip of findChips(text, store)) {
    const file = chip.kind === 'image' ? store.images.get(chip.id) : undefined
    if (file) files.push(file)
  }
  return files
}

/** Insert a paste: a chip when it is large, the text itself otherwise. */
export function insertPaste(buf: Buffer, text: string, store: PasteStore): Buffer {
  return insert(buf, shouldChip(text) ? store.addText(text) : text)
}

/** Backspace that removes a whole chip when the cursor is inside or right after one. */
export function backspaceChip(buf: Buffer, store: PasteStore): Buffer | undefined {
  const chip = findChips(buf.text, store).find((c) => buf.cursor > c.start && buf.cursor <= c.end)
  if (!chip) return undefined
  return { text: buf.text.slice(0, chip.start) + buf.text.slice(chip.end), cursor: chip.start }
}

/** Delete that removes a whole chip when the cursor is at or inside one. */
export function deleteChip(buf: Buffer, store: PasteStore): Buffer | undefined {
  const chip = findChips(buf.text, store).find((c) => buf.cursor >= c.start && buf.cursor < c.end)
  if (!chip) return undefined
  return { text: buf.text.slice(0, chip.start) + buf.text.slice(chip.end), cursor: chip.start }
}

/** Arrow-key move that jumps over a whole chip. */
export function moveChip(buf: Buffer, dir: -1 | 1, store: PasteStore): Buffer | undefined {
  const chips = findChips(buf.text, store)
  if (dir === -1) {
    const chip = chips.find((c) => buf.cursor > c.start && buf.cursor <= c.end)
    return chip ? { ...buf, cursor: chip.start } : undefined
  }
  const chip = chips.find((c) => buf.cursor >= c.start && buf.cursor < c.end)
  return chip ? { ...buf, cursor: chip.end } : undefined
}
