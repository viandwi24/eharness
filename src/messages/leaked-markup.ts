/**
 * Leaked tool-call markup (spec 03 §11): some open-weight models (DeepSeek DSML, Qwen/Hermes,
 * Kimi, Anthropic-style `<function_calls>`) emit their native tool-call syntax as plain text. A
 * provider parses most of it into a real tool call but can leak a fragment, e.g. the tail
 * `url" string="true">https://example.com` of a `<｜DSML｜parameter name="url" string="true">`.
 *
 * `stripLeakedToolMarkup` removes only recognised markup, never prose and never fenced code.
 */
import type { UIMessageChunk } from 'ai'

const FULL_WIDTH_BAR = '｜'
const BAR = `[${FULL_WIDTH_BAR}|]`
const NAME = '(?:tool[_▁]calls?|function_calls|invoke|parameter|function)'

/** Closed blocks of known tool-call markup. */
const BLOCKS: RegExp[] = [
  new RegExp(`<${BAR}(?:DSML${BAR})?tool_calls>[\\s\\S]*?</${BAR}(?:DSML${BAR})?tool_calls>`, 'g'),
  /<[｜|]tool[▁_]calls[▁_]begin[｜|]>[\s\S]*?<[｜|]tool[▁_]calls[▁_]end[｜|]>/g,
  /<[｜|]tool_calls_section_begin[｜|]>[\s\S]*?<[｜|]tool_calls_section_end[｜|]>/g,
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  /<function_calls>[\s\S]*?<\/function_calls>/g,
]
/** An opener of the exotic-token forms with no closer: everything after it is markup. */
const UNCLOSED: RegExp[] = [
  /<[｜|]DSML[｜|]\w+[\s\S]*$/,
  /<[｜|]tool[▁_]calls[▁_]begin[｜|]>[\s\S]*$/,
  /<[｜|]tool_calls_section_begin[｜|]>[\s\S]*$/,
]
/** Stray single DSML tags (`<｜DSML｜parameter name="x">`, `</｜DSML｜invoke>`). */
const STRAY_DSML = /<\/?[｜|]DSML[｜|][^<>\n]{0,200}>/g
/** Whole text part = the tail of a parameter tag: `url" string="true">value`. */
const PARAM_TAIL = /^[\w.-]{1,64}"\s+string="(?:true|false)"\s*>[\s\S]*$/

function mapOutsideFences(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('')
}

/**
 * Remove recognised tool-call markup from model text: closed blocks, unclosed exotic-token blocks,
 * stray DSML tags, and a text that is entirely a parameter-tail fragment. Fenced code is untouched.
 * Returns the input unchanged (same string) when nothing matched.
 */
export function stripLeakedToolMarkup(text: string): string {
  if (!/[<"]/.test(text)) return text
  if (PARAM_TAIL.test(text.trim()) && !text.includes('```')) return ''
  const out = mapOutsideFences(text, (s) => {
    let r = s
    for (const re of BLOCKS) r = r.replace(re, '')
    for (const re of UNCLOSED) r = r.replace(re, '')
    return r.replace(STRAY_DSML, '')
  })
  return out === text ? text : out.trim() === '' ? '' : out.trim()
}

const HOLD_CHARS = 14
const LEAK_START = new RegExp(`^<(?:${BAR}|/?${NAME}\\b)`)
const TAIL_START = /^[\w.-]{1,64}"/

/** Whether the (trimmed) beginning of a text part could be leaked markup. */
function suspicious(head: string): boolean {
  return LEAK_START.test(head) || TAIL_START.test(head)
}

type TextChunk = Extract<UIMessageChunk, { type: 'text-start' | 'text-delta' | 'text-end' }>

/**
 * Stream filter for the step's chunks. It holds a text part only while its first characters are
 * undecided (a few characters) or look like markup; a normal part streams unchanged. A held part is
 * cleaned at `text-end` (dropped when nothing remains) and replayed in chunk order, so every other
 * chunk keeps its position.
 */
export function createLeakFilter(): {
  push(chunk: UIMessageChunk): UIMessageChunk[]
  flush(): UIMessageChunk[]
} {
  const open = new Map<
    string,
    { queue: UIMessageChunk[]; text: string; mode: 'undecided' | 'hold' }
  >()

  function release(id: string): UIMessageChunk[] {
    const s = open.get(id)
    if (s === undefined) return []
    open.delete(id)
    const cleaned = stripLeakedToolMarkup(s.text)
    const out: UIMessageChunk[] = []
    let wrote = false
    for (const c of s.queue) {
      if (c.type === 'text-delta') {
        if (cleaned !== '' && !wrote) {
          out.push({ ...(c as TextChunk), delta: cleaned } as UIMessageChunk)
          wrote = true
        }
      } else if (c.type === 'text-start' || c.type === 'text-end') {
        if (cleaned !== '') out.push(c)
      } else out.push(c)
    }
    return out
  }

  return {
    push(chunk) {
      const t = chunk.type
      if (t === 'text-start') {
        const id = (chunk as { id: string }).id
        open.set(id, { queue: [chunk], text: '', mode: 'undecided' })
        return []
      }
      if (t === 'text-delta' || t === 'text-end') {
        const id = (chunk as { id: string }).id
        const s = open.get(id)
        if (s === undefined) return [chunk]
        if (t === 'text-delta') s.text += (chunk as { delta: string }).delta
        s.queue.push(chunk)
        if (s.mode === 'undecided' && (t === 'text-end' || s.text.trim().length >= HOLD_CHARS)) {
          s.mode = suspicious(s.text.trim()) ? 'hold' : 'undecided'
          if (s.mode === 'undecided') {
            // normal text: pass what was held and stream on
            open.delete(id)
            return [...s.queue]
          }
        }
        if (t === 'text-end') return release(id)
        return []
      }
      // another chunk kind: keep order behind any part that is still held or undecided
      if (open.size > 0) {
        const s = [...open.values()].at(-1)
        s?.queue.push(chunk)
        return []
      }
      return [chunk]
    },
    flush() {
      const out: UIMessageChunk[] = []
      for (const id of [...open.keys()]) out.push(...release(id))
      return out
    },
  }
}
