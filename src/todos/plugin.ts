/**
 * The `todos()` plugin (spec 13): a `todo_write` checklist tool, the `data-todos.list` part,
 * cache-friendly reminders and an optional, progress-bounded "keep going while todos are open".
 *
 * Built only with the public core API (ADR-0008). The list lives in the conversation itself (the
 * last successful `todo_write` call on the current branch), so regenerate, edit and rewind are
 * correct by construction; plugin state only carries the list across a compaction.
 *
 * @see docs/specs/13-todos-plugin.md
 */
import { type FlexibleSchema, type JSONValue, type ModelMessage, tool } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartDef,
  definePlugin,
  type HarnessPlugin,
  type SessionContribution,
} from '../index.ts'

/** Status of one todo. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** One todo item. */
export interface Todo {
  /** Imperative form: "Run the tests". */
  content: string
  status: TodoStatus
  /** Present continuous for spinners: "Running the tests". */
  activeForm?: string
}

/** Data of the `data-todos.list` part (the whole list after a `todo_write`). */
export interface TodoListData {
  todos: Todo[]
}

/** Options of {@link todos}. */
export interface TodosOptions {
  /**
   * Keep the turn going while todos are open (`turn.beforeEnd`). Bounded by `maxNudges`, by the
   * list changing between nudges and by the core's progress rule (`loop.maxIdleContinues`).
   * Default `false`.
   */
  enforce?: boolean
  /** Default 3 — continuations the plugin asks for per turn. */
  maxNudges?: number
  /** Default 5 — model steps without a `todo_write` before open todos are reminded. 0 = never. */
  remindEvery?: number
  /** Default 50 — maximum items in the list. */
  maxItems?: number
}

/** Name of the tool. */
export const TODO_TOOL = 'todo_write'

/** Static instruction of the plugin (model-visible; changing it is a minor change). */
export const TODOS_INSTRUCTION: string = `Use the ${TODO_TOOL} tool to plan and track multi-step work: write the full list once you know the steps, keep exactly one item in_progress while you work on it, mark items completed as soon as they are done, and mark items cancelled (never silently drop them) when they are no longer needed. Skip it for simple one-step requests.`

/** Step reminder with the open list (`{list}`). */
export const TODOS_REMINDER: string = `Open todos (update them with ${TODO_TOOL} as you work):\n{list}`

/** `turn.beforeEnd` continuation reason (`{list}`). */
export const TODOS_CONTINUE: string = `You stopped with open todos:\n{list}\nContinue with the next one. If an item is blocked or no longer needed, mark it cancelled with ${TODO_TOOL} and say why; if you need the user, ask.`

const todoSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  activeForm: z.string().min(1).optional(),
})

const listPart: DataPartDef<FlexibleSchema<TodoListData>> = {
  schema: z.object({ todos: z.array(todoSchema) }) as FlexibleSchema<TodoListData>,
  model: 'omit',
}

/** Data parts of the plugin: `data-todos.list`. */
export type TodosDataParts = { list: typeof listPart }

const MARK: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[-]',
}

/** Compact text rendering: one `[x]` / `[>]` / `[ ]` / `[-]` line per todo. */
export function renderTodos(list: readonly Todo[]): string {
  return list.map((t) => `${MARK[t.status]} ${t.content}`).join('\n')
}

/** Todos that still need work (`pending` or `in_progress`). */
export function openTodos(list: readonly Todo[]): Todo[] {
  return list.filter((t) => t.status === 'pending' || t.status === 'in_progress')
}

function parseList(value: unknown): Todo[] | undefined {
  const parsed = z.object({ todos: z.array(todoSchema) }).safeParse(value)
  return parsed.success ? (parsed.data.todos as Todo[]) : undefined
}

/**
 * The latest list of a UI message history (for UIs): the last `data-todos.list` part. `[]` when
 * there is none.
 */
export function latestTodos(
  messages: ReadonlyArray<{ parts: ReadonlyArray<{ type: string; data?: unknown }> }>,
): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type === 'data-todos.list') return parseList(part.data) ?? []
    }
  }
  return []
}

/** The list of the last successful `todo_write` in a model wire, and the assistant messages since. */
function fromWire(wire: readonly ModelMessage[]): { list: Todo[]; stepsSince: number } | undefined {
  const failed = new Set<string>()
  let stepsSince = 0
  for (let i = wire.length - 1; i >= 0; i--) {
    const message = wire[i]
    if (message === undefined || typeof message.content === 'string') {
      if (message?.role === 'assistant') stepsSince++
      continue
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result' || part.toolName !== TODO_TOOL) continue
        const output = part.output as { type?: string; value?: unknown }
        const text = typeof output.value === 'string' ? output.value : ''
        if (
          output.type === 'error-text' ||
          output.type === 'error-json' ||
          text.startsWith('ERROR:')
        ) {
          failed.add(part.toolCallId)
        }
      }
      continue
    }
    if (message.role !== 'assistant') continue
    const calls = message.content.filter(
      (p) => p.type === 'tool-call' && p.toolName === TODO_TOOL && !failed.has(p.toolCallId),
    )
    const last = calls.at(-1)
    if (last !== undefined && last.type === 'tool-call') {
      const list = parseList(last.input)
      if (list !== undefined) return { list, stepsSince }
    }
    stepsSince++
  }
  return undefined
}

/**
 * The todos plugin.
 *
 * @example
 * ```ts
 * // todos comes from the 'eharness/todos' entry point
 * defineHarnessAgent({ model, plugins: [todos({ enforce: true })] })
 * ```
 */
export function todos(options: TodosOptions = {}): HarnessPlugin<'todos', TodosDataParts> {
  const maxNudges = Math.max(0, options.maxNudges ?? 3)
  const remindEvery = Math.max(0, options.remindEvery ?? 5)
  const maxItems = Math.max(1, options.maxItems ?? 50)

  return definePlugin({
    name: 'todos',
    dataParts: { list: listPart },
    setup: () => ({ instructions: TODOS_INSTRUCTION }),
    session(ctx): SessionContribution<TodosDataParts> {
      /** The list as of the last step boundary (current branch). */
      let current: Todo[] = []
      /** Remind the carried list once after a compaction removed the last todo_write. */
      let remindCarried = false
      let nudges = 0
      let fingerprintAtNudge: string | undefined

      const fingerprint = (list: readonly Todo[]) =>
        JSON.stringify(list.map((t) => [t.content, t.status]))

      return {
        tools: {
          [TODO_TOOL]: tool({
            description:
              'Replace the todo list with the given items (the whole list, in order). Statuses: pending, in_progress (at most one), completed, cancelled.',
            inputSchema: z.object({ todos: z.array(todoSchema).max(maxItems) }),
            execute: async ({ todos: list }) => {
              const active = list.filter((t) => t.status === 'in_progress').length
              if (active > 1) {
                return `ERROR: only one todo may be in_progress at a time; you marked ${active}. Send the list again.`
              }
              current = list as Todo[]
              if (ctx.stream.active) ctx.stream.data('list', { todos: current }, { id: 'list' })
              const open = openTodos(current).length
              const done = current.filter((t) => t.status === 'completed').length
              return `Todo list updated: ${open} open, ${done} completed.\n${renderTodos(current)}`
            },
          }),
        },
        hooks: {
          'turn.start': () => {
            nudges = 0
            fingerprintAtNudge = undefined
          },
          'step.prepare': (_ctx, e) => {
            const found = fromWire(e.messages)
            if (found !== undefined) {
              current = found.list
              remindCarried = false
            } else {
              current = (ctx.state.get<JSONValue>('carried') as Todo[] | undefined) ?? []
            }
            const open = openTodos(current)
            if (open.length === 0) return undefined
            const due =
              remindCarried ||
              (remindEvery > 0 && found !== undefined && found.stepsSince >= remindEvery)
            remindCarried = false
            return due
              ? { reminder: TODOS_REMINDER.replace('{list}', renderTodos(current)) }
              : undefined
          },
          'turn.beforeEnd': (_ctx, e) => {
            if (options.enforce !== true || e.stop !== 'complete') return undefined
            if (openTodos(current).length === 0 || nudges >= maxNudges) return undefined
            const print = fingerprint(current)
            // a nudge that changed nothing (no todo moved, no new tool results) ends the pushing
            if (fingerprintAtNudge === print && e.idleContinues > 0) return undefined
            nudges++
            fingerprintAtNudge = print
            return { continue: { reason: TODOS_CONTINUE.replace('{list}', renderTodos(current)) } }
          },
          'compaction.prompt': (_ctx, out) => {
            if (current.length > 0) {
              out.context.push(
                `Current todo list (keep open items in the summary):\n${renderTodos(current)}`,
              )
            }
          },
          'compaction.after': () => {
            ctx.state.set('carried', current as unknown as JSONValue)
            remindCarried = openTodos(current).length > 0
          },
        },
      }
    },
  })
}
