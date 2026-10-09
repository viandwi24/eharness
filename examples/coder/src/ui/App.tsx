import type { FileUIPart } from 'ai'
import { Box, useApp, useInput, useStdout } from 'ink'
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { copyToClipboard } from '../app/session-tools.ts'
import type {
  BackgroundTask,
  CoderController,
  CoderMessage,
  CustomCommand,
  PermissionMode,
  RewindResult,
  ThinkingLevel,
} from '../contracts.ts'
import { runTurn, steerTurn } from './driver.ts'
import { Footer, ShortcutsPanel } from './Footer.tsx'
import { FooterTasks, footerTasks, MAX_FOOTER_ROWS } from './FooterTasks.tsx'
import { createFileLister } from './mentions.ts'
import { notify as rawNotify, setTerminalTitle as rawSetTitle } from './notify.ts'
import { PermissionPrompt, usePending } from './PermissionPrompt.tsx'
import { PromptInput } from './PromptInput.tsx'
import { AgentPage } from './pages/AgentPage.tsx'
import { AgentsPage } from './pages/AgentsPage.tsx'
import { ConfigPage } from './pages/ConfigPage.tsx'
import { ContextPage } from './pages/ContextPage.tsx'
import { CostPage } from './pages/CostPage.tsx'
import { DiffPage } from './pages/DiffPage.tsx'
import { DoctorPage } from './pages/DoctorPage.tsx'
import { shortModel } from './pages/format.ts'
import { HelpPage } from './pages/HelpPage.tsx'
import { usePageHost } from './pages/host.ts'
import { MemoryPage } from './pages/MemoryPage.tsx'
import { PermissionsPage } from './pages/PermissionsPage.tsx'
import { StatusPage } from './pages/StatusPage.tsx'
import { agentTargetOfTask, type PageSpec } from './pages/spec.ts'
import { TasksPage } from './pages/TasksPage.tsx'
import { TranscriptPage } from './pages/TranscriptPage.tsx'
import { ModelPicker } from './pickers/ModelPicker.tsx'
import { OutputStylePicker } from './pickers/OutputStylePicker.tsx'
import { ThinkingPicker } from './pickers/ThinkingPicker.tsx'
import { QuestionDialog, usePendingQuestions } from './QuestionDialog.tsx'
import { QueuedMessages } from './QueuedMessages.tsx'
import { RewindMenu } from './RewindMenu.tsx'
import { SessionPicker } from './SessionPicker.tsx'
import { SideQuestion } from './SideQuestion.tsx'
import { ThinkingIndicator } from './Spinner.tsx'
import { SuggestionKeys } from './Suggestion.tsx'
import { isBuiltin, parseSlash, runSlash } from './slash.ts'
import {
  type Entry,
  hasOpenTodos,
  initialState,
  latestTodos,
  reduce,
  type ViewState,
} from './state.ts'
import { TodoPanel } from './TodoPanel.tsx'
import { Transcript } from './Transcript.tsx'
import { setTheme, useTheme } from './theme.ts'
import { modeLabel as vimModeLabel } from './vim.ts'

/** Props of {@link App}. */
export interface AppProps {
  controller: CoderController
  /** Sent as the first prompt once the UI is up. */
  initialPrompt?: string
  /** Stored messages of an already existing session (`--continue`, `--resume <id>`). */
  initialMessages?: CoderMessage[]
  /** coder version for the welcome box. */
  version?: string
  /** Test seams for the terminal side effects (bell/desktop notification, title, clipboard). */
  io?: {
    notify?(text: string, mode: 'off' | 'bell' | 'desktop'): void
    setTitle?(text: string): void
    /** Copy text; resolves with the method used. */
    copy?(text: string): Promise<string>
  }
}

/** A message typed while a turn runs. Plain messages are steered or sent after the turn; commands wait. */
interface Queued {
  kind: 'message' | 'command'
  text: string
  /** Pasted images: such an entry waits for the turn to end and runs as its own prompt. */
  files?: FileUIPart[]
}

/** Previous prompts without consecutive duplicates, newest last. */
function pushHistory(list: string[], text: string): string[] {
  return list[list.length - 1] === text ? list : [...list, text].slice(-1000)
}

interface ShellRun {
  command: string
  output: string
  exitCode: number | null
}

/** The inline dialog below the prompt, if any. */
type Picker = 'session' | 'model' | 'thinking' | 'rewind' | 'outputStyle' | null

const EXIT_WINDOW_MS = 2000
const CTRL_D_WINDOW_MS = 800
const HINT_MS = 3000
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'
const RESIZE_SETTLE_MS = 150

/** Terminal side effects only on a real terminal (piped output and tests stay clean). */
const defaultNotify = (text: string, mode: 'off' | 'bell' | 'desktop'): void => {
  if (process.stdout.isTTY) rawNotify(text, mode)
}
const defaultSetTitle = (text: string): void => {
  if (process.stdout.isTTY) rawSetTitle(text)
}

/** The one-line notice shown when project settings were ignored. */
export function untrustedNotice(keys: string[]): string {
  return `Project settings ignored until trusted: ${keys.join(', ')}. Restart and answer the trust question, or pass --trust-project.`
}

/** `Alt+P` / `Esc p`, or the character macOS sends for `Option+P` when Option is not Meta. */
function isModelKey(input: string, meta: boolean): boolean {
  return (meta && input === 'p') || input === 'π'
}

/** `Alt+T` / `Esc t`, or the character macOS sends for `Option+T`. */
function isThinkingKey(input: string, meta: boolean): boolean {
  return (meta && input === 't') || input === '†'
}

function messageEntries(messages: CoderMessage[]): Entry[] {
  return messages
    .filter((m) => m.parts.length > 0)
    .map((message): Entry => ({ kind: 'message', id: `m:${message.id}`, message }))
}

/** Rough output-token estimate of the live message for the thinking line (4 chars a token). */
function liveTokens(message: CoderMessage | null): number | undefined {
  if (!message) return undefined
  let chars = 0
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'reasoning') chars += part.text.length
  }
  return chars > 0 ? Math.round(chars / 4) : undefined
}

/** The interactive coding agent UI. */
export function App({
  controller,
  initialPrompt,
  initialMessages,
  version,
  io,
}: AppProps): ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  useState(() => setTheme(controller.setting('theme') ?? 'auto'))
  useTheme()
  const notifyFn = io?.notify ?? defaultNotify
  const setTitleFn = io?.setTitle ?? defaultSetTitle
  const [state, dispatch] = useReducer(reduce, initialMessages, (messages) => {
    let initial =
      messages && messages.length > 0
        ? reduce(initialState(), { type: 'load', messages })
        : initialState()
    const untrusted = controller.config.untrusted ?? []
    if (untrusted.length > 0) {
      initial = reduce(initial, { type: 'system', tone: 'warn', text: untrustedNotice(untrusted) })
    }
    return initial
  })
  const [mode, setMode] = useState<PermissionMode>(controller.permissions.mode)
  const [model, setModel] = useState(controller.model ?? controller.config.model)
  const [thinking, setThinking] = useState<ThinkingLevel>(controller.thinking ?? 'provider-default')
  const [statsVersion, setStatsVersion] = useState(0)
  const [stats, setStats] = useState<{ leftPct?: number; costUsd?: number }>({})
  const [hint, setHint] = useState<string | null>(null)
  const [picker, setPicker] = useState<Picker>(controller.config.resume === true ? 'session' : null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<'normal' | 'vim'>(
    controller.setting('editorMode') === 'vim' ? 'vim' : 'normal',
  )
  const [vimLabel, setVimLabel] = useState<string | undefined>(undefined)
  const [focus, setFocus] = useState(false)
  const [todosCollapsed, setTodosCollapsed] = useState(false)
  const [tasks, setTasks] = useState<BackgroundTask[]>(() => controller.tasks())
  const [sideQuestion, setSideQuestion] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<string | undefined>(undefined)
  const [inputEmpty, setInputEmpty] = useState(true)
  /** Selected row of the footer task list (null: the prompt has focus). */
  const [footerSel, setFooterSel] = useState<number | null>(null)
  const footerSelRef = useRef<number | null>(null)
  footerSelRef.current = footerSel
  const footerItemsRef = useRef<BackgroundTask[]>([])
  const [prefill, setPrefill] = useState<{ id: number; text: string }>({ id: 0, text: '' })
  const [sessionLabel, setSessionLabel] = useState<string | undefined>(controller.sessionName)
  const [statusLine, setStatusLine] = useState<string | undefined>(undefined)
  const editorRunning = useRef(false)
  const lastCtrlD = useRef(0)
  const sideRef = useRef(sideQuestion)
  sideRef.current = sideQuestion
  const inputEmptyRef = useRef(true)
  const taskStatus = useRef<Map<string, BackgroundTask['status']>>(new Map())
  const [inputEpoch, setInputEpoch] = useState(0)
  const [queue, setQueueState] = useState<Queued[]>([])
  const queueRef = useRef<Queued[]>([])
  const setQueue = useCallback((next: Queued[]) => {
    queueRef.current = next
    setQueueState(next)
  }, [])
  const [promptHistory, setPromptHistory] = useState<string[]>([])
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([])
  const commandsRef = useRef<CustomCommand[]>([])
  commandsRef.current = customCommands
  const searchOpen = useRef(false)
  const turnActive = useRef(false)
  const drainRef = useRef<() => void>(() => {})
  const deliverRef = useRef<() => void>(() => {})
  const pageHost = usePageHost()
  const listFiles = useMemo(() => createFileLister(controller.workspace), [controller])
  const shellRuns = useRef<ShellRun[]>([])
  const shellAbort = useRef<AbortController | undefined>(undefined)
  const approvals = usePending(controller.broker)
  const questions = usePendingQuestions(controller.broker)
  const pending = useMemo(() => [...approvals, ...questions], [approvals, questions])
  const stateRef = useRef(state)
  stateRef.current = state
  const modelRef = useRef(model)
  modelRef.current = model
  const pickerRef = useRef(picker)
  pickerRef.current = picker
  const pageRef = useRef(pageHost)
  pageRef.current = pageHost
  const pendingRef = useRef(pending.length)
  pendingRef.current = pending.length
  const promptHistoryRef = useRef(promptHistory)
  promptHistoryRef.current = promptHistory
  // A narrower terminal reflows the previous frame, so Ink's erase-by-line-count leaves stale
  // rows behind. Like Claude Code, clear and reprint the whole transcript at the new width once the
  // resize settles (on the primary screen only; a page open on the alternate screen defers it).
  const [resizePending, setResizePending] = useState(false)
  // a slash command's own progress line (`/compact`), shown like the turn's thinking line
  const [activity, setActivity] = useState<{ status: string; startedAt: number } | null>(null)
  useEffect(() => {
    const tty = stdout as NodeJS.WriteStream
    let width = tty.columns
    let timer: ReturnType<typeof setTimeout> | undefined
    const onResize = (): void => {
      if (tty.columns === width) return
      width = tty.columns
      clearTimeout(timer)
      timer = setTimeout(() => setResizePending(true), RESIZE_SETTLE_MS)
    }
    stdout.on('resize', onResize)
    return () => {
      clearTimeout(timer)
      stdout.off('resize', onResize)
    }
  }, [stdout])
  useEffect(() => {
    if (!resizePending || pageHost.active) return
    setResizePending(false)
    stdout.write(CLEAR_SCREEN)
    dispatch({ type: 'redraw' })
  }, [resizePending, pageHost.active, stdout])
  const busy = useRef(false)
  const lastCtrlC = useRef(0)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const footerItems = useMemo(() => footerTasks(tasks), [tasks])
  footerItemsRef.current = footerItems
  // the list shrank under the selection: clamp it, or leave when it is empty
  useEffect(() => {
    setFooterSel((sel) => {
      if (sel === null) return null
      if (footerItems.length === 0) return null
      return Math.min(sel, footerItems.length - 1)
    })
  }, [footerItems.length])

  const showHint = useCallback((text: string) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])

  useEffect(() => controller.permissions.subscribe(setMode), [controller])
  const [autoPaused, setAutoPaused] = useState(controller.permissions.autoState().paused)
  // auto mode: a transient notice per classifier block, a transcript line when it pauses
  useEffect(
    () =>
      controller.permissions.subscribeAuto((event) => {
        setAutoPaused(event.state.paused)
        if (event.type === 'blocked') {
          showHint(`auto mode blocked ${event.toolName}: ${event.reason}`)
        } else if (event.type === 'paused') {
          dispatch({
            type: 'system',
            tone: 'warn',
            text:
              event.cause === 'consecutive'
                ? 'Auto mode paused after 3 blocked actions in a row: approve an action to resume it.'
                : 'Auto mode paused after 20 blocked actions: approve an action to resume it.',
          })
        } else {
          showHint('auto mode resumed')
        }
      }),
    [controller, showHint],
  )
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current)
    },
    [],
  )

  const refreshStats = useCallback(() => setStatsVersion((v) => v + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when statsVersion changes
  useEffect(() => {
    let cancelled = false
    controller
      .stats()
      .then((next) => {
        if (cancelled) return
        setStats({
          ...(next.contextWindow > 0
            ? {
                leftPct: Math.max(
                  0,
                  Math.round(100 - (next.contextTokens / next.contextWindow) * 100),
                ),
              }
            : {}),
          ...(next.costUsd !== undefined ? { costUsd: next.costUsd } : {}),
        })
      })
      .catch(() => {})
    controller
      .statusLineText()
      .then((text) => {
        if (!cancelled) setStatusLine(text || undefined)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [controller, statsVersion])

  // background tasks: footer count and a line when one finishes
  useEffect(() => {
    for (const t of controller.tasks()) taskStatus.current.set(t.id, t.status)
    return controller.onTasks((list) => {
      setTasks(list)
      for (const t of list) {
        const before = taskStatus.current.get(t.id)
        taskStatus.current.set(t.id, t.status)
        if (before === 'running' && t.status !== 'running') {
          const how =
            t.status === 'completed' || t.status === 'failed'
              ? `exit ${t.exitCode ?? (t.status === 'completed' ? 0 : '?')}`
              : t.status
          dispatch({
            type: 'system',
            text: `Background task ${t.id} finished (${how})`,
          })
        }
      }
    })
  }, [controller])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload after each turn (statsVersion)
  useEffect(() => {
    let cancelled = false
    controller
      .commands()
      .then((list) => {
        if (!cancelled) setCustomCommands(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [controller, statsVersion])

  useEffect(() => {
    let cancelled = false
    controller
      .history()
      .then((stored) => {
        if (!cancelled) setPromptHistory((now) => [...stored, ...now].slice(-1000))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [controller])

  const loadSearchPool = useCallback(async (): Promise<string[]> => {
    const all = await controller.history({ allProjects: true, limit: 1000 })
    return [...all, ...promptHistoryRef.current]
  }, [controller])

  // a permission question must be seen: leave any open page for it
  const { close: closePage } = pageHost
  const pagePhase = pageHost.view.phase
  useEffect(() => {
    if (pending.length > 0 && pagePhase === 'open') closePage()
  }, [pending.length, pagePhase, closePage])

  // a question or approval needs the user: tell them, in case the terminal is in the background
  const lastPending = useRef(0)
  useEffect(() => {
    if (pending.length > lastPending.current) {
      notifyFn('coder needs your input', controller.setting('notifications') ?? 'bell')
    }
    lastPending.current = pending.length
  }, [pending.length, controller, notifyFn])

  // terminal title: the session name, else the first prompt
  const firstPrompt = state.entries.find((e) => e.kind === 'user')
  const titleText =
    sessionLabel ?? (firstPrompt?.kind === 'user' ? firstPrompt.text.split('\n')[0] : undefined)
  useEffect(() => {
    setTitleFn(titleText ? `coder · ${titleText.slice(0, 60)}` : 'coder')
  }, [titleText, setTitleFn])

  const openPage = useCallback((page: PageSpec) => {
    if (pendingRef.current > 0) return
    setPicker(null)
    setShortcutsOpen(false)
    pageRef.current.open(page)
  }, [])

  /** The conversation so far, as a snapshot for the viewer (including the live message). */
  const openTranscript = useCallback(() => {
    const current = stateRef.current
    const entries: Entry[] = [...current.entries]
    if (current.live && current.live.parts.length > current.committed) {
      entries.push({
        kind: 'message',
        id: `live:${current.live.id}`,
        message: { ...current.live, parts: current.live.parts.slice(current.committed) },
      })
    }
    openPage({ kind: 'transcript', title: 'Transcript', entries })
  }, [openPage])

  const startTurn = useCallback(
    (text: string, files?: FileUIPart[]) => {
      busy.current = true
      setSuggestion(undefined)
      // commands the user ran with `!` since the last prompt: the model sees them first
      const ran = shellRuns.current.splice(0)
      const context = ran
        .map(
          (r) =>
            `<shell-command>${r.command}</shell-command>\n<shell-output>${r.output}${
              r.exitCode === null ? '\n(aborted)' : `\n(exit ${r.exitCode})`
            }</shell-output>\n\n`,
        )
        .join('')
      turnActive.current = true
      void runTurn(
        controller,
        context + text,
        dispatch,
        { onToolResult: () => deliverRef.current() },
        files,
      ).finally(() => {
        turnActive.current = false
        busy.current = false
        refreshStats()
        notifyFn('coder: turn finished', controller.setting('notifications') ?? 'bell')
        if (controller.setting('promptSuggestions') === true) {
          controller
            .suggestNext()
            .then((next) => {
              if (next && !busy.current && inputEmptyRef.current) setSuggestion(next)
            })
            .catch(() => {})
        }
        drainRef.current()
      })
    },
    [controller, refreshStats, notifyFn],
  )

  /** Release the busy flag and run whatever waited for it. */
  const release = useCallback(() => {
    busy.current = false
    drainRef.current()
  }, [])

  /** Run a submitted line right now: shell command, slash command, custom command or prompt. */
  const execute = useCallback(
    (text: string, files?: FileUIPart[]) => {
      if (text.startsWith('!')) {
        const command = text.slice(1).trim()
        if (!command) return
        busy.current = true
        const abort = new AbortController()
        shellAbort.current = abort
        void controller
          .shell(command, abort.signal)
          .then((result) => {
            shellRuns.current.push({ command, ...result })
            dispatch({ type: 'shell-result', command, ...result })
          })
          .catch((error: unknown) => {
            dispatch({
              type: 'system',
              text: `Shell failed: ${error instanceof Error ? error.message : String(error)}`,
              tone: 'error',
            })
          })
          .finally(() => {
            shellAbort.current = undefined
            release()
          })
        return
      }
      dispatch({ type: 'user-submitted', text })
      const parsed = parseSlash(text)
      if (!parsed) {
        startTurn(text, files)
        return
      }
      busy.current = true
      if (!isBuiltin(parsed.name)) {
        // a custom command or skill: the typed text stays visible, the expansion is sent
        void (async () => {
          let known = commandsRef.current.some((c) => c.name === parsed.name)
          if (!known) {
            const fresh = await controller.commands().catch(() => [])
            known = fresh.some((c) => c.name === parsed.name)
          }
          if (!known) {
            dispatch({
              type: 'system',
              text: `Unknown command /${parsed.name}. Type /help.`,
              tone: 'error',
            })
            return release()
          }
          try {
            startTurn(await controller.expandCommand(parsed.name, parsed.args))
          } catch (error) {
            dispatch({
              type: 'system',
              text: `/${parsed.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              tone: 'error',
            })
            release()
          }
        })()
        return
      }
      void runSlash(text, {
        controller,
        model: modelRef.current,
        activity: (status) => setActivity(status ? { status, startedAt: Date.now() } : null),
        print: (line, tone) => dispatch({ type: 'system', text: line, tone }),
        reset: () => {
          stdout.write(CLEAR_SCREEN)
          dispatch({ type: 'reset' })
        },
        load: (messages) => {
          stdout.write(CLEAR_SCREEN)
          dispatch({ type: 'load', messages })
        },
        openPage,
        subagents: () => stateRef.current.subagents,
        pickSession: () => setPicker('session'),
        pickModel: () => setPicker('model'),
        pickThinking: () => setPicker('thinking'),
        submit: (prompt) => {
          busy.current = false
          startTurn(prompt)
        },
        todos: () => latestTodos(stateRef.current),
        openRewind: () => {
          if (pendingRef.current === 0) setPicker('rewind')
        },
        sideQuestion: (question) => setSideQuestion(question),
        pickOutputStyle: () => setPicker('outputStyle'),
        applyTheme: (name) => setTheme(name),
        applyEditorMode: setEditorMode,
        toggleFocus: () => {
          setFocus((f) => {
            dispatch({ type: 'set-focus', focus: !f })
            dispatch({ type: 'system', text: `Focus view ${f ? 'off' : 'on'}.` })
            return !f
          })
        },
        copy: async (text) => {
          if (io?.copy) return io.copy(text)
          const res = await copyToClipboard(text)
          if (res.osc52) stdout.write(res.osc52)
          return res.method
        },
        refreshTitle: () => setSessionLabel(controller.sessionName),
        setModelLabel: setModel,
        refreshStats,
        exit,
      }).finally(() => {
        if (!turnActive.current) release()
      })
    },
    [controller, exit, io, openPage, refreshStats, release, startTurn, stdout],
  )

  // Runs whatever waited for the busy flag: queued commands one at a time, queued messages as one prompt.
  drainRef.current = () => {
    if (busy.current) return
    const [first, ...rest] = queueRef.current
    if (!first) return
    if (first.kind === 'command') {
      setQueue(rest)
      execute(first.text, first.files)
      return
    }
    const messages: Queued[] = [first]
    let i = 0
    while (rest[i]?.kind === 'message') messages.push(rest[i++] as Queued)
    setQueue(rest.slice(i))
    for (const m of messages) dispatch({ type: 'user-submitted', text: m.text })
    startTurn(messages.map((m) => m.text).join('\n\n'))
  }

  // A tool result is on the live stream: steer every queued message into the running turn.
  deliverRef.current = () => {
    const messages = queueRef.current.filter((q) => q.kind === 'message')
    if (messages.length === 0) return
    setQueue(queueRef.current.filter((q) => q.kind !== 'message'))
    void steerTurn(controller, messages.map((m) => m.text).join('\n\n'), dispatch, {
      onToolResult: () => deliverRef.current(),
      onOwnTurn: () => {
        busy.current = true
        turnActive.current = true
      },
    }).then((how) => {
      if (how !== 'turn') return
      turnActive.current = false
      refreshStats()
      release()
    })
  }

  const submit = useCallback(
    (text: string, files?: FileUIPart[]) => {
      setShortcutsOpen(false)
      setSuggestion(undefined)
      // the editor clears itself on submit without reporting a text change
      inputEmptyRef.current = true
      setInputEmpty(true)
      setPromptHistory((list) => pushHistory(list, text))
      void controller.addHistory(text).catch(() => {})
      if (busy.current) {
        if (text === '!') return
        const withFiles = files !== undefined && files.length > 0
        const kind = text.startsWith('!') || parseSlash(text) || withFiles ? 'command' : 'message'
        setQueue([...queueRef.current, { kind, text, ...(withFiles ? { files } : {}) }])
        return
      }
      execute(text, files)
    },
    [controller, execute, setQueue],
  )

  const recallQueue = useCallback((): string | null => {
    const items = queueRef.current
    if (items.length === 0) return null
    setQueue([])
    return items.map((q) => q.text).join('\n')
  }, [setQueue])

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (initialPrompt?.trim()) submit(initialPrompt.trim())
  }, [])

  const ctrlDExit = useCallback(() => {
    const now = Date.now()
    if (now - lastCtrlD.current <= CTRL_D_WINDOW_MS) {
      if (stateRef.current.running) controller.abort()
      shellAbort.current?.abort()
      exit()
      return
    }
    lastCtrlD.current = now
    showHint('press Ctrl+D again to exit')
  }, [controller, exit, showHint])

  /** Close whatever dialog is open: decline pending approvals, dismiss questions, close pickers and pages. */
  const closeDialog = useCallback(() => {
    for (const r of controller.broker.pending()) controller.broker.answer(r.id, { approved: false })
    for (const q of controller.broker.pendingQuestions())
      controller.broker.answerQuestion(q.id, null)
    setPicker(null)
    setSideQuestion(null)
    if (pageRef.current.active) pageRef.current.close()
  }, [controller])

  useInput((input, key) => {
    if (editorRunning.current) return
    const overlay = pendingRef.current > 0 || pickerRef.current !== null || sideRef.current !== null
    const pageOpen = pageRef.current.active
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      const dialog =
        pendingRef.current > 0 || pickerRef.current !== null || sideRef.current !== null
      if (dialog || pageOpen) {
        // a dialog closes with a second Ctrl+C instead of exiting
        if (now - lastCtrlC.current <= EXIT_WINDOW_MS) {
          lastCtrlC.current = 0
          closeDialog()
        } else {
          lastCtrlC.current = now
          showHint('press Ctrl+C again to close')
        }
        return
      }
      if (now - lastCtrlC.current <= EXIT_WINDOW_MS) {
        if (stateRef.current.running) controller.abort()
        shellAbort.current?.abort()
        exit()
        return
      }
      lastCtrlC.current = now
      // the first press clears whatever is typed (a fresh prompt editor)
      setInputEpoch((n) => n + 1)
      setFooterSel(null)
      showHint('press Ctrl+C again to exit')
      return
    }
    if (key.ctrl && input === 'o') {
      if (pendingRef.current > 0) return
      if (pageOpen) {
        if (pageRef.current.page?.kind === 'transcript') pageRef.current.close()
        else openTranscript()
      } else openTranscript()
      return
    }
    if (pageOpen) return // the page handles its own keys
    if (key.ctrl && input === 't') {
      setTodosCollapsed((c) => !c)
      return
    }
    if (key.ctrl && input === 'l') {
      stdout.write(CLEAR_SCREEN)
      dispatch({ type: 'redraw' })
      return
    }
    if (key.tab && key.shift) {
      // a prompt or a picker is open: only it may react to keys
      if (overlay) return
      setMode(controller.permissions.cycleMode())
      return
    }
    if (!overlay) {
      const items = footerItemsRef.current
      const sel = footerSelRef.current
      // Down at the prompt's last row enters the footer rows (PromptInput onFooterFocus)
      if (sel !== null) {
        const item = items[sel]
        if (key.escape) setFooterSel(null)
        else if (key.rightArrow || key.downArrow || (key.ctrl && input === 'n')) {
          setFooterSel(Math.min(items.length - 1, sel + 1))
        } else if (key.leftArrow) setFooterSel(Math.max(0, sel - 1))
        else if (key.upArrow || (key.ctrl && input === 'p')) setFooterSel(sel > 0 ? sel - 1 : null)
        else if (key.return && item) {
          openPage(
            item.kind === 'agent'
              ? { kind: 'agent', target: agentTargetOfTask(item) }
              : { kind: 'tasks', taskId: item.id },
          )
        } else if (input === 'x' && item) void controller.stopTask(item.id).catch(() => {})
        if (!isModelKey(input, key.meta) && !isThinkingKey(input, key.meta)) return
      }
    }
    if (pendingRef.current === 0 && isModelKey(input, key.meta)) {
      setPicker('model')
      return
    }
    if (pendingRef.current === 0 && isThinkingKey(input, key.meta)) {
      setPicker('thinking')
      return
    }
    if (overlay) return
    if (key.escape && searchOpen.current) return
    if (key.escape && shellAbort.current) {
      shellAbort.current.abort()
      return
    }
    if (key.escape && stateRef.current.running) {
      controller.abort()
    }
  })

  const selectSession = useCallback(
    (id: string) => {
      setPicker(null)
      busy.current = true
      void (async () => {
        try {
          await controller.resume(id)
          const messages = await controller.messages()
          stdout.write(CLEAR_SCREEN)
          dispatch({ type: 'load', messages })
          dispatch({ type: 'system', text: `Resumed session ${id}.` })
          refreshStats()
        } catch (error) {
          dispatch({
            type: 'system',
            text: `Cannot resume ${id}: ${error instanceof Error ? error.message : String(error)}`,
            tone: 'error',
          })
        } finally {
          release()
        }
      })()
    },
    [controller, refreshStats, release, stdout],
  )

  const selectModel = useCallback(
    (id: string, opts?: { thinking?: ThinkingLevel; sessionOnly?: boolean }) => {
      setPicker(null)
      const persist = opts?.sessionOnly !== true
      controller.setModel(id, { persist })
      setModel(id)
      const level =
        opts?.thinking !== undefined && opts.thinking !== controller.thinking
          ? opts.thinking
          : undefined
      if (level !== undefined) {
        controller.setThinking(level, { persist })
        setThinking(level)
      }
      dispatch({
        type: 'system',
        text: `Model set to ${id}${level !== undefined ? ` (thinking ${level})` : ''}${persist ? '' : ' for this session'}.`,
      })
      refreshStats()
    },
    [controller, refreshStats],
  )

  const selectThinking = useCallback(
    (level: ThinkingLevel) => {
      setPicker(null)
      controller.setThinking(level)
      setThinking(level)
      dispatch({ type: 'system', text: `Thinking set to ${level}.` })
    },
    [controller],
  )

  const finishRewind = useCallback(
    (result: RewindResult) => {
      setPicker(null)
      busy.current = true
      void (async () => {
        try {
          if (result.sessionId) {
            const messages = await controller.messages()
            stdout.write(CLEAR_SCREEN)
            dispatch({ type: 'load', messages })
            setSessionLabel(controller.sessionName)
          }
          const n = result.restoredFiles.length
          dispatch({
            type: 'system',
            text: `Restored ${n} file${n === 1 ? '' : 's'}`,
          })
          if (result.prompt) setPrefill((p) => ({ id: p.id + 1, text: result.prompt }))
          refreshStats()
        } catch (error) {
          dispatch({
            type: 'system',
            text: `Rewind failed: ${error instanceof Error ? error.message : String(error)}`,
            tone: 'error',
          })
        } finally {
          release()
        }
      })()
    },
    [controller, refreshStats, release, stdout],
  )

  const selectOutputStyle = useCallback(
    (name: string) => {
      setPicker(null)
      void controller
        .updateSetting('outputStyle', name, 'local')
        .then(() => dispatch({ type: 'system', text: `Output style set to ${name}.` }))
        .catch((error: unknown) =>
          dispatch({
            type: 'system',
            text: `Cannot save: ${error instanceof Error ? error.message : String(error)}`,
            tone: 'error',
          }),
        )
    },
    [controller],
  )

  const configSaved = useCallback((key: string, value: unknown) => {
    if (key === 'theme') setTheme(value as 'dark' | 'light' | 'auto')
    else if (key === 'editorMode') setEditorMode(value === 'vim' ? 'vim' : 'normal')
  }, [])

  const openRun = useCallback(
    (run: {
      name: string
      description: string
      sessionId: string
      status: 'running' | 'done' | 'failed'
    }) => {
      pageRef.current.open({
        kind: 'agent',
        target: {
          sessionId: run.sessionId,
          name: run.name,
          agent: run.name,
          description: run.description,
          status: run.status,
        },
        parent: { kind: 'agents' },
      })
    },
    [],
  )

  const openAgentTask = useCallback((task: BackgroundTask) => {
    pageRef.current.open({
      kind: 'agent',
      target: agentTargetOfTask(task),
      parent: { kind: 'tasks', taskId: task.id },
    })
  }, [])

  // While a page is open nothing may be printed above it: hold the transcript where it was.
  // (entries added while the page is still `entering` print on the primary screen, which is fine)
  const frozen = pageHost.view.phase === 'open' || pageHost.view.phase === 'leaving'
  const held = useRef<ViewState>(state)
  if (!frozen) held.current = state
  const shown: ViewState = pageHost.active
    ? { ...(frozen ? held.current : state), live: null, running: false }
    : state

  const overlayOpen = pending.length > 0 || picker !== null || sideQuestion !== null
  const todos = latestTodos(state)
  const page = pageHost.view.phase === 'open' ? pageHost.view.page : null
  return (
    <Box flexDirection="column">
      <Transcript
        state={shown}
        config={{ ...controller.config, model }}
        focus={focus}
        extraReserve={
          (footerItems.length === 0
            ? 0
            : Math.min(footerItems.length, MAX_FOOTER_ROWS) +
              (footerItems.length > MAX_FOOTER_ROWS ? 1 : 0)) +
          (queue.length > 0 ? queue.length + 1 : 0)
        }
        welcome={{ provider: controller.provider, thinking, ...(version ? { version } : {}) }}
        {...(liveTokens(state.live) !== undefined ? { tokens: liveTokens(state.live) } : {})}
      />
      <Box flexDirection="column" display={pageHost.active ? 'none' : 'flex'}>
        {activity ? (
          <ThinkingIndicator startedAt={activity.startedAt} status={activity.status} hint="" />
        ) : null}
        {approvals.length > 0 ? (
          <PermissionPrompt broker={controller.broker} />
        ) : questions.length > 0 ? (
          <QuestionDialog broker={controller.broker} />
        ) : null}
        {hasOpenTodos(todos) && todos ? (
          <TodoPanel todos={todos} collapsed={todosCollapsed} />
        ) : null}
        {picker === 'session' ? (
          <SessionPicker
            load={() => controller.sessions()}
            onSelect={selectSession}
            onCancel={() => setPicker(null)}
          />
        ) : null}
        {picker === 'model' ? (
          <ModelPicker
            controller={controller}
            onSelect={selectModel}
            onCancel={() => setPicker(null)}
          />
        ) : null}
        {picker === 'thinking' ? (
          <ThinkingPicker
            controller={controller}
            onSelect={selectThinking}
            onCancel={() => setPicker(null)}
          />
        ) : null}
        {picker === 'rewind' ? (
          <RewindMenu
            controller={controller}
            onDone={finishRewind}
            onCancel={(reason) => {
              setPicker(null)
              if (reason) dispatch({ type: 'system', text: reason })
            }}
          />
        ) : null}
        {picker === 'outputStyle' ? (
          <OutputStylePicker
            controller={controller}
            onSelect={selectOutputStyle}
            onCancel={() => setPicker(null)}
          />
        ) : null}
        {sideQuestion !== null ? (
          <SideQuestion
            controller={controller}
            question={sideQuestion}
            onClose={() => setSideQuestion(null)}
          />
        ) : null}
        <QueuedMessages items={queue.map((q) => q.text)} />
        <PromptInput
          key={inputEpoch}
          disabled={
            pending.length > 0 ||
            picker !== null ||
            pageHost.active ||
            sideQuestion !== null ||
            footerSel !== null
          }
          {...(suggestion ? { placeholder: suggestion } : {})}
          prefill={prefill}
          editorMode={editorMode}
          agents={controller.agents().map((a) => a.name)}
          onVimMode={(m) => setVimLabel(vimModeLabel(m))}
          onHint={showHint}
          onCtrlDEmpty={ctrlDExit}
          onBackground={() => {
            // only a running turn can have foreground work to move; otherwise Ctrl+B is "cursor left"
            if (!stateRef.current.running) return false
            return controller
              .backgroundRunning()
              .then((ids) => {
                if (ids.length === 0) return false
                showHint(`moved to background · ${ids.join(', ')}`)
                return true
              })
              .catch(() => false)
          }}
          onExternalEditor={(running) => {
            editorRunning.current = running
          }}
          onSaveDraft={(text) => void controller.addHistory(text).catch(() => {})}
          onRewindMenu={() => {
            if (pendingRef.current === 0 && !busy.current) setPicker('rewind')
          }}
          listFiles={listFiles}
          history={promptHistory}
          commands={customCommands}
          queuedCount={queue.length}
          onRecallQueue={recallQueue}
          loadSearchPool={loadSearchPool}
          onSearchChange={(open) => {
            searchOpen.current = open
          }}
          onSubmit={submit}
          onFooterFocus={() => {
            if (footerItemsRef.current.length > 0 && !searchOpen.current) setFooterSel(0)
          }}
          onSubmitDetailed={({ text, files }) => submit(text, files)}
          onShortcuts={() => setShortcutsOpen((open) => !open)}
          onTextChange={(text) => {
            if (text !== '') setShortcutsOpen(false)
            inputEmptyRef.current = text === ''
            setInputEmpty(text === '')
            if (text !== '') setSuggestion(undefined)
          }}
        />
        <SuggestionKeys
          suggestion={suggestion}
          enabled={inputEmpty && !overlayOpen && !pageHost.active}
          onAccept={(text) => {
            setSuggestion(undefined)
            setPrefill((p) => ({ id: p.id + 1, text }))
          }}
        />
        {shortcutsOpen ? <ShortcutsPanel /> : null}
        <Footer
          mode={mode}
          model={shortModel(model)}
          thinking={thinking}
          {...(stats.leftPct !== undefined ? { contextLeftPct: stats.leftPct } : {})}
          {...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {})}
          hint={hint ?? (queue.length > 0 ? `${queue.length} queued · ↑ to edit` : null)}
          shortcutsOpen={shortcutsOpen}
          inputEmpty={inputEmpty}
          busy={state.running}
          autoPaused={autoPaused}
          {...(editorMode === 'vim' && vimLabel ? { vimMode: vimLabel } : {})}
          {...(statusLine ? { statusLine } : {})}
          {...(sessionLabel ? { sessionName: sessionLabel } : {})}
        />
        <FooterTasks tasks={footerItems} selected={footerSel} />
      </Box>
      {page ? (
        <PageRoute
          page={page}
          controller={controller}
          runs={state.subagents}
          onClose={pageHost.close}
          onOpenRun={openRun}
          onOpenAgent={openAgentTask}
          onConfigSaved={configSaved}
        />
      ) : null}
    </Box>
  )
}

function PageRoute({
  page,
  controller,
  runs,
  onClose,
  onOpenRun,
  onOpenAgent,
  onConfigSaved,
}: {
  page: PageSpec
  controller: CoderController
  runs: ViewState['subagents']
  onClose(): void
  onOpenRun(run: ViewState['subagents'][number]): void
  onOpenAgent(task: BackgroundTask): void
  onConfigSaved(key: string, value: unknown): void
}): ReactElement {
  switch (page.kind) {
    case 'config':
      return <ConfigPage controller={controller} onClose={onClose} onSaved={onConfigSaved} />
    case 'agent':
      return <AgentPage controller={controller} target={page.target} onClose={onClose} />
    case 'tasks':
      return (
        <TasksPage
          controller={controller}
          onClose={onClose}
          onOpenAgent={onOpenAgent}
          {...(page.taskId ? { initialTaskId: page.taskId } : {})}
        />
      )
    case 'doctor':
      return <DoctorPage controller={controller} onClose={onClose} />
    case 'memory':
      return <MemoryPage controller={controller} onClose={onClose} />
    case 'context':
      return <ContextPage controller={controller} onClose={onClose} />
    case 'status':
      return <StatusPage controller={controller} onClose={onClose} />
    case 'cost':
      return <CostPage controller={controller} onClose={onClose} />
    case 'diff':
      return <DiffPage controller={controller} onClose={onClose} />
    case 'help':
      return <HelpPage onClose={onClose} />
    case 'agents':
      return (
        <AgentsPage
          agents={controller.agents()}
          runs={runs}
          onOpenRun={onOpenRun}
          onClose={onClose}
        />
      )
    case 'permissions':
      return <PermissionsPage engine={controller.permissions} onClose={onClose} />
    case 'transcript':
      return (
        <TranscriptPage
          title={page.title}
          {...(page.subtitle ? { subtitle: page.subtitle } : {})}
          entries={page.entries}
          onClose={onClose}
        />
      )
  }
}
