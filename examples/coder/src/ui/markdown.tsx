/**
 * Lightweight Markdown for assistant text: headings, bold, italic, inline code, links, fenced code
 * blocks, bullet and numbered lists, quotes and rules. Pure parsing ({@link parseMarkdown},
 * {@link parseInline}) is separate from rendering so it can be unit-tested.
 */
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { color } from './theme.ts'

/** A styled run of inline text. */
export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** Link target; `text` is the link label. */
  url?: string
}

/** A block of a Markdown document. `gap` = a blank line preceded it. */
export type Block =
  | { kind: 'heading'; level: number; text: string; gap: boolean }
  | { kind: 'paragraph'; text: string; gap: boolean }
  | { kind: 'code'; lang: string; lines: string[]; gap: boolean }
  | { kind: 'item'; indent: number; marker: string; text: string; gap: boolean }
  | { kind: 'quote'; text: string; gap: boolean }
  | { kind: 'rule'; gap: boolean }

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*)|(\b_[^_\s][^_\n]*?_\b)|(\[[^\]\n]+\]\([^)\s]+\))/g

/** Inline spans of one line or paragraph. */
export function parseInline(text: string, base: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = []
  const push = (value: string, extra: Omit<Span, 'text'> = {}): void => {
    if (value !== '') spans.push({ text: value, ...base, ...extra })
  }
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    push(text.slice(last, at))
    const token = match[0]
    if (match[1]) push(token.slice(1, -1), { code: true })
    else if (match[2] || match[3])
      spans.push(...parseInline(token.slice(2, -2), { ...base, bold: true }))
    else if (match[4] || match[5])
      spans.push(...parseInline(token.slice(1, -1), { ...base, italic: true }))
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link) push(link[1] as string, { url: link[2] as string })
      else push(token)
    }
    last = at + token.length
  }
  push(text.slice(last))
  return spans
}

/** Parse a Markdown document into blocks (an unterminated fence runs to the end: streaming). */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let gap = false
  let i = 0
  const takeGap = (): boolean => {
    const value = gap && blocks.length > 0
    gap = false
    return value
  }
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = (fence[1] as string)[0] as string
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker.repeat(3))) {
        body.push(lines[i] as string)
        i++
      }
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', lines: body, gap: takeGap() })
      continue
    }
    if (line.trim() === '') {
      gap = true
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: heading[2] as string,
        gap: takeGap(),
      })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule', gap: takeGap() })
      i++
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const marker = item[2] as string
      blocks.push({
        kind: 'item',
        indent: Math.floor((item[1] as string).replace(/\t/g, '  ').length / 2),
        marker: /^\d/.test(marker) ? marker : '•',
        text: item[3] as string,
        gap: takeGap(),
      })
      i++
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (i < lines.length && (lines[i] as string).startsWith('>')) {
        quoted.push((lines[i] as string).replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', text: quoted.join(' '), gap: takeGap() })
      continue
    }
    const paragraph: string[] = [line]
    i++
    while (i < lines.length) {
      const next = lines[i] as string
      if (
        next.trim() === '' ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        ITEM.test(next) ||
        next.startsWith('>') ||
        RULE.test(next)
      )
        break
      paragraph.push(next)
      i++
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n'), gap: takeGap() })
  }
  return blocks
}

/** Inline-formatted text (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`). */
export function InlineMarkdown({
  text,
  bold,
  dim,
}: {
  text: string
  bold?: boolean
  dim?: boolean
}): ReactElement {
  const spans = parseInline(text)
  return (
    <Text bold={bold} dimColor={dim}>
      {spans.map((span, i) => {
        const key = `${i}`
        if (span.code) {
          return (
            <Text key={key} color={color.accent}>
              {span.text}
            </Text>
          )
        }
        if (span.url) {
          return (
            <Text key={key} bold={span.bold} italic={span.italic}>
              <Text color={color.link} underline>
                {span.text}
              </Text>
              <Text dimColor> ({span.url})</Text>
            </Text>
          )
        }
        return (
          <Text key={key} bold={span.bold} italic={span.italic}>
            {span.text}
          </Text>
        )
      })}
    </Text>
  )
}

function CodeBlock({ lang, lines }: { lang: string; lines: string[] }): ReactElement {
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="round"
      borderColor={color.dim}
      borderDimColor
      paddingX={1}
    >
      {lang ? <Text dimColor>{lang}</Text> : null}
      {lines.length === 0 ? <Text> </Text> : null}
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines of a static block
        <Text key={`${i}`}>{line === '' ? ' ' : line}</Text>
      ))}
    </Box>
  )
}

function BlockView({ block }: { block: Block }): ReactElement {
  const top = block.gap ? 1 : 0
  switch (block.kind) {
    case 'heading':
      return (
        <Box marginTop={top}>
          <InlineMarkdown text={block.text} bold />
        </Box>
      )
    case 'paragraph':
      return (
        <Box marginTop={top}>
          <InlineMarkdown text={block.text} />
        </Box>
      )
    case 'code':
      return (
        <Box marginTop={top} flexDirection="column">
          <CodeBlock lang={block.lang} lines={block.lines} />
        </Box>
      )
    case 'item':
      return (
        <Box marginTop={top} paddingLeft={block.indent * 2}>
          <Box flexShrink={0} marginRight={1}>
            <Text dimColor={block.marker === '•'}>{block.marker}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <InlineMarkdown text={block.text} />
          </Box>
        </Box>
      )
    case 'quote':
      return (
        <Box marginTop={top}>
          <Box flexShrink={0} marginRight={1}>
            <Text dimColor>▎</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor italic>
              {block.text}
            </Text>
          </Box>
        </Box>
      )
    case 'rule':
      return (
        <Box marginTop={top}>
          <Text dimColor>────────</Text>
        </Box>
      )
  }
}

/** Rendered Markdown; long lines wrap inside the available width (lists keep a hanging indent). */
export function Markdown({ text }: { text: string }): ReactElement {
  const blocks = parseMarkdown(text)
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are re-parsed from the text each render
        <BlockView key={`${i}`} block={block} />
      ))}
    </Box>
  )
}
