/**
 * View model of the terminal UI: a pure reducer (no Ink, no React imports) so it can be unit
 * tested. {@link driver.ts} feeds it from a controller run.
 */
import type { SubagentRunData } from 'eharness/subagent'
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
  /** The assistant message of the running turn (all parts, committed ones included). */
  live: CoderMessage | null
  /**
   * How many leading parts of `live` were already committed to `entries` (progressive commit,
   * see {@link committableCount}). The live region renders `live.parts.slice(committed)` only.
   */
  committed: number
  /** Focus view is on: nothing is committed early (text is shown only for the final part). */
  focus: boolean
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
  /** Event messages that woke an idle session: shown before the woken turn's reply. */
  | { type: 'events'; messages: CoderMessage[] }
  | { type: 'toggle-expand' }
  /** Focus view on/off: it disables the progressive commit. */
  | { type: 'set-focus'; focus: boolean }
  /** Re-print the whole transcript (after the screen was cleared by Ctrl+L). */
  | { type: 'redraw' }

const BASH_TAIL_CHARS = 16_000
const HISTORY_MAX = 200

/** Initial state: the header splash only. */
export function initialState(): ViewState {
  return {
    entries: [{ kind: 'header', id: 'header' }],
    live: null,
    committed: 0,
    focus: false,
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

/** `description` of the `agent` tool call with this id, from its input. */
function agentDescription(message: CoderMessage, toolCallId: string): string {
  for (const part of message.parts) {
    const view = toolView(part)
    if (view?.toolCallId === toolCallId) {
      const description = (view.input as { description?: unknown } | undefined)?.description
      return typeof description === 'string' ? description : ''
    }
  }
  return ''
}

/**
 * Record the subagent runs of a message snapshot; returns the same array when nothing changed.
 * Runs come from the progress outputs of the live `agent` tool call and from the persisted
 * `data-subagent.run` parts, which also exist in stored messages (after `/resume`).
 */
function withSubagents(runs: SubagentRun[], message: CoderMessage): SubagentRun[] {
  let next = runs
  for (const part of message.parts) {
    if ((part.type as string) !== 'data-subagent.run') continue
    const data = (part as unknown as { data?: SubagentRunData }).data
    if (data === undefined || next.some((r) => r.toolCallId === data.toolCallId)) continue
    if (next === runs) next = [...runs]
    next.push({
      toolCallId: data.toolCallId,
      name: data.agent,
      description: agentDescription(message, data.toolCallId),
      sessionId: data.sessionId,
      status: data.status === 'waiting' ? 'running' : data.status,
    })
  }
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

const TERMINAL_TOOL_STATES = new Set(['output-available', 'output-error', 'output-denied'])

/**
 * Progressive commit rule: how many leading parts of `message` are final and can move from the
 * live region into `<Static>` (which prints an entry exactly once, so a committed part must never
 * change again). Parts are committed strictly in order and the scan stops at the first part that
 * may still change, so stored order = rendered order:
 *
 * - `text` and `reasoning`: only when no longer `streaming`; text additionally only when a later
 *   part follows it (the trailing text stays live until the turn ends);
 * - tool parts: only in a terminal state (`output-available` / `output-error` / `output-denied`)
 *   and not a preliminary output (a subagent whose progress is still updating);
 * - `step-start` and every other part (data parts, files, sources): only when a later part follows.
 *   The AI SDK reconciles data parts in place by id, but no committed data part is rendered
 *   (only `data-eh.input` is, and that one is never rewritten), so a stale copy cannot show.
 *
 * Indices are stable because chunks only ever append parts (a `respond()` continuation is seeded
 * with the same message). `structuredClone` of the slice protects the entry from later mutation.
 */
export function committableCount(message: CoderMessage, from: number): number {
  const parts = message.parts
  let n = from
  while (n < parts.length) {
    const part = parts[n]
    if (part === undefined) break
    const hasLater = n < parts.length - 1
    let ok: boolean
    if (part.type === 'text') {
      ok = (part as { state?: string }).state !== 'streaming' && hasLater
    } else if (part.type === 'reasoning') {
      ok = (part as { state?: string }).state !== 'streaming'
    } else {
      const view = toolView(part)
      if (view) ok = TERMINAL_TOOL_STATES.has(view.state) && !view.preliminary
      else ok = hasLater
    }
    if (!ok) break
    n++
  }
  return n
}

/** The entry holding `message.parts[from..to)` (a slice of the live message). */
function chunkEntry(message: CoderMessage, from: number, to: number): Entry {
  return {
    kind: 'message',
    id: from === 0 ? `m:${message.id}` : `m:${message.id}:${from}`,
    message: { ...message, parts: structuredClone(message.parts.slice(from, to)) },
  }
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
      return { ...state, running: true, live: null, committed: 0, startedAt: action.now }
    case 'live': {
      const timing = withTiming(state.timing, action.message, action.now)
      const subagents = withSubagents(state.subagents, action.message)
      let entries = state.entries
      let committed = state.committed
      // a different message replaces the live one: print what the old one still had
      if (state.live && state.live.id !== action.message.id) {
        if (state.live.parts.length > committed) {
          entries = [...entries, chunkEntry(state.live, committed, state.live.parts.length)]
        }
        committed = 0
      }
      if (!state.focus) {
        const to = committableCount(action.message, committed)
        if (to > committed) {
          if (entries === state.entries) entries = [...entries]
          entries.push(chunkEntry(action.message, committed, to))
          committed = to
        }
      }
      return { ...state, live: action.message, committed, entries, timing, subagents }
    }
    case 'set-focus':
      return { ...state, focus: action.focus }
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
      if (state.live && state.live.parts.length > state.committed) {
        entries.push(
          state.committed === 0
            ? { kind: 'message', id: `m:${state.live.id}`, message: state.live }
            : chunkEntry(state.live, state.committed, state.live.parts.length),
        )
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
        committed: 0,
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
        focus: state.focus,
        epoch: state.epoch + 1,
        seq,
      }
    case 'load': {
      const fresh = initialState()
      // a run still "running" in a stored conversation was interrupted
      const subagents = action.messages
        .reduce(withSubagents, fresh.subagents)
        .map((r): SubagentRun => (r.status === 'running' ? { ...r, status: 'failed' } : r))
      return {
        ...fresh,
        subagents,
        history: state.history,
        expanded: state.expanded,
        focus: state.focus,
        epoch: state.epoch + 1,
        seq,
        entries: [
          ...fresh.entries,
          ...withoutInlineEvents(action.messages)
            .filter((m) => m.parts.length > 0)
            .map((message): Entry => ({ kind: 'message', id: `m:${message.id}`, message })),
        ],
      }
    }
    case 'events':
      return {
        ...state,
        seq,
        entries: [
          ...state.entries,
          ...action.messages.map(
            (message): Entry => ({
              kind: 'message',
              id: `m:${message.id}`,
              message,
            }),
          ),
        ],
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

/** The text a stored `eh.event` kind message carries, if it is one. */
function eventText(message: CoderMessage): string | undefined {
  if (message.metadata?.eharness?.kind !== 'eh.event') return undefined
  const part = message.parts.find((p) => p.type === 'data-eh.event') as
    | { data?: { text?: unknown } }
    | undefined
  return typeof part?.data?.text === 'string' ? part.data.text : undefined
}

/**
 * Drop the `eh.event` messages a running turn already took inline: the assistant message shows
 * them as a `data-eh.input` part, the stored kind message would show them a second time.
 */
export function withoutInlineEvents(messages: CoderMessage[]): CoderMessage[] {
  const inputs: string[] = []
  for (const m of messages) {
    for (const part of m.parts) {
      if ((part.type as string) !== 'data-eh.input') continue
      const text = (part as unknown as { data?: { text?: unknown } }).data?.text
      if (typeof text === 'string') inputs.push(text)
    }
  }
  return messages.filter((m) => {
    const text = eventText(m)
    return text === undefined || !inputs.some((i) => i.includes(text))
  })
}

/**
 * The events that woke an idle session: `eh.event` messages stored after the last conversation
 * message that no turn took inline. Called when a woken turn starts.
 */
export function wakeEvents(messages: CoderMessage[]): CoderMessage[] {
  const kept = withoutInlineEvents(messages)
  let from = kept.length
  while (from > 0 && kept[from - 1]?.metadata?.eharness?.kind === 'eh.event') from--
  // only reports from other agents; a background task's exit has its own notice
  return kept.slice(from).filter((m) => {
    const part = m.parts.find((p) => p.type === 'data-eh.event') as
      | { data?: { name?: unknown } }
      | undefined
    return part?.data?.name === 'subagent' || part?.data?.name === 'agent-message'
  })
}
