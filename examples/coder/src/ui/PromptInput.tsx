import type { FileUIPart } from 'ai'
import { Box, type Key, Text, useApp, useInput, usePaste } from 'ink'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import type { CustomCommand } from '../contracts.ts'
import { type ClipboardImage, readClipboardImage } from './clipboard.ts'
import {
  type Buffer,
  backslashNewline,
  backspace,
  bufferOf,
  deleteForward,
  emptyBuffer,
  emptyUndo,
  end,
  home,
  insert,
  type Kill,
  killToEnd,
  killToLineStart,
  killWordBack,
  killWordBackSpace,
  killWordForward,
  move,
  moveLine,
  popUndo,
  pushKill,
  pushUndo,
  renderLines,
  splitEnter,
  type UndoKind,
  undoBreak,
  undoJoinInsert,
  wordBack,
  wordForward,
  type YankSpan,
  yank,
  yankPop,
} from './editor.ts'
import { type ExternalEditResult, editInExternalEditor } from './external-editor.ts'
import { HistorySearch, searchMatches } from './history-search.tsx'
import {
  completeItem,
  folderPaths,
  type MentionItem,
  matchMentions,
  mentionAt,
} from './mentions.ts'
import {
  backspaceChip,
  deleteChip,
  expandPastes,
  imagesInOrder,
  insertPaste,
  moveChip,
  PasteStore,
} from './paste.ts'
import { matchSlash } from './slash.ts'
import { color, sym } from './theme.ts'
import {
  initialVimState,
  type VimKey,
  type VimMode,
  type VimState,
  vimKey,
  visualRange,
} from './vim.ts'

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
  /** Agent names offered as `@agent-<name>` in `@` completion. */
  agents?: string[]
  /** Submitted text with large-paste chips expanded to their full content. Not called when `onSubmitDetailed` is set. */
  onSubmit(text: string): void
  /** Like `onSubmit` plus the clipboard images (`FileUIPart`s, in chip order). When set it replaces `onSubmit`. */
  onSubmitDetailed?(submitted: { text: string; files: FileUIPart[] }): void
  /** `vim` enables NORMAL / INSERT / VISUAL editing (default `normal`). Esc then never double-Esc clears. */
  editorMode?: 'normal' | 'vim'
  /** Vim mode changed (also once on mount in vim mode); the footer shows `-- INSERT --` etc. */
  onVimMode?(mode: VimMode): void
  /** Short status text (`stashed`, `No image in the clipboard`, ...) for the integrator to show dimly. */
  onHint?(text: string): void
  /** Ctrl+D on an empty prompt (exit handling). With text Ctrl+D deletes the char after the cursor. */
  onCtrlDEmpty?(): void
  /** The external editor (Ctrl+G) started (`true`) or finished (`false`): pause other key handling meanwhile. */
  onExternalEditor?(running: boolean): void
  /** Double Esc cleared a non-empty draft: save it to history. */
  onSaveDraft?(text: string): void
  /** Double Esc on an empty prompt (not in vim mode): open the rewind menu. */
  onRewindMenu?(): void
  /** Test seam: replaces the `$VISUAL`/`$EDITOR` round trip of Ctrl+G. */
  externalEditor?(text: string): Promise<ExternalEditResult>
  /** Test seam: replaces the clipboard image read of Ctrl+V / Alt+V. */
  readImage?(): Promise<ClipboardImage>
  /** `?` typed on an empty prompt: called instead of inserting it (the App opens the shortcuts panel). */
  onShortcuts?(): void
  /** Called with the new text after every edit (the App can close the shortcuts panel). */
  onTextChange?(text: string): void
  /** Override of the placeholder shown when the prompt is empty. */
  placeholder?: string
  /** Replace the buffer with `text` whenever `id` changes (rewind puts the prompt back, a suggestion is accepted). */
  prefill?: { id: number; text: string }
}

/** Placeholder of an empty prompt. */
export const PLACEHOLDER = 'Try "explain this codebase"'

/** Highlight of a VISUAL selection (end exclusive). */
type Selection = { start: number; end: number }

function EditorLines({
  buf,
  active,
  placeholder,
  selection,
}: {
  buf: Buffer
  active: boolean
  placeholder: string
  selection?: Selection
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
  let offset = 0
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {renderLines(buf).map((line, i) => {
        const key = `${i}:${line.text}`
        const base = offset
        offset += line.text.length + 1
        if (selection && active) {
          const selected = (at: number): boolean =>
            base + at >= selection.start && base + at < selection.end
          const cells = [...line.text, ' '].map((ch, at) => ({
            ch,
            on: at === line.cursorAt || (at < line.text.length && selected(at)),
          }))
          const runs: Array<{ text: string; on: boolean }> = []
          for (const cell of cells) {
            const last = runs[runs.length - 1]
            if (last && last.on === cell.on) last.text += cell.ch
            else runs.push({ text: cell.ch, on: cell.on })
          }
          return (
            <Text key={key}>
              {runs.map((run, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
                <Text key={r} inverse={run.on}>
                  {run.text}
                </Text>
              ))}
            </Text>
          )
        }
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

/** macOS sends these characters for Option+letter when Option is not configured as Meta. */
const MAC_OPTION: Record<string, string> = { '∫': 'b', ƒ: 'f', '∂': 'd', '¥': 'y', '√': 'v' }

/** Two Esc presses within this window count as a double Esc. */
const DOUBLE_ESC_MS = 500

const MENTION_LABEL: Record<MentionItem['kind'], string> = {
  file: 'file',
  folder: 'folder',
  agent: 'agent',
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
    agents,
    onSubmit,
    onSubmitDetailed,
    onShortcuts,
    onTextChange,
    placeholder = PLACEHOLDER,
    editorMode = 'normal',
    onVimMode,
    onHint,
    onCtrlDEmpty,
    onExternalEditor,
    onSaveDraft,
    onRewindMenu,
    prefill,
    externalEditor,
    readImage,
  } = props
  const vim = editorMode === 'vim'
  const app = useApp()
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
  const folders = useMemo(() => folderPaths(files), [files])
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
  const completions: MentionItem[] =
    active && mention ? matchMentions(files, mention.query, agents, folders) : []
  const suggestions = active && !mention ? matchSlash(view.text, commands).slice(0, 8) : []
  const completionsRef = useRef<MentionItem[]>([])
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

  // --- editing state that does not render: undo stack, kill ring, stash, pastes, vim ------------
  const undoRef = useRef(emptyUndo)
  const ringRef = useRef<string[]>([])
  const lastAction = useRef<'kill' | 'yank' | 'other'>('other')
  const yankSpan = useRef<YankSpan | undefined>(undefined)
  const stashRef = useRef<{ buf: Buffer; mode: VimMode } | null>(null)
  const store = useRef(new PasteStore()).current
  const lastEsc = useRef(0)
  const editorBusy = useRef(false)
  const clipBusy = useRef(false)
  const vimRef = useRef<VimState>(initialVimState('insert'))
  const [vimMode, setVimMode] = useState<VimMode>('insert')
  const onVimModeRef = useRef(onVimMode)
  onVimModeRef.current = onVimMode
  useEffect(() => {
    if (vim) onVimModeRef.current?.(vimMode)
  }, [vim, vimMode])

  const prefillId = useRef(prefill?.id ?? 0)
  useEffect(() => {
    if (!prefill || prefill.id === prefillId.current) return
    prefillId.current = prefill.id
    const next = bufferOf(prefill.text)
    bufRef.current = next
    setView(next)
    setHistIndex(null)
    onTextChange?.(next.text)
  })

  const edit = (next: Buffer, kind: UndoKind = 'edit'): void => {
    const current = bufRef.current
    if (next.text !== current.text) {
      undoRef.current = pushUndo(undoRef.current, current, kind, Date.now())
    }
    lastAction.current = 'other'
    setBuf(next)
    setHistIndex(null)
    setPick(0)
    onTextChange?.(next.text)
  }
  const cursorTo = (next: Buffer): void => {
    lastAction.current = 'other'
    setBuf(next)
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
    const expanded = expandPastes(text, store)
    const images = imagesInOrder(text, store)
    setBuf(emptyBuffer)
    setHistIndex(null)
    undoRef.current = emptyUndo
    if (!stashRef.current) store.clear()
    if (onSubmitDetailed) onSubmitDetailed({ text: expanded, files: images })
    else onSubmit(expanded)
  }

  const undo = (): void => {
    const popped = popUndo(undoRef.current)
    if (!popped) return
    undoRef.current = popped.stack
    lastAction.current = 'other'
    setBuf(popped.buf)
    onTextChange?.(popped.buf.text)
  }

  const kill = (k: Kill | undefined): void => {
    if (!k) return
    ringRef.current = pushKill(ringRef.current, k.killed, k.dir, lastAction.current === 'kill')
    edit(k.buf)
    lastAction.current = 'kill'
  }

  const runVim = (key: VimKey): void => {
    const before = bufRef.current
    const wasInsert = vimRef.current.mode === 'insert'
    const res = vimKey(before, vimRef.current, key)
    vimRef.current = res.state
    setVimMode(res.state.mode)
    if (res.undo) {
      undo()
      return
    }
    const changed = res.buf.text !== before.text
    if (changed) {
      undoRef.current = pushUndo(undoRef.current, before, wasInsert ? 'insert' : 'edit', Date.now())
    }
    if (!wasInsert && res.state.mode === 'insert') {
      undoRef.current = changed ? undoJoinInsert(undoRef.current) : undoBreak(undoRef.current)
    }
    lastAction.current = 'other'
    setBuf(res.buf)
    if (changed) {
      setHistIndex(null)
      onTextChange?.(res.buf.text)
    }
    if (res.submit) submit()
  }

  const openExternalEditor = (): void => {
    if (editorBusy.current) return
    editorBusy.current = true
    onExternalEditor?.(true)
    const text = expandPastes(bufRef.current.text, store)
    const run =
      externalEditor ??
      ((t: string) =>
        editInExternalEditor(t, {
          suspend: (fn) =>
            typeof app.suspendTerminal === 'function' ? app.suspendTerminal(fn) : fn(),
        }))
    run(text)
      .then((res) => {
        if (res.ok) edit(bufferOf(res.text))
        else onHint?.(res.error)
      })
      .catch((error: unknown) => onHint?.(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        editorBusy.current = false
        onExternalEditor?.(false)
      })
  }

  const pasteImage = (): void => {
    if (clipBusy.current) return
    clipBusy.current = true
    ;(readImage ?? readClipboardImage)()
      .catch((): ClipboardImage => ({ ok: false, reason: 'error' }))
      .then((res) => {
        if (!res.ok) {
          onHint?.(
            res.reason === 'too-large'
              ? 'Image is larger than 5 MB'
              : res.reason === 'unsupported'
                ? 'Image paste is not supported on this platform'
                : res.reason === 'error'
                  ? 'Could not read the clipboard'
                  : 'No image in the clipboard',
          )
          return
        }
        edit(insert(bufRef.current, `${store.addImage(res.file)} `))
      })
      .finally(() => {
        clipBusy.current = false
      })
  }

  const stash = (): void => {
    const buf = bufRef.current
    if (buf.text !== '') {
      stashRef.current = { buf, mode: vimRef.current.mode }
      edit(emptyBuffer)
      onHint?.('stashed')
      return
    }
    const saved = stashRef.current
    if (!saved) return
    stashRef.current = null
    edit(saved.buf)
    onHint?.('stash restored')
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

  /** Typed text: through the vim engine while inserting in vim mode (so `.` can replay it). */
  const typed = (text: string): void => {
    if (vim && vimRef.current.mode === 'insert') runVim({ input: text })
    else edit(insert(bufRef.current, text), 'type')
  }

  const deleteBack = (): void => {
    const chip = backspaceChip(bufRef.current, store)
    if (chip) edit(chip)
    else if (vim && vimRef.current.mode === 'insert') runVim({ backspace: true })
    else edit(backspace(bufRef.current))
  }

  useInput(
    (input, key) => {
      if (editorBusy.current) return
      if (searchRef.current) return searchKey(input, key)

      // --- vim ---------------------------------------------------------------------------
      if (vim) {
        const mode = vimRef.current.mode
        if (key.escape) return runVim({ escape: true })
        if (mode !== 'insert') {
          const plain = !key.ctrl && !key.meta && !key.tab
          if (key.return && !key.shift && !key.meta) return runVim({ enter: true })
          if (key.backspace || key.delete) return runVim({ backspace: true })
          if (
            plain &&
            input &&
            !key.upArrow &&
            !key.downArrow &&
            !key.leftArrow &&
            !key.rightArrow
          ) {
            return runVim({ input })
          }
        }
      } else if (key.escape) {
        // A single Esc keeps its meaning elsewhere (the App interrupts); this only adds the double press.
        if (key.meta) return doubleEsc()
        const now = Date.now()
        const previous = lastEsc.current
        lastEsc.current = now
        if (previous !== 0 && now - previous < DOUBLE_ESC_MS) doubleEsc()
        return
      }

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
          return edit(completeItem(bufRef.current.text, at.start, bufRef.current.cursor, chosen))
        }
        const first = suggestionsRef.current[pickRef.current]
        if (first) edit(bufferOf(`/${first.name} `))
        return
      }
      if (key.escape || key.pageUp || key.pageDown) return
      if (key.ctrl) {
        const buf = bufRef.current
        switch (input) {
          case 'j':
            return edit(insert(buf, '\n'))
          case 'a':
            return cursorTo(home(buf))
          case 'e':
            return cursorTo(end(buf))
          case 'b':
            return cursorTo(move(buf, -1))
          case 'f':
            return cursorTo(move(buf, 1))
          case 'u':
            return kill(killToLineStart(buf))
          case 'k':
            return kill(killToEnd(buf))
          case 'w': {
            const chip = backspaceChip(buf, store)
            return chip ? edit(chip) : kill(killWordBackSpace(buf))
          }
          case 'y': {
            const res = yank(buf, ringRef.current)
            if (!res) return
            edit(res.buf)
            yankSpan.current = res.span
            lastAction.current = 'yank'
            return
          }
          case 'd': {
            if (buf.text === '') return onCtrlDEmpty?.()
            return edit(deleteChip(buf, store) ?? deleteForward(buf))
          }
          case '_':
            return undo()
          case 's':
            return stash()
          case 'g':
            return openExternalEditor()
          case 'v':
            return pasteImage()
          case 'r':
            return openSearch()
          default:
            return
        }
      }
      const option = !key.meta && MAC_OPTION[input] ? MAC_OPTION[input] : key.meta ? input : ''
      if (key.meta && (key.backspace || key.delete)) {
        const chip = backspaceChip(bufRef.current, store)
        return chip ? edit(chip) : kill(killWordBack(bufRef.current))
      }
      if (option) {
        const buf = bufRef.current
        if (option === 'b') return cursorTo(wordBack(buf))
        if (option === 'f') return cursorTo(wordForward(buf))
        if (option === 'd') return kill(killWordForward(buf))
        if (option === 'v') return pasteImage()
        if (option === 'y') {
          const span = yankSpan.current
          if (lastAction.current !== 'yank' || !span) return
          const res = yankPop(buf, ringRef.current, span)
          if (!res) return
          edit(res.buf)
          yankSpan.current = res.span
          lastAction.current = 'yank'
          return
        }
      }
      if (key.meta) return
      if (key.leftArrow)
        return cursorTo(moveChip(bufRef.current, -1, store) ?? move(bufRef.current, -1))
      if (key.rightArrow)
        return cursorTo(moveChip(bufRef.current, 1, store) ?? move(bufRef.current, 1))
      if (key.home) return cursorTo(home(bufRef.current))
      if (key.end) return cursorTo(end(bufRef.current))
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
          ? cursorTo(moveLine(bufRef.current, -1))
          : browseHistory(-1)
      }
      if (key.downArrow) {
        return bufRef.current.text.includes('\n')
          ? cursorTo(moveLine(bufRef.current, 1))
          : browseHistory(1)
      }
      // Terminals send DEL for the backspace key; Ink may report it as either flag.
      if (key.backspace || key.delete) return deleteBack()
      if (input === '?' && bufRef.current.text === '' && onShortcuts) return onShortcuts()
      if (!input) return
      // A chunk like `hi\r` (tmux, ssh, scripted input) carries its own Enter. Text before it is
      // inserted, the Enter submits, and text after it becomes the next draft.
      const chunk = splitEnter(input)
      if (!chunk.enter) return typed(input)
      if (chunk.before) typed(chunk.before)
      const continued = backslashNewline(bufRef.current)
      if (continued) return edit(insert(continued, chunk.rest))
      submit()
      if (chunk.rest) typed(chunk.rest)
    },
    { isActive: active },
  )

  /** Second Esc: clear a draft (saving it) or, on an empty prompt, ask for the rewind menu. */
  function doubleEsc(): void {
    lastEsc.current = 0
    const text = bufRef.current.text
    if (text === '') {
      onRewindMenu?.()
      return
    }
    onSaveDraft?.(text)
    edit(emptyBuffer)
  }

  usePaste(
    (text) => {
      if (editorBusy.current) return
      if (searchRef.current) return
      const next = insertPaste(bufRef.current, text.replace(/\r\n?/g, '\n'), store)
      edit(next, 'edit')
    },
    { isActive: active },
  )

  const selection =
    vim && (vimMode === 'visual' || vimMode === 'visual-line')
      ? visualRange(view, vimRef.current)
      : undefined
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
        <EditorLines buf={view} active={active} placeholder={placeholder} selection={selection} />
      </Box>
      {shellMode ? (
        <Text color={color.shell} dimColor>
          {'  '}shell mode: runs in the project root, no approval
        </Text>
      ) : null}
      {search ? <HistorySearch query={search.query} match={searchHit} /> : null}
      {completions.map((item, i) => (
        <Text key={`${item.kind}:${item.value}`} wrap="truncate-end">
          <Text
            dimColor={i !== pickRef.current}
            color={i === pickRef.current ? color.accent : undefined}
          >
            {'  '}
            {i === pickRef.current ? sym.pointer : ' '} @{item.value}
          </Text>
          <Text dimColor> {MENTION_LABEL[item.kind]}</Text>
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
