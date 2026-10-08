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
import type { CoderController, CoderMessage, PermissionMode, ThinkingLevel } from '../contracts.ts'
import { runTurn } from './driver.ts'
import { Footer, ShortcutsPanel } from './Footer.tsx'
import { createFileLister } from './mentions.ts'
import { PermissionPrompt, usePending } from './PermissionPrompt.tsx'
import { PromptInput } from './PromptInput.tsx'
import { AgentsPage } from './pages/AgentsPage.tsx'
import { ContextPage } from './pages/ContextPage.tsx'
import { CostPage } from './pages/CostPage.tsx'
import { shortModel } from './pages/format.ts'
import { HelpPage } from './pages/HelpPage.tsx'
import { usePageHost } from './pages/host.ts'
import { PermissionsPage } from './pages/PermissionsPage.tsx'
import { StatusPage } from './pages/StatusPage.tsx'
import type { PageSpec } from './pages/spec.ts'
import { TranscriptPage } from './pages/TranscriptPage.tsx'
import { ModelPicker } from './pickers/ModelPicker.tsx'
import { ThinkingPicker } from './pickers/ThinkingPicker.tsx'
import { QuestionDialog, usePendingQuestions } from './QuestionDialog.tsx'
import { SessionPicker } from './SessionPicker.tsx'
import { parseSlash, runSlash } from './slash.ts'
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

/** Props of {@link App}. */
export interface AppProps {
  controller: CoderController
  /** Sent as the first prompt once the UI is up. */
  initialPrompt?: string
  /** Stored messages of an already existing session (`--continue`, `--resume <id>`). */
  initialMessages?: CoderMessage[]
  /** coder version for the welcome box. */
  version?: string
}

interface ShellRun {
  command: string
  output: string
  exitCode: number | null
}

/** The inline dialog below the prompt, if any. */
type Picker = 'session' | 'model' | 'thinking' | null

const EXIT_WINDOW_MS = 2000
const HINT_MS = 3000
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

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
}: AppProps): ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
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
  const [inputEpoch, setInputEpoch] = useState(0)
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
  const busy = useRef(false)
  const lastCtrlC = useRef(0)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showHint = useCallback((text: string) => {
    setHint(text)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])

  useEffect(() => controller.permissions.subscribe(setMode), [controller])
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
    return () => {
      cancelled = true
    }
  }, [controller, statsVersion])

  // a permission question must be seen: leave any open page for it
  const { close: closePage } = pageHost
  const pagePhase = pageHost.view.phase
  useEffect(() => {
    if (pending.length > 0 && pagePhase === 'open') closePage()
  }, [pending.length, pagePhase, closePage])

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
    if (current.live && current.live.parts.length > 0) {
      entries.push({ kind: 'message', id: `live:${current.live.id}`, message: current.live })
    }
    openPage({ kind: 'transcript', title: 'Transcript', entries })
  }, [openPage])

  const startTurn = useCallback(
    (text: string) => {
      busy.current = true
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
      void runTurn(controller, context + text, dispatch).finally(() => {
        busy.current = false
        refreshStats()
      })
    },
    [controller, refreshStats],
  )

  const submit = useCallback(
    (text: string) => {
      setShortcutsOpen(false)
      if (busy.current) {
        showHint('A turn is running. Press esc to interrupt it.')
        return
      }
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
            busy.current = false
          })
        return
      }
      dispatch({ type: 'user-submitted', text })
      if (!parseSlash(text)) {
        startTurn(text)
        return
      }
      busy.current = true
      void runSlash(text, {
        controller,
        model: modelRef.current,
        print: (line, tone) => dispatch({ type: 'system', text: line, tone }),
        reset: () => {
          stdout.write(CLEAR_SCREEN)
          dispatch({ type: 'reset' })
        },
        load: (messages) => {
          stdout.write(CLEAR_SCREEN)
          dispatch({ type: 'load', messages })
        },
        showTranscript: (title, messages) =>
          openPage({ kind: 'transcript', title, entries: messageEntries(messages) }),
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
        setModelLabel: setModel,
        refreshStats,
        exit,
      }).finally(() => {
        if (!stateRef.current.running) busy.current = false
      })
    },
    [controller, exit, openPage, refreshStats, showHint, startTurn, stdout],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (initialPrompt?.trim()) submit(initialPrompt.trim())
  }, [])

  useInput((input, key) => {
    const overlay = pendingRef.current > 0 || pickerRef.current !== null
    const pageOpen = pageRef.current.active
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastCtrlC.current <= EXIT_WINDOW_MS) {
        if (stateRef.current.running) controller.abort()
        shellAbort.current?.abort()
        exit()
        return
      }
      lastCtrlC.current = now
      // the first press clears whatever is typed (a fresh prompt editor)
      setInputEpoch((n) => n + 1)
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
    if (pendingRef.current === 0 && isModelKey(input, key.meta)) {
      setPicker('model')
      return
    }
    if (pendingRef.current === 0 && isThinkingKey(input, key.meta)) {
      setPicker('thinking')
      return
    }
    if (overlay) return
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
          busy.current = false
        }
      })()
    },
    [controller, refreshStats, stdout],
  )

  const selectModel = useCallback(
    (id: string) => {
      setPicker(null)
      controller.setModel(id)
      setModel(id)
      dispatch({ type: 'system', text: `Model set to ${id}.` })
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

  const openRun = useCallback(
    (run: { name: string; description: string; sessionId: string }) => {
      void controller
        .messagesOf(run.sessionId)
        .then((messages) =>
          pageRef.current.open({
            kind: 'transcript',
            title: run.name,
            subtitle: run.description,
            entries: messageEntries(messages),
            parent: { kind: 'agents' },
          }),
        )
        .catch((error: unknown) =>
          showHint(`Cannot open run: ${error instanceof Error ? error.message : String(error)}`),
        )
    },
    [controller, showHint],
  )

  // While a page is open nothing may be printed above it: hold the transcript where it was.
  // (entries added while the page is still `entering` print on the primary screen, which is fine)
  const frozen = pageHost.view.phase === 'open' || pageHost.view.phase === 'leaving'
  const held = useRef<ViewState>(state)
  if (!frozen) held.current = state
  const shown: ViewState = pageHost.active
    ? { ...(frozen ? held.current : state), live: null, running: false }
    : state

  const todos = latestTodos(state)
  const page = pageHost.view.phase === 'open' ? pageHost.view.page : null
  return (
    <Box flexDirection="column">
      <Transcript
        state={shown}
        config={{ ...controller.config, model }}
        welcome={{ provider: controller.provider, thinking, ...(version ? { version } : {}) }}
        {...(liveTokens(state.live) !== undefined ? { tokens: liveTokens(state.live) } : {})}
      />
      <Box flexDirection="column" display={pageHost.active ? 'none' : 'flex'}>
        {approvals.length > 0 ? (
          <PermissionPrompt broker={controller.broker} />
        ) : questions.length > 0 ? (
          <QuestionDialog broker={controller.broker} />
        ) : null}
        {hasOpenTodos(todos) && todos ? <TodoPanel todos={todos} /> : null}
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
        <PromptInput
          key={inputEpoch}
          disabled={pending.length > 0 || picker !== null || pageHost.active}
          listFiles={listFiles}
          running={state.running}
          history={state.history}
          onSubmit={submit}
          onBusy={() => showHint('A turn is running. Press esc to interrupt it.')}
          onShortcuts={() => setShortcutsOpen((open) => !open)}
          onTextChange={(text) => {
            if (text !== '') setShortcutsOpen(false)
          }}
        />
        {shortcutsOpen ? <ShortcutsPanel /> : null}
        <Footer
          mode={mode}
          model={shortModel(model)}
          thinking={thinking}
          {...(stats.leftPct !== undefined ? { contextLeftPct: stats.leftPct } : {})}
          {...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {})}
          hint={hint}
          shortcutsOpen={shortcutsOpen}
          busy={state.running}
        />
      </Box>
      {page ? (
        <PageRoute
          page={page}
          controller={controller}
          runs={state.subagents}
          onClose={pageHost.close}
          onOpenRun={openRun}
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
}: {
  page: PageSpec
  controller: CoderController
  runs: ViewState['subagents']
  onClose(): void
  onOpenRun(run: ViewState['subagents'][number]): void
}): ReactElement {
  switch (page.kind) {
    case 'context':
      return <ContextPage controller={controller} onClose={onClose} />
    case 'status':
      return <StatusPage controller={controller} onClose={onClose} />
    case 'cost':
      return <CostPage controller={controller} onClose={onClose} />
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
