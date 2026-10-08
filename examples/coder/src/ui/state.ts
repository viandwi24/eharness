/**
 * View model of the terminal UI: a pure reducer (no Ink, no React imports) so it can be unit
 * tested. {@link driver.ts} feeds it from a controller run.
 */
import type { Todo, TodoListData } from 'eharness/todos'
import type { AgentProgress, BashOutputData, CoderMessage } from '../contracts.ts'
import { TOOL } from '../contracts.ts'
import { isAgentProgress, toolView } from './tool-summary.ts'

/** One transcript line group. Finished entries are rendered once, in `<Static>`. */
export type Entry =
  | { kind: 'header'; id: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'message'; id: string; message: CoderMessage }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'shell'; id: string; command: string; output: string; exitCode: number | null }
  | { kind: 'transcript'; id: string; title: string; messages: CoderMessage[] }

/** A subagent run seen in this session (from `AgentProgress` preliminary outputs). */
export interface SubagentRun {
  toolCallId: string
  name: string
  description: string
  sessionId: string
  status: AgentProgress['status']
}

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
  /** Epoch ms the running turn started at (for the elapsed time), when the driver reported it. */
  startedAt?: number
  /** Live bash output per tool call id (tail only). */
  bash: Record<string, string>
  timing: Record<string, ToolTiming>
  /** Subagent runs seen in this session, oldest first (`/agents <n>` opens one). */
  subagents: SubagentRun[]
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
  | { type: 'turn-started'; now?: number }
  | { type: 'live'; message: CoderMessage; now: number }
  | { type: 'bash-output'; chunks: BashOutputData[] }
  | { type: 'turn-finished'; note?: { text: string; tone: 'info' | 'error' } }
  | { type: 'system'; text: string; tone?: 'info' | 'warn' | 'error' }
  | { type: 'shell-result'; command: string; output: string; exitCode: number | null }
  | { type: 'transcript'; title: string; messages: CoderMessage[] }
  | { type: 'reset' }
  | { type: 'load'; messages: CoderMessage[] }
  | { type: 'toggle-expand' }
  /** Re-print the whole transcript (after the screen was cleared by Ctrl+L). */
  | { type: 'redraw' }

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
    subagents: [],
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

/** Record the subagent runs of a message snapshot; returns the same array when nothing changed. */
function withSubagents(runs: SubagentRun[], message: CoderMessage): SubagentRun[] {
  let next = runs
  for (const part of message.parts) {
    const view = toolView(part)
    if (!view || view.toolName !== TOOL.agent) continue
    const index = next.findIndex((r) => r.toolCallId === view.toolCallId)
    const known = index >= 0 ? next[index] : undefined
    let run: SubagentRun | undefined
    if (isAgentProgress(view.output)) {
      run = {
        toolCallId: view.toolCallId,
        name: view.output.agent,
        description: view.output.description,
        sessionId: view.output.sessionId,
        // a finished tool call with a progress record as output (non-preliminary) is done
        status: view.preliminary || view.state !== 'output-available' ? view.output.status : 'done',
      }
    } else if (known && view.state === 'output-available' && !view.preliminary) {
      run = { ...known, status: known.status === 'failed' ? 'failed' : 'done' }
    } else if (known && (view.state === 'output-error' || view.state === 'output-denied')) {
      run = { ...known, status: 'failed' }
    }
    if (!run || (known && JSON.stringify(known) === JSON.stringify(run))) continue
    if (next === runs) next = [...runs]
    if (index >= 0) next[index] = run
    else next.push(run)
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
      return { ...state, running: true, live: null, startedAt: action.now }
    case 'live':
      return {
        ...state,
        live: action.message,
        timing: withTiming(state.timing, action.message, action.now),
        subagents: withSubagents(state.subagents, action.message),
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
      // a run still "running" when the turn ends was interrupted
      const subagents = state.subagents.some((r) => r.status === 'running')
        ? state.subagents.map(
            (r): SubagentRun => (r.status === 'running' ? { ...r, status: 'failed' } : r),
          )
        : state.subagents
      return {
        ...state,
        seq,
        entries,
        subagents,
        live: null,
        running: false,
        startedAt: undefined,
      }
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
    case 'shell-result':
      return {
        ...state,
        seq,
        history: [...state.history, `!${action.command}`].slice(-HISTORY_MAX),
        entries: [
          ...state.entries,
          {
            kind: 'shell',
            id: `sh${seq}`,
            command: action.command,
            output: action.output,
            exitCode: action.exitCode,
          },
        ],
      }
    case 'transcript':
      return {
        ...state,
        seq,
        entries: [
          ...state.entries,
          { kind: 'transcript', id: `t${seq}`, title: action.title, messages: action.messages },
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
    case 'redraw':
      return { ...state, epoch: state.epoch + 1 }
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
