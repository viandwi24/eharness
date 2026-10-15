/**
 * Telegram message text: a strict HTML escaper and a small Markdown-to-HTML converter for what
 * models write (bold, italic, strike, inline code, fenced code, links, headings, bullets).
 * HTML parse mode only (never MarkdownV2: its escaping rules are fragile). Anything not
 * recognised is escaped text, so the output is always valid HTML for Telegram's subset, except
 * for crossing emphasis, which Telegram rejects (the adapter then resends the plain text).
 */
import { parseMentions } from '../channels/mentions.ts'
import { splitText } from '../channels/policy.ts'

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)[^\s<>"]+$/i

/** Placeholders for already converted pieces; control characters never appear in model text. */
const open = '\uE000'
const close = '\uE001'

const count = (text: string, ch: string): number => text.split(ch).length - 1

/** Telegram HTML for `text` (Markdown subset). Plain text without markup comes out escaped only. */
export function toTelegramHtml(text: string): string {
  const stash: string[] = []
  const keep = (html: string): string => {
    stash.push(html)
    return `${open}${stash.length - 1}${close}`
  }
  let s = text.replace(/[\uE000\uE001]/g, '')
  // a mention of the gateway (`channels/mentions.ts`): a link by user id, which pings the person
  // even without a username; ids that are not numbers are shown as plain names
  const mentions = parseMentions(s)
  for (let i = mentions.length - 1; i >= 0; i--) {
    const m = mentions[i] as (typeof mentions)[number]
    const html = /^\d{1,20}$/.test(m.id)
      ? keep(`<a href="tg://user?id=${m.id}">${escapeHtml(m.name)}</a>`)
      : keep(escapeHtml(m.name))
    s = `${s.slice(0, m.start)}${html}${s.slice(m.end)}`
  }
  // fenced code
  s = s.replace(
    /```([A-Za-z0-9+#_-]*)[^\S\n]*\n?([\s\S]*?)```/g,
    (_m, lang: string, body: string) =>
      keep(
        lang !== ''
          ? `<pre><code class="language-${lang}">${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`
          : `<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`,
      ),
  )
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => keep(`<code>${escapeHtml(body)}</code>`))
  // links: before escaping so the url survives; the label is escaped, the url is checked
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) =>
    SAFE_URL.test(url) ? keep(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`) : m,
  )
  // bare urls: an explicit link without the punctuation that follows it ("see https://a.b/c," is
  // not clickable for Telegram when the comma sticks), and no emphasis inside the url (`_`, `*`)
  s = s.replace(/https?:\/\/[^\s<>"\uE000\uE001]+/g, (m) => {
    let url = m
    let tail = ''
    for (;;) {
      const last = url.slice(-1)
      const unbalanced =
        (last === ')' && count(url, '(') < count(url, ')')) ||
        (last === ']' && count(url, '[') < count(url, ']')) ||
        (last === '}' && count(url, '{') < count(url, '}'))
      if (/[.,;:!?'"\u2019\u201d\u00bb\u2026>]/.test(last) || unbalanced) {
        tail = last + tail
        url = url.slice(0, -1)
        continue
      }
      break
    }
    if (!SAFE_URL.test(url) || url.length <= 'https://'.length) return m
    return `${keep(`<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`)}${tail}`
  })
  s = escapeHtml(s)
  // headings and bullets
  s = s.replace(/^#{1,6}[^\S\n]+(.+)$/gm, '<b>$1</b>')
  s = s.replace(/^([^\S\n]*)[-*][^\S\n]+/gm, '$1• ')
  // emphasis
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?![\w])/g, '$1<i>$2</i>')
  return s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => stash[Number(i)] ?? '')
}

/**
 * Split `text` so every part is at most `max` characters AFTER conversion to HTML (the escaped
 * form is longer than the raw text). Parts break at newlines like `splitText`.
 */
export function htmlChunks(text: string, max: number): string[] {
  const out: string[] = []
  let limit = max
  const walk = (parts: string[]): void => {
    for (const part of parts) {
      const html = toTelegramHtml(part)
      if (html.length <= max || part.length <= 1) {
        out.push(html.length <= max ? html : html.slice(0, max))
        continue
      }
      limit = Math.max(1, Math.floor(Math.min(limit, part.length) * 0.7))
      walk(splitText(part, limit))
    }
  }
  walk(splitText(text, max))
  return out
}
