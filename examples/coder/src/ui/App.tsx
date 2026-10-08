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
import type { CoderController, CoderMessage, PermissionMode } from '../contracts.ts'
import { runTurn } from './driver.ts'
import { createFileLister } from './mentions.ts'
import { PermissionPrompt, usePending } from './PermissionPrompt.tsx'
import { PromptInput } from './PromptInput.tsx'
import { SessionPicker } from './SessionPicker.tsx'
import { StatusBar } from './StatusBar.tsx'
import { parseSlash, runSlash } from './slash.ts'
import { hasOpenTodos, initialState, latestTodos, reduce } from './state.ts'
import { TodoPanel } from './TodoPanel.tsx'
import { Transcript } from './Transcript.tsx'

/** Props of {@link App}. */
export interface AppProps {
  controller: CoderController
  /** Sent as the first prompt once the UI is up. */
  initialPrompt?: string
  /** Stored messages of an already existing session (`--continue`, `--resume <id>`). */
  initialMessages?: CoderMessage[]
}

interface ShellRun {
  command: string
  output: string
  exitCode: number | null
}

const EXIT_WINDOW_MS = 2000
const HINT_MS = 3000
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/** The one-line notice shown when project settings were ignored. */
export function untrustedNotice(keys: string[]): string {
  return `Project settings ignored until trusted: ${keys.join(', ')}. Restart and answer the trust question, or pass --trust-project.`
}

/** The interactive coding agent UI. */
export function App({ controller, initialPrompt, initialMessages }: AppProps): ReactElement {
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
  const [model, setModel] = useState(controller.config.model)
  const [statsVersion, setStatsVersion] = useState(0)
  const [hint, setHint] = useState<string | null>(null)
  const [picking, setPicking] = useState(controller.config.resume === true)
  const listFiles = useMemo(() => createFileLister(controller.workspace), [controller])
  const shellRuns = useRef<ShellRun[]>([])
  const shellAbort = useRef<AbortController | undefined>(undefined)
  const pending = usePending(controller.broker)
  const stateRef = useRef(state)
  stateRef.current = state
  const modelRef = useRef(model)
  modelRef.current = model
  const pickingRef = useRef(picking)
  pickingRef.current = picking
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
        showTranscript: (title, messages) => dispatch({ type: 'transcript', title, messages }),
        subagents: () => stateRef.current.subagents,
        pickSession: () => setPicking(true),
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
    [controller, exit, refreshStats, showHint, startTurn, stdout],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    if (initialPrompt?.trim()) submit(initialPrompt.trim())
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastCtrlC.current <= EXIT_WINDOW_MS) {
        if (stateRef.current.running) controller.abort()
        shellAbort.current?.abort()
        exit()
        return
      }
      lastCtrlC.current = now
      showHint('press Ctrl+C again to exit')
      return
    }
    if (key.ctrl && input === 'o') {
      dispatch({ type: 'toggle-expand' })
      return
    }
    if (key.tab && key.shift) {
      // a prompt or the picker is open: only it may react to keys
      if (controller.broker.pending().length > 0 || pickingRef.current) return
      setMode(controller.permissions.cycleMode())
      return
    }
    if (key.escape && shellAbort.current) {
      shellAbort.current.abort()
      return
    }
    if (key.escape && stateRef.current.running && controller.broker.pending().length === 0) {
      controller.abort()
    }
  })

  const selectSession = useCallback(
    (id: string) => {
      setPicking(false)
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

  const todos = latestTodos(state)
  return (
    <Box flexDirection="column">
      <Transcript state={state} config={{ ...controller.config, model }} />
      {pending.length > 0 ? <PermissionPrompt broker={controller.broker} /> : null}
      {hasOpenTodos(todos) && todos ? <TodoPanel todos={todos} /> : null}
      {picking ? (
        <SessionPicker
          load={() => controller.sessions()}
          onSelect={selectSession}
          onCancel={() => setPicking(false)}
        />
      ) : null}
      <PromptInput
        disabled={pending.length > 0 || picking}
        listFiles={listFiles}
        running={state.running}
        history={state.history}
        onSubmit={submit}
        onBusy={() => showHint('A turn is running. Press esc to interrupt it.')}
      />
      <StatusBar
        controller={controller}
        mode={mode}
        model={model}
        running={state.running}
        statsVersion={statsVersion}
        hint={hint}
      />
    </Box>
  )
}
