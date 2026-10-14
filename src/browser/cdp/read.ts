/**
 * Reading a page as plain text (spec 35 §4.4): a fixed extractor run with `Runtime.evaluate` (no
 * page script is trusted; the extractor is a constant string), headings, list markers and
 * `[text](url)` links, capped with an offset.
 */
import { errorText, evaluate, pageInfo } from './page.ts'
import type { PageInfo, PageSession } from './types.ts'

/**
 * The extractor. It reads the DOM only (no page globals), skips hidden and non-content elements,
 * and returns text with `#` headings, `- ` list items and `[text](url)` links.
 */
export const READ_EXTRACTOR: string = `(() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'HEAD']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'FORM', 'FIELDSET', 'DETAILS', 'DL', 'DT', 'DD', 'BR', 'HR']);
  let out = '';
  const nl = (n) => { const m = out.match(/\\n*$/)[0].length; if (out.length > 0 && m < n) out += '\\n'.repeat(n - m); };
  const hidden = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\\s+/g, ' ');
      if (t.trim() === '' && (out === '' || out.endsWith('\\n') || out.endsWith(' '))) return;
      out += out.endsWith('\\n') || out === '' ? t.replace(/^ /, '') : t;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) return;
    if (/^H[1-6]$/.test(tag)) { nl(2); out += '#'.repeat(Number(tag[1])) + ' '; }
    else if (tag === 'LI') { nl(1); out += '- '; }
    else if (tag === 'TD' || tag === 'TH') { if (out && !out.endsWith('\\n')) out += ' | '; }
    else if (BLOCK.has(tag)) nl(tag === 'P' || tag === 'UL' || tag === 'OL' || tag === 'TABLE' ? 2 : 1);
    if (tag === 'A' && el.getAttribute('href')) {
      const label = (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      if (label) { out += '[' + label + '](' + el.href + ')'; return; }
    }
    if (tag === 'IMG') { const alt = el.getAttribute('alt'); if (alt) out += alt; return; }
    if (tag === 'INPUT' || tag === 'TEXTAREA') { if (el.type !== 'hidden' && el.value) out += '[' + el.value + ']'; return; }
    for (const c of el.childNodes) walk(c);
    if (/^H[1-6]$/.test(tag)) nl(2); else if (BLOCK.has(tag)) nl(1);
  };
  walk(document.body || document.documentElement);
  return out.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`

/**
 * Read the page text with a cap and an offset.
 *
 * @returns the text, the page and `nextOffset` when more remains, or an `ERROR:` string.
 */
export async function readPage(
  page: PageSession,
  input: { offset?: number; maxChars?: number },
  signal?: AbortSignal,
): Promise<{ text: string; page: PageInfo; nextOffset?: number } | string> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const cap = Math.max(100, Math.floor(input.maxChars ?? page.limits.readChars))
  try {
    const text = await evaluate<string>(page, READ_EXTRACTOR, signal)
    if (typeof text !== 'string')
      return 'ERROR: the page could not be read (it may still be loading).'
    const info = await pageInfo(page, signal)
    if (offset >= text.length && text.length > 0) {
      return {
        text: `(nothing at offset ${offset}: the page text has ${text.length} characters)`,
        page: info,
      }
    }
    const slice = text.slice(offset, offset + cap)
    const next = offset + cap
    return next < text.length
      ? { text: slice, page: info, nextOffset: next }
      : { text: slice, page: info }
  } catch (error) {
    return signal?.aborted ? 'ERROR: aborted.' : `ERROR: ${errorText(error)}`
  }
}
