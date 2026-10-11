/**
 * Telegram message text: a strict HTML escaper and a small Markdown-to-HTML converter for what
 * models write (bold, italic, strike, inline code, fenced code, links, headings, bullets).
 * HTML parse mode only (never MarkdownV2: its escaping rules are fragile). Anything not
 * recognised is escaped text, so the output is always valid HTML for Telegram's subset, except
 * for crossing emphasis, which Telegram rejects (the adapter then resends the plain text).
 */
import { splitText } from '../channels/policy.ts'

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)[^\s<>"]+$/i

/** Placeholders for already converted pieces; control characters never appear in model text. */
const open = '\uE000'
const close = '\uE001'

/** Telegram HTML for `text` (Markdown subset). Plain text without markup comes out escaped only. */
export function toTelegramHtml(text: string): string {
  const stash: string[] = []
  const keep = (html: string): string => {
    stash.push(html)
    return `${open}${stash.length - 1}${close}`
  }
  let s = text.replace(/[\uE000\uE001]/g, '')
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
