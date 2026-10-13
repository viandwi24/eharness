/** A small, safe Markdown to HTML converter for the document export (no raw HTML passes through). */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const safeUrl = (u: string): string =>
  /^(https?:|mailto:|#|\/|\.)/i.test(u.trim()) ? esc(u.trim()) : '#'

function inline(text: string): string {
  let out = esc(text)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, url: string) => `<img alt="${alt}" src="${safeUrl(url)}">`,
  )
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${safeUrl(url)}">${label}</a>`,
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return out
}

export function markdownToHtml(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const body: string[] = []
  let i = 0
  const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = /^```(\w*)/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i] as string).startsWith('```'))
        code.push(lines[i++] as string)
      i++
      body.push(
        `<pre><code class="language-${esc(fence[1] ?? '')}">${esc(code.join('\n'))}</code></pre>`,
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] as string).length
      body.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`)
      i++
      continue
    }
    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (
        i < lines.length &&
        (/^\s*([-*])\s+/.test(lines[i] as string) || /^\s*\d+\.\s+/.test(lines[i] as string))
      ) {
        items.push(`<li>${inline((lines[i] as string).replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`)
        i++
      }
      body.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] as string)
    ) {
      const cells = (l: string): string[] =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i] as string))
        rows.push(cells(lines[i++] as string))
      body.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      )
      continue
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] as string))
        quote.push((lines[i++] as string).replace(/^>\s?/, ''))
      body.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`)
      continue
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      body.push('<hr>')
      i++
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== '' &&
      !/^(#{1,6}\s|```|>\s?|\s*([-*]|\d+\.)\s+)/.test(lines[i] as string)
    ) {
      para.push(lines[i++] as string)
    }
    body.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}pre{background:#f4f4f4;padding:.8rem;overflow:auto}code{background:#f4f4f4;padding:0 .25em}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem;color:#555}img{max-width:100%}</style>
</head><body>
${body.join('\n')}
</body></html>
`
}
