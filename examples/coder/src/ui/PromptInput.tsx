import { Box, type Key, Text, useInput, usePaste } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { CustomCommand } from '../contracts.ts'
import {
  type Buffer,
  backslashNewline,
  backspace,
  bufferOf,
  emptyBuffer,
  end,
  home,
  insert,
  move,
  moveLine,
  renderLines,
  splitEnter,
} from './editor.ts'
import { HistorySearch, searchMatches } from './history-search.tsx'
import { completeMention, matchPaths, mentionAt } from './mentions.ts'
import { matchSlash } from './slash.ts'
import { color, sym } from './theme.ts'

/** Props of {@link PromptInput}. */
export interface PromptInputProps {
  /** Disabled while a permission prompt is open. */
  disabled?: boolean
  /** A turn is running: Enter still submits (the App queues the message). */
  running?: boolean
  /** Previous prompts, oldest first. */
  history: string[]
  /** Custom commands and skills offered next to the built-ins in `/` completion. */
  commands?: CustomCommand[]
  /** Messages queued behind the running turn: Up on an empty prompt takes them back. */
  queuedCount?: number
  /** Take the queued entries back out of the queue; returns them one per line. */
  onRecallQueue?(): string | null
  /** Prompts for Ctrl+R (all projects); `history` is used until it resolves or when absent. */
  loadSearchPool?(): Promise<string[]>
  /** Ctrl+R search opened or closed (Esc must not interrupt the turn while it is open). */
  onSearchChange?(open: boolean): void
  /** Workspace file paths for `@` completion (cached by the caller). */
  listFiles?(): Promise<string[]>
  onSubmit(text: string): void
  /** `?` typed on an empty prompt: called instead of inserting it (the App opens the shortcuts panel). */
  onShortcuts?(): void
  /** Called with the new text after every edit (the App can close the shortcuts panel). */
  onTextChange?(text: string): void
  /** Override of the placeholder shown when the prompt is empty. */
  placeholder?: string
}

/** Placeholder of an empty prompt. */
export const PLACEHOLDER = 'Try "explain this codebase"'

function EditorLines({
  buf,
  active,
  placeholder,
}: {
  buf: Buffer
  active: boolean
  placeholder: string
}): ReactElement {
  if (buf.text === '') {
    return (
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor>
          {active ? <Text inverse>{placeholder.slice(0, 1)}</Text> : placeholder.slice(0, 1)}
          {placeholder.slice(1)}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {renderLines(buf).map((line, i) => {
        const key = `${i}:${line.text}`
        if (line.cursorAt === undefined || !active) return <Text key={key}>{line.text || ' '}</Text>
        return (
          <Text key={key}>
            {line.text.slice(0, line.cursorAt)}
            <Text inverse>{line.text[line.cursorAt] ?? ' '}</Text>
            {line.text.slice(line.cursorAt + 1)}
          </Text>
        )
      })}
    </Box>
  )
}

/** Multiline prompt editor: Enter submits, Shift+Enter or `\` + Enter inserts a newline. */
export function PromptInput(props: PromptInputProps): ReactElement {
  const {
    disabled = false,
    history,
    commands,
    queuedCount = 0,
    onRecallQueue,
    loadSearchPool,
    onSearchChange,
    listFiles,
    onSubmit,
    onShortcuts,
    onTextChange,
    placeholder = PLACEHOLDER,
  } = props
  const [view, setView] = useState<Buffer>(emptyBuffer)
  const bufRef = useRef<Buffer>(emptyBuffer)
  const setBuf = (next: Buffer): void => {
    bufRef.current = next
    setView(next)
  }
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const draft = useRef('')
  const active = !disabled
  const [files, setFiles] = useState<string[]>([])
  const [pick, setPick] = useState(0)
  const mention = mentionAt(view.text, view.cursor)
  const mentionActive = mention !== undefined
  useEffect(() => {
    if (!mentionActive || !listFiles) return
    let cancelled = false
    listFiles()
      .then((paths) => {
        if (!cancelled) setFiles(paths)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mentionActive, listFiles])
  const completions = active && mention ? matchPaths(files, mention.query) : []
  const suggestions = active && !mention ? matchSlash(view.text, commands).slice(0, 8) : []
  const completionsRef = useRef<string[]>([])
  completionsRef.current = completions
  const suggestionsRef = useRef<ReturnType<typeof matchSlash>>([])
  suggestionsRef.current = suggestions
  const pickRef = useRef(0)
  pickRef.current = Math.min(
    pick,
    Math.max(0, Math.max(completions.length, suggestions.length) - 1),
  )

  const [search, setSearchState] = useState<{ query: string; index: number } | null>(null)
  const searchRef = useRef(search)
  const [pool, setPool] = useState<string[] | null>(null)
  const poolRef = useRef<string[]>(history)
  poolRef.current = pool ?? history
  const setSearch = (next: { query: string; index: number } | null): void => {
    const was = searchRef.current !== null
    searchRef.current = next
    setSearchState(next)
    if (was === (next !== null)) return
    // closing is reported a tick later: the App's Esc handler runs after this one for the same key
    if (next) onSearchChange?.(true)
    else setTimeout(() => onSearchChange?.(false), 0)
  }
  const openSearch = (): void => {
    setSearch({ query: '', index: 0 })
    if (!loadSearchPool) return
    loadSearchPool()
      .then((all) => setPool(all))
      .catch(() => {})
  }
  const searchHits = search ? searchMatches(pool ?? history, search.query) : []
  const searchHit = search ? searchHits[Math.min(search.index, searchHits.length - 1)] : undefined

  const edit = (next: Buffer): void => {
    setBuf(next)
    setHistIndex(null)
    setPick(0)
    onTextChange?.(next.text)
  }

  const browseHistory = (dir: -1 | 1): void => {
    if (history.length === 0) return
    if (histIndex === null) {
      if (dir === 1) return
      draft.current = bufRef.current.text
      const index = history.length - 1
      setHistIndex(index)
      setBuf(bufferOf(history[index] ?? ''))
      return
    }
    const next = histIndex + dir
    if (next >= history.length) {
      setHistIndex(null)
      setBuf(bufferOf(draft.current))
    } else if (next >= 0) {
      setHistIndex(next)
      setBuf(bufferOf(history[next] ?? ''))
    }
  }

  const submit = (): void => {
    const text = bufRef.current.text.trim()
    if (text === '') return
    setBuf(emptyBuffer)
    setHistIndex(null)
    onSubmit(text)
  }

  const searchKey = (input: string, key: Key): void => {
    const current = searchRef.current
    if (!current) return
    const hits = searchMatches(poolRef.current, current.query)
    const older = (): void =>
      setSearch({ ...current, index: Math.min(current.index + 1, Math.max(0, hits.length - 1)) })
    if (key.escape || (key.ctrl && input === 'g')) {
      setSearch(null)
      return
    }
    if (key.return) {
      const hit = hits[Math.min(current.index, hits.length - 1)]
      setSearch(null)
      if (hit !== undefined) edit(bufferOf(hit))
      return
    }
    if ((key.ctrl && input === 'r') || key.upArrow) {
      older()
      return
    }
    if (key.downArrow) {
      setSearch({ ...current, index: Math.max(0, current.index - 1) })
      return
    }
    if (key.backspace || key.delete) {
      setSearch({ query: current.query.slice(0, -1), index: 0 })
      return
    }
    if (key.ctrl || key.meta || key.tab || !input) return
    setSearch({ query: current.query + input.replace(/[\r\n]+/g, ' '), index: 0 })
  }

  useInput(
    (input, key) => {
      if (searchRef.current) return searchKey(input, key)
      if (key.return) {
        if (key.shift || key.meta) return edit(insert(bufRef.current, '\n'))
        const continued = backslashNewline(bufRef.current)
        if (continued) return edit(continued)
        return submit()
      }
      if (key.tab) {
        if (key.shift) return
        const chosen = completionsRef.current[pickRef.current]
        const at = mentionAt(bufRef.current.text, bufRef.current.cursor)
        if (chosen && at) {
          setPick(0)
          return edit(completeMention(bufRef.current.text, at.start, bufRef.current.cursor, chosen))
        }
        const first = suggestionsRef.current[pickRef.current]
        if (first) edit(bufferOf(`/${first.name} `))
        return
      }
      if (key.escape || key.pageUp || key.pageDown) return
      if (key.ctrl) {
        if (input === 'j') return edit(insert(bufRef.current, '\n'))
        if (input === 'a') return edit(home(bufRef.current))
        if (input === 'e') return edit(end(bufRef.current))
        if (input === 'u') return edit(emptyBuffer)
        if (input === 'r') return openSearch()
        return
      }
      if (key.meta) return
      if (key.leftArrow) return setBuf(move(bufRef.current, -1))
      if (key.rightArrow) return setBuf(move(bufRef.current, 1))
      if (key.home) return setBuf(home(bufRef.current))
      if (key.end) return setBuf(end(bufRef.current))
      const count = Math.max(completionsRef.current.length, suggestionsRef.current.length)
      if ((key.upArrow || key.downArrow) && count > 0) {
        return setPick((pickRef.current + (key.upArrow ? count - 1 : 1)) % count)
      }
      if (key.upArrow && queuedCount > 0 && bufRef.current.text === '') {
        const recalled = onRecallQueue?.()
        if (recalled) return edit(bufferOf(recalled))
      }
      if (key.upArrow) {
        return bufRef.current.text.includes('\n')
          ? setBuf(moveLine(bufRef.current, -1))
          : browseHistory(-1)
      }
      if (key.downArrow) {
        return bufRef.current.text.includes('\n')
          ? setBuf(moveLine(bufRef.current, 1))
          : browseHistory(1)
      }
      // Terminals send DEL for the backspace key; Ink may report it as either flag.
      if (key.backspace || key.delete) return edit(backspace(bufRef.current))
      if (input === '?' && bufRef.current.text === '' && onShortcuts) return onShortcuts()
      if (!input) return
      // A chunk like `hi\r` (tmux, ssh, scripted input) carries its own Enter. Text before it is
      // inserted, the Enter submits, and text after it becomes the next draft.
      const chunk = splitEnter(input)
      if (!chunk.enter) return edit(insert(bufRef.current, input))
      if (chunk.before) edit(insert(bufRef.current, chunk.before))
      const continued = backslashNewline(bufRef.current)
      if (continued) return edit(insert(continued, chunk.rest))
      submit()
      if (chunk.rest) edit(insert(bufRef.current, chunk.rest))
    },
    { isActive: active },
  )

  usePaste(
    (text) => {
      edit(insert(bufRef.current, text.replace(/\r\n?/g, '\n')))
    },
    { isActive: active },
  )

  const shellMode = view.text.startsWith('!')
  const borderColor = !active ? color.border : shellMode ? color.shell : color.accent
  const nameWidth = Math.max(
    0,
    ...suggestions.map((c) => c.name.length + (c.usage ? c.usage.length + 1 : 0)),
  )
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} borderDimColor={!active} paddingX={1}>
        <Box flexShrink={0} width={2}>
          <Text
            color={shellMode ? color.shell : undefined}
            dimColor={!active || !shellMode}
            bold={shellMode}
          >
            {shellMode ? '!' : sym.prompt}
          </Text>
        </Box>
        <EditorLines buf={view} active={active} placeholder={placeholder} />
      </Box>
      {shellMode ? (
        <Text color={color.shell} dimColor>
          {'  '}shell mode: runs in the project root, no approval
        </Text>
      ) : null}
      {search ? <HistorySearch query={search.query} match={searchHit} /> : null}
      {completions.map((path, i) => (
        <Text
          key={path}
          dimColor={i !== pickRef.current}
          color={i === pickRef.current ? color.accent : undefined}
        >
          {'  '}
          {i === pickRef.current ? sym.pointer : ' '} @{path}
        </Text>
      ))}
      {suggestions.map((command, i) => {
        const label = `/${command.name}${command.usage ? ` ${command.usage}` : ''}`
        const selected = i === pickRef.current
        return (
          <Text key={command.name} wrap="truncate-end">
            <Text color={selected ? color.accent : undefined} bold={selected} dimColor={!selected}>
              {'  '}
              {label.padEnd(nameWidth + 1)}
            </Text>
            <Text color={selected ? color.accent : undefined} dimColor={!selected}>
              {'  '}
              {command.description}
            </Text>
            {command.source ? <Text dimColor> ({command.source})</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}
