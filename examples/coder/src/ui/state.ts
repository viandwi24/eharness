/**
 * View model of the terminal UI: a pure reducer (no Ink, no React imports) so it can be unit
 * tested. {@link driver.ts} feeds it from a controller run.
 */
import type { Todo, TodoListData } from 'eharness/todos'
import type { BashOutputData, CoderMessage } from '../contracts.ts'
import { toolView } from './tool-summary.ts'

/** One transcript line group. Finished entries are rendered once, in `<Static>`. */
export type Entry =
  | { kind: 'header'; id: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'message'; id: string; message: CoderMessage }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }

/** Wall-clock timing of a tool call, as observed by the UI. */
export interface ToolTiming {
  start: number
  end?: number
}

/** Everything the UI renders. */
export interface ViewState {
  entries: Entry[]
  /** The assistant message of the running turn. */
  live: CoderMessage | null
  running: boolean
  /** Live bash output per tool call id (tail only). */
  bash: Record<string, string>
  timing: Record<string, ToolTiming>
  /** Last prompts, oldest first. */
  history: string[]
  expanded: boolean
  /** Bumped when the transcript is replaced (`/clear`, `/resume`): remounts `<Static>`. */
  epoch: number
  seq: number
}

/** Actions of {@link reduce}. */
export type ViewAction =
  | { type: 'user-submitted'; text: string }
  | { type: 'turn-started' }
  | { type: 'live'; message: CoderMessage; now: number }
  | { type: 'bash-output'; chunks: BashOutputData[] }
  | { type: 'turn-finished'; note?: { text: string; tone: 'info' | 'error' } }
  | { type: 'system'; text: string; tone?: 'info' | 'error' }
  | { type: 'reset' }
  | { type: 'load'; messages: CoderMessage[] }
  | { type: 'toggle-expand' }

const BASH_TAIL_CHARS = 16_000
const HISTORY_MAX = 200

/** Initial state: the header splash only. */
export function initialState(): ViewState {
  return {
    entries: [{ kind: 'header', id: 'header' }],
    live: null,
    running: false,
    bash: {},
    timing: {},
    history: [],
    expanded: false,
    epoch: 0,
    seq: 0,
  }
}

function withTiming(
  timing: Record<string, ToolTiming>,
  message: CoderMessage,
  now: number,
): Record<string, ToolTiming> {
  let next = timing
  for (const part of message.parts) {
    const view = toolView(part)
    if (!view) continue
    const current = next[view.toolCallId]
    const finished =
      (view.state === 'output-available' && !view.preliminary) ||
      view.state === 'output-error' ||
      view.state === 'output-denied'
    if (!current) {
      if (next === timing) next = { ...timing }
      next[view.toolCallId] = finished ? { start: now, end: now } : { start: now }
    } else if (finished && current.end === undefined) {
      if (next === timing) next = { ...timing }
      next[view.toolCallId] = { ...current, end: now }
    }
  }
  return next
}

/** The pure reducer. */
export function reduce(state: ViewState, action: ViewAction): ViewState {
  const seq = state.seq + 1
  switch (action.type) {
    case 'user-submitted': {
      const history =
        state.history[state.history.length - 1] === action.text
          ? state.history
          : [...state.history, action.text].slice(-HISTORY_MAX)
      return {
        ...state,
        seq,
        history,
        entries: [...state.entries, { kind: 'user', id: `u${seq}`, text: action.text }],
      }
    }
    case 'turn-started':
      return { ...state, running: true, live: null }
    case 'live':
      return {
        ...state,
        live: action.message,
        timing: withTiming(state.timing, action.message, action.now),
      }
    case 'bash-output': {
      const bash = { ...state.bash }
      for (const chunk of action.chunks) {
        const next = (bash[chunk.toolCallId] ?? '') + chunk.chunk
        bash[chunk.toolCallId] = next.length > BASH_TAIL_CHARS ? next.slice(-BASH_TAIL_CHARS) : next
      }
      return { ...state, bash }
    }
    case 'turn-finished': {
      const entries = [...state.entries]
      if (state.live && state.live.parts.length > 0) {
        entries.push({ kind: 'message', id: `m:${state.live.id}`, message: state.live })
      }
      if (action.note) {
        entries.push({
          kind: 'system',
          id: `s${seq}`,
          text: action.note.text,
          tone: action.note.tone,
        })
      }
      return { ...state, seq, entries, live: null, running: false }
    }
    case 'system':
      return {
        ...state,
        seq,
        entries: [
          ...state.entries,
          { kind: 'system', id: `s${seq}`, text: action.text, tone: action.tone ?? 'info' },
        ],
      }
    case 'reset':
      return {
        ...initialState(),
        history: state.history,
        expanded: state.expanded,
        epoch: state.epoch + 1,
        seq,
      }
    case 'load': {
      const fresh = initialState()
      return {
        ...fresh,
        history: state.history,
        expanded: state.expanded,
        epoch: state.epoch + 1,
        seq,
        entries: [
          ...fresh.entries,
          ...action.messages
            .filter((m) => m.parts.length > 0)
            .map((message): Entry => ({ kind: 'message', id: `m:${message.id}`, message })),
        ],
      }
    }
    case 'toggle-expand':
      return { ...state, expanded: !state.expanded }
  }
}

/** The todo list of the most recent `data-todos.list` part (live message first), or null. */
export function latestTodos(state: ViewState): Todo[] | null {
  const messages: CoderMessage[] = []
  if (state.live) messages.push(state.live)
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i]
    if (entry?.kind === 'message') messages.push(entry.message)
  }
  for (const message of messages) {
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i]
      if ((part?.type as string | undefined) === 'data-todos.list') {
        const data = (part as unknown as { data: TodoListData }).data
        return Array.isArray(data?.todos) ? data.todos : null
      }
    }
  }
  return null
}

/** True while a todo is neither completed nor cancelled. */
export function hasOpenTodos(todos: Todo[] | null): boolean {
  return !!todos?.some((t) => t.status === 'pending' || t.status === 'in_progress')
}
