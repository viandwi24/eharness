import { Box, Text, useInput, usePaste } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
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
import { completeMention, matchPaths, mentionAt } from './mentions.ts'
import { matchSlash } from './slash.ts'
import { color, sym } from './theme.ts'

/** Props of {@link PromptInput}. */
export interface PromptInputProps {
  /** Disabled while a permission prompt is open. */
  disabled?: boolean
  /** A turn is running: Enter is ignored and `onBusy` is called instead. */
  running: boolean
  /** Previous prompts, oldest first. */
  history: string[]
  /** Workspace file paths for `@` completion (cached by the caller). */
  listFiles?(): Promise<string[]>
  onSubmit(text: string): void
  /** Enter pressed while a turn runs. */
  onBusy(): void
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
    running,
    history,
    listFiles,
    onSubmit,
    onBusy,
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
  const completions = active && !running && mention ? matchPaths(files, mention.query) : []
  const suggestions = active && !running && !mention ? matchSlash(view.text).slice(0, 8) : []
  const completionsRef = useRef<string[]>([])
  completionsRef.current = completions
  const suggestionsRef = useRef<ReturnType<typeof matchSlash>>([])
  suggestionsRef.current = suggestions
  const pickRef = useRef(0)
  pickRef.current = Math.min(
    pick,
    Math.max(0, Math.max(completions.length, suggestions.length) - 1),
  )

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
    if (running) {
      onBusy()
      return
    }
    setBuf(emptyBuffer)
    setHistIndex(null)
    onSubmit(text)
  }

  useInput(
    (input, key) => {
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
      // inserted, the Enter submits, and text after it becomes the next draft (dropped when busy).
      const chunk = splitEnter(input)
      if (!chunk.enter) return edit(insert(bufRef.current, input))
      if (chunk.before) edit(insert(bufRef.current, chunk.before))
      const continued = backslashNewline(bufRef.current)
      if (continued) return edit(insert(continued, chunk.rest))
      const wasRunning = running
      submit()
      if (!wasRunning && chunk.rest) edit(insert(bufRef.current, chunk.rest))
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
          </Text>
        )
      })}
    </Box>
  )
}
