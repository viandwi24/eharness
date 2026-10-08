import { Box, Text, useInput, usePaste } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import {
  type Buffer,
  backspace,
  bufferOf,
  emptyBuffer,
  end,
  home,
  insert,
  move,
  moveLine,
  renderLines,
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
}

function EditorLines({ buf, active }: { buf: Buffer; active: boolean }): ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
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
  const { disabled = false, running, history, listFiles, onSubmit, onBusy } = props
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
  const completionsRef = useRef<string[]>([])
  completionsRef.current = completions
  const pickRef = useRef(0)
  pickRef.current = Math.min(pick, Math.max(0, completions.length - 1))

  const edit = (next: Buffer): void => {
    setBuf(next)
    setHistIndex(null)
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
        if (bufRef.current.cursor > 0 && bufRef.current.text[bufRef.current.cursor - 1] === '\\') {
          const without = {
            text:
              bufRef.current.text.slice(0, bufRef.current.cursor - 1) +
              bufRef.current.text.slice(bufRef.current.cursor),
            cursor: bufRef.current.cursor - 1,
          }
          return edit(insert(without, '\n'))
        }
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
        const matches = matchSlash(bufRef.current.text)
        const first = matches[0]
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
      if ((key.upArrow || key.downArrow) && completionsRef.current.length > 0) {
        const count = completionsRef.current.length
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
      if (input) edit(insert(bufRef.current, input.replace(/\r\n?/g, '\n')))
    },
    { isActive: active },
  )

  usePaste(
    (text) => {
      edit(insert(bufRef.current, text.replace(/\r\n?/g, '\n')))
    },
    { isActive: active },
  )

  const suggestions = active && !running ? matchSlash(view.text) : []
  const shellMode = view.text.startsWith('!')
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={active ? color.accent : 'gray'} paddingX={1}>
        <Text color={shellMode ? color.running : active ? color.accent : 'gray'} bold>
          {shellMode ? '!' : sym.prompt}{' '}
        </Text>
        <EditorLines buf={view} active={active} />
      </Box>
      {shellMode ? <Text dimColor> shell mode: runs in the project root, no approval</Text> : null}
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
      {suggestions.slice(0, 8).map((command) => (
        <Text key={command.name} dimColor>
          {'  '}/{command.name}
          {command.usage ? ` ${command.usage}` : ''} · {command.description}
        </Text>
      ))}
    </Box>
  )
}
