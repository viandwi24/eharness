import { Box, useApp, useInput, useStdout } from 'ink'
import { type ReactElement, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CoderController, PermissionMode } from '../contracts.ts'
import { runTurn } from './driver.ts'
import { PermissionPrompt, usePending } from './PermissionPrompt.tsx'
import { PromptInput } from './PromptInput.tsx'
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
}

const EXIT_WINDOW_MS = 2000
const HINT_MS = 3000
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H'

/** The interactive coding agent UI. */
export function App({ controller, initialPrompt }: AppProps): ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [state, dispatch] = useReducer(reduce, undefined, initialState)
  const [mode, setMode] = useState<PermissionMode>(controller.permissions.mode)
  const [model, setModel] = useState(controller.config.model)
  const [statsVersion, setStatsVersion] = useState(0)
  const [hint, setHint] = useState<string | null>(null)
  const pending = usePending(controller.broker)
  const stateRef = useRef(state)
  stateRef.current = state
  const modelRef = useRef(model)
  modelRef.current = model
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
      void runTurn(controller, text, dispatch).finally(() => {
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
      setMode(controller.permissions.cycleMode())
      return
    }
    if (key.escape && stateRef.current.running && controller.broker.pending().length === 0) {
      controller.abort()
    }
  })

  const todos = latestTodos(state)
  return (
    <Box flexDirection="column">
      <Transcript state={state} config={{ ...controller.config, model }} />
      {pending.length > 0 ? <PermissionPrompt broker={controller.broker} /> : null}
      {hasOpenTodos(todos) && todos ? <TodoPanel todos={todos} /> : null}
      <PromptInput
        disabled={pending.length > 0}
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
