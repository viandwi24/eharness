/**
 * A message text with its formatting entities as Telegram HTML (the subset every transport here
 * accepts with `format: 'html'`), so an edit synced to a copy keeps bold, links and code. Offsets
 * are UTF-16 code units, like the entities. Pure.
 */
import { escapeHtml } from '../telegram/format.ts'
import type { MessageEntity } from './model.ts'

const TAGS: Partial<Record<MessageEntity['type'], [string, string]>> = {
  bold: ['<b>', '</b>'],
  italic: ['<i>', '</i>'],
  underline: ['<u>', '</u>'],
  strike: ['<s>', '</s>'],
  code: ['<code>', '</code>'],
  spoiler: ['<tg-spoiler>', '</tg-spoiler>'],
  quote: ['<blockquote>', '</blockquote>'],
}

function tagsOf(e: MessageEntity): [string, string] | undefined {
  if (e.type === 'link' && e.url !== undefined) return [`<a href="${escapeHtml(e.url)}">`, '</a>']
  if (e.type === 'pre')
    return e.language === undefined
      ? ['<pre>', '</pre>']
      : [`<pre><code class="language-${escapeHtml(e.language)}">`, '</code></pre>']
  if (e.type === 'custom_emoji' && e.customEmojiId !== undefined)
    return [`<tg-emoji emoji-id="${escapeHtml(e.customEmojiId)}">`, '</tg-emoji>']
  return TAGS[e.type]
}

export function entitiesToHtml(text: string, entities: readonly MessageEntity[]): string {
  // opening and closing tags per position; nested entities close in reverse order
  const opens = new Map<number, Array<{ tag: string; end: number }>>()
  const closes = new Map<number, string[]>()
  const sorted = entities
    .filter((e) => e.length > 0 && e.offset >= 0 && e.offset + e.length <= text.length)
    .map((e) => ({ e, tags: tagsOf(e) }))
    .filter((x): x is { e: MessageEntity; tags: [string, string] } => x.tags !== undefined)
    .sort((a, b) => a.e.offset - b.e.offset || b.e.length - a.e.length)
  for (const { e, tags } of sorted) {
    const end = e.offset + e.length
    const list = opens.get(e.offset) ?? []
    list.push({ tag: tags[0], end })
    opens.set(e.offset, list)
    const c = closes.get(end) ?? []
    c.unshift(tags[1])
    closes.set(end, c)
  }
  let out = ''
  for (let i = 0; i <= text.length; i++) {
    for (const tag of closes.get(i) ?? []) out += tag
    for (const o of opens.get(i) ?? []) out += o.tag
    if (i < text.length) out += escapeHtml(text[i] as string)
  }
  return out
}
