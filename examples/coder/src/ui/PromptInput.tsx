import type { FileUIPart } from 'ai'
import { Box, type Key, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
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
  popUndo,
  pushKill,
  pushUndo,
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
import { cursorPlace, moveVisual, type VisualRow, visualRows, wrapWords } from './wrap.ts'

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
  /**
   * Ctrl+B: return a promise to take the key (resolving `false` = nothing to background, the key
   * then moves the cursor left like readline), or `false` to leave it to the editor at once.
   */
  onBackground?(): Promise<boolean> | false
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
  /**
   * Down was pressed on the last visual row with no menu open and history at the newest entry:
   * the integrator may move focus to the footer.
   */
  onFooterFocus?(): void
  /** Override of the placeholder shown when the prompt is empty. */
  placeholder?: string
  /** Replace the buffer with `text` whenever `id` changes (rewind puts the prompt back, a suggestion is accepted). */
  prefill?: { id: number; text: string }
}

/** Placeholder of an empty prompt. */
export const PLACEHOLDER = 'Try "explain this codebase"'

/** Highlight of a VISUAL selection (end exclusive). */
type Selection = { start: number; end: number }

/** Terminal rows of the prompt chrome around the text: border (2), padding (2), `> ` prefix (2). */
const CHROME_COLUMNS = 6

/** Cells of a visual row: its characters plus the cursor cell, each flagged when highlighted. */
function rowRuns(
  text: string,
  row: VisualRow,
  cursorAt: number | undefined,
  selection: Selection | undefined,
): Array<{ text: string; on: boolean }> {
  const cells: Array<{ ch: string; on: boolean }> = []
  let at = row.start
  for (const ch of text.slice(row.start, row.end)) {
    const selected = selection !== undefined && at >= selection.start && at < selection.end
    cells.push({ ch, on: at === cursorAt || selected })
    at += ch.length
  }
  if (cursorAt !== undefined && cursorAt >= row.end) cells.push({ ch: ' ', on: true })
  const runs: Array<{ text: string; on: boolean }> = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last && last.on === cell.on) last.text += cell.ch
    else runs.push({ text: cell.ch, on: cell.on })
  }
  return runs
}

/**
 * The prompt text as visual rows. Each row is ONE `<Text>` (nested `<Text>` only for the cursor and
 * the selection), already wrapped at `width` by {@link visualRows}, so Ink never re-wraps it.
 */
function EditorRows({
  buf,
  rows,
  active,
  placeholder,
  selection,
  width,
}: {
  buf: Buffer
  rows: VisualRow[]
  active: boolean
  placeholder: string
  selection?: Selection
  width: number
}): ReactElement {
  if (buf.text === '') {
    const lines = wrapWords(placeholder, width)
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: wrapped placeholder rows are positional
          <Text key={i} dimColor wrap="truncate-end">
            {i === 0 && active ? <Text inverse>{line.slice(0, 1) || ' '}</Text> : line.slice(0, 1)}
            {line.slice(1)}
          </Text>
        ))}
      </Box>
    )
  }
  const place = cursorPlace(buf.text, rows, buf.cursor)
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {rows.map((row, i) => {
        const cursorAt = active && place.row === i ? buf.cursor : undefined
        const runs = rowRuns(buf.text, row, cursorAt, active ? selection : undefined)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: visual rows are positional
          <Text key={i} wrap="truncate-end">
            {runs.length === 0
              ? ' '
              : runs.map((run, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
                  <Text key={r} inverse={run.on}>
                    {run.text}
                  </Text>
                ))}
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

/** Suggestions with the one named exactly like the typed text first (Enter then runs it). */
function orderExactFirst(
  list: ReturnType<typeof matchSlash>,
  text: string,
): ReturnType<typeof matchSlash> {
  const exact = list.findIndex((c) => `/${c.name}` === text)
  if (exact <= 0) return list
  return [list[exact] as (typeof list)[number], ...list.slice(0, exact), ...list.slice(exact + 1)]
}

/** A command whose usage starts with `<` cannot run without arguments: accepting it types its name. */
function needsArgs(command: { usage?: string }): boolean {
  return command.usage?.startsWith('<') === true
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
    onFooterFocus,
    onTextChange,
    placeholder = PLACEHOLDER,
    editorMode = 'normal',
    onVimMode,
    onHint,
    onCtrlDEmpty,
    onBackground,
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
    goalCol.current = undefined
    setView(next)
  }
  // history browsing lives in refs: two keys can arrive before React re-renders
  const histRef = useRef<number | null>(null)
  const historyRef = useRef(history)
  historyRef.current = history
  const draft = useRef('')
  const goalCol = useRef<number | undefined>(undefined)
  const { columns } = useWindowSize()
  const wrapWidth = Math.max(1, columns - CHROME_COLUMNS - 1)
  const widthRef = useRef(wrapWidth)
  widthRef.current = wrapWidth
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
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
  // menus only open for text the user typed: a recalled history entry never opens one, and Esc
  // dismisses the menu until the text changes
  const menuOn = active && histRef.current === null && dismissedFor !== view.text
  const completions: MentionItem[] =
    menuOn && mention ? matchMentions(files, mention.query, agents, folders) : []
  const suggestions =
    menuOn && !mention
      ? orderExactFirst(matchSlash(view.text, commands), view.text).slice(0, 8)
      : []
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
    histRef.current = null
    onTextChange?.(next.text)
  })

  const edit = (next: Buffer, kind: UndoKind = 'edit'): void => {
    const current = bufRef.current
    if (next.text !== current.text) {
      undoRef.current = pushUndo(undoRef.current, current, kind, Date.now())
    }
    lastAction.current = 'other'
    setBuf(next)
    histRef.current = null
    setPick(0)
    onTextChange?.(next.text)
  }
  const cursorTo = (next: Buffer): void => {
    lastAction.current = 'other'
    setBuf(next)
  }

  /** Show a history entry (or the draft) and tell the integrator the text changed. */
  const showHistory = (text: string): void => {
    setBuf(bufferOf(text))
    onTextChange?.(text)
  }

  /** Up / Down on the first / last row: older / newer prompt. `false` = Down at the newest entry. */
  const browseHistory = (dir: -1 | 1): boolean => {
    const list = historyRef.current
    const at = histRef.current
    if (at === null) {
      if (dir === 1) return false
      const text = bufRef.current.text
      let index = list.length - 1
      while (index >= 0 && list[index] === text) index--
      if (index < 0) return true
      draft.current = text
      histRef.current = index
      showHistory(list[index] ?? '')
      return true
    }
    const next = at + dir
    if (next >= list.length) {
      histRef.current = null
      showHistory(draft.current)
    } else if (next >= 0) {
      histRef.current = next
      showHistory(list[next] ?? '')
    }
    return true
  }

  const submit = (override?: string): void => {
    const text = (override ?? bufRef.current.text).trim()
    if (text === '') return
    const expanded = expandPastes(text, store)
    const images = imagesInOrder(text, store)
    setBuf(emptyBuffer)
    histRef.current = null
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
      histRef.current = null
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

  const menuVisible = (): boolean =>
    completionsRef.current.length > 0 || suggestionsRef.current.length > 0

  /** Enter / Tab on an open menu. `run` lets Enter execute a slash command. Returns whether it handled the key. */
  const acceptMenu = (run: boolean): boolean => {
    const buf = bufRef.current
    const chosen = completionsRef.current[pickRef.current]
    const at = mentionAt(buf.text, buf.cursor)
    if (chosen && at) {
      setPick(0)
      edit(completeItem(buf.text, at.start, buf.cursor, chosen))
      return true
    }
    const command = suggestionsRef.current[pickRef.current]
    if (!command) return false
    if (run && !needsArgs(command)) submit(`/${command.name}`)
    else edit(bufferOf(`/${command.name} `))
    return true
  }

  /** Up (`-1`) / Down (`1`): menu, then visual rows, then queue take-back, history, footer. */
  const vertical = (dir: -1 | 1): void => {
    const count = Math.max(completionsRef.current.length, suggestionsRef.current.length)
    if (count > 0) {
      setPick((pickRef.current + (dir === -1 ? count - 1 : 1)) % count)
      return
    }
    const buf = bufRef.current
    const rows = visualRows(buf.text, widthRef.current)
    const goal = goalCol.current ?? cursorPlace(buf.text, rows, buf.cursor).col
    const moved = moveVisual(buf.text, rows, buf.cursor, dir, goal)
    if (moved !== undefined) {
      cursorTo({ ...buf, cursor: moved })
      goalCol.current = goal
      return
    }
    if (dir === -1 && queuedCount > 0) {
      const recalled = onRecallQueue?.()
      if (recalled) {
        edit(bufferOf(buf.text === '' ? recalled : `${recalled}\n${buf.text}`))
        return
      }
    }
    if (!browseHistory(dir)) onFooterFocus?.()
  }

  useInput(
    (input, key) => {
      if (editorBusy.current) return
      if (searchRef.current) return searchKey(input, key)

      // --- vim ---------------------------------------------------------------------------
      if (vim) {
        const mode = vimRef.current.mode
        if (key.escape) {
          if (menuVisible()) setDismissedFor(bufRef.current.text)
          return runVim({ escape: true })
        }
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
        // Esc first closes an open menu; otherwise a single Esc keeps its meaning elsewhere (the
        // App interrupts) and this only adds the double press.
        if (menuVisible()) {
          setDismissedFor(bufRef.current.text)
          return
        }
        if (key.meta) return doubleEsc()
        const now = Date.now()
        const previous = lastEsc.current
        lastEsc.current = now
        if (previous !== 0 && now - previous < DOUBLE_ESC_MS) doubleEsc()
        return
      }

      if (key.return) {
        if (key.shift || key.meta) return edit(insert(bufRef.current, '\n'))
        if (acceptMenu(true)) return
        const continued = backslashNewline(bufRef.current)
        if (continued) return edit(continued)
        return submit()
      }
      if (key.tab) {
        if (key.shift) return
        acceptMenu(false)
        return
      }
      if (key.escape || key.pageUp || key.pageDown) return
      if (key.ctrl) {
        const buf = bufRef.current
        switch (input) {
          case 'j':
            return edit(insert(buf, '\n'))
          case 'p':
            return vertical(-1)
          case 'n':
            return vertical(1)
          case 'a':
            return cursorTo(home(buf))
          case 'e':
            return cursorTo(end(buf))
          case 'b': {
            const pending = onBackground?.() ?? false
            if (pending === false) return cursorTo(move(buf, -1))
            void pending.then((moved) => {
              if (!moved) cursorTo(move(bufRef.current, -1))
            })
            return
          }
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
      if (key.upArrow) return vertical(-1)
      if (key.downArrow) return vertical(1)
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
      if (!acceptMenu(true)) submit()
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
  const rows = visualRows(view.text, wrapWidth)
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
        <EditorRows
          buf={view}
          rows={rows}
          active={active}
          placeholder={placeholder}
          selection={selection}
          width={wrapWidth}
        />
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
