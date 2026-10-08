/**
 * Page chrome: title bar, a vertically scrollable body and a key-hint footer, sized to the
 * terminal (`useWindowSize`). The body is a fixed-height `overflow="hidden"` viewport whose
 * content box is shifted with `contentOffsetY`. Mounted by the page host (see `host.ts`) on the
 * alternate screen.
 */
import { Box, type DOMElement, measureElement, Text, useInput, useWindowSize } from 'ink'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { color } from '../theme.ts'

/** Props of {@link Page}. */
export interface PageProps {
  title: string
  subtitle?: string
  /** Footer hints; the default lists close, scroll and next section. */
  hints?: string
  /** Close the page (Esc / q). */
  onClose(): void
  /** Set to false when the page uses the arrow keys itself (scrolling stays on PgUp/PgDn, g/G). */
  arrows?: boolean
  /** Open scrolled to the end (the transcript viewer). */
  startAtEnd?: boolean
  /** A child is capturing text input: the page ignores every key (Esc and `q` included). */
  editing?: boolean
  /** Override the terminal size (tests). */
  size?: { rows: number; columns: number }
  children: ReactNode
}

interface SectionRegistry {
  register(ref: RefObject<DOMElement | null>): () => void
}
const SectionContext = createContext<SectionRegistry | null>(null)

/** A block of a page: `Tab` jumps from section to section. Must be a direct child of the page body. */
export function Section({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}): ReactElement {
  const ref = useRef<DOMElement>(null)
  const registry = useContext(SectionContext)
  useEffect(() => registry?.register(ref), [registry])
  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      {title ? (
        <Text bold color={color.accent}>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  )
}

const TITLE_ROWS = 2
const FOOTER_ROWS = 1
/** The page is one row shorter than the terminal: a full-height frame would make Ink clear it all. */
const SPARE_ROWS = 1

/** Rows of the page body for a terminal of `rows`. */
export function bodyRows(rows: number): number {
  return Math.max(3, rows - SPARE_ROWS - TITLE_ROWS - FOOTER_ROWS)
}

/** Fullscreen page chrome with a scrollable body. */
export function Page({
  title,
  subtitle,
  hints = 'esc/q close · ↑↓ scroll · tab next section',
  onClose,
  arrows = true,
  startAtEnd = false,
  editing = false,
  size,
  children,
}: PageProps): ReactElement {
  const win = useWindowSize()
  const rows = size?.rows ?? win.rows
  const columns = size?.columns ?? win.columns
  const viewport = bodyRows(rows)
  const viewRef = useRef<DOMElement>(null)
  const contentRef = useRef<DOMElement>(null)
  const [contentHeight, setContentHeight] = useState(0)
  // measured after every render: the content grows when data arrives or the terminal resizes
  useEffect(() => {
    const h = contentRef.current ? measureElement(contentRef.current).height : 0
    if (h !== contentHeight) setContentHeight(h)
  })
  const [requested, setRequested] = useState(startAtEnd ? Number.MAX_SAFE_INTEGER : 0)
  const sections = useRef<Array<RefObject<DOMElement | null>>>([])
  const [registry] = useState<SectionRegistry>(() => ({
    register(ref) {
      sections.current.push(ref)
      return () => {
        sections.current = sections.current.filter((r) => r !== ref)
      }
    },
  }))

  const max = Math.max(0, contentHeight - viewport)
  const top = Math.min(requested, max)

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose()
      const fresh = contentRef.current ? measureElement(contentRef.current).height : contentHeight
      const limit = Math.max(0, fresh - viewport)
      const set = (n: number): void => setRequested(Math.max(0, Math.min(limit, n)))
      if (arrows && key.upArrow) return set(top - 1)
      if (arrows && key.downArrow) return set(top + 1)
      if (key.pageUp) return set(top - (viewport - 1))
      if (key.pageDown) return set(top + (viewport - 1))
      if (input === 'g' || key.home) return set(0)
      if (input === 'G' || key.end) return set(limit)
      if (key.tab && !key.shift) {
        const base = contentRef.current ? measureElement(contentRef.current).y : 0
        const ys = sections.current
          .map((ref) => (ref.current ? measureElement(ref.current).y - base : -1))
          .filter((y) => y >= 0)
          .sort((a, b) => a - b)
        const next = ys.find((y) => y > top)
        set(next ?? 0)
      }
    },
    { isActive: !editing },
  )

  const position =
    max > 0 ? `${top + 1}-${Math.min(top + viewport, contentHeight)}/${contentHeight}` : ''
  return (
    <Box flexDirection="column" height={rows - SPARE_ROWS} width={columns}>
      <Box
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={color.border}
        paddingX={1}
      >
        <Text wrap="truncate-end">
          <Text bold color={color.accent}>
            {title}
          </Text>
          {subtitle ? <Text dimColor> {subtitle}</Text> : null}
        </Text>
      </Box>
      <Box
        ref={viewRef}
        flexDirection="column"
        height={viewport}
        overflow="hidden"
        contentOffsetY={top}
      >
        <SectionContext value={registry}>
          <Box ref={contentRef} flexDirection="column" flexShrink={0} paddingX={1} width={columns}>
            {children}
          </Box>
        </SectionContext>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {hints}
        </Text>
        {position ? <Text dimColor>{position}</Text> : null}
      </Box>
    </Box>
  )
}

/** A dim `label  value` row with the label padded to `width`. */
export function Field({
  label,
  width = 18,
  children,
}: {
  label: string
  width?: number
  children: ReactNode
}): ReactElement {
  return (
    <Box>
      <Box width={width} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{children}</Text>
      </Box>
    </Box>
  )
}

/** Shown while a page loads its data. */
export function Loading(): ReactElement {
  return <Text dimColor>Loading…</Text>
}
