/**
 * Writing a plugin: a `todos` plugin with a service, a tool, a persistent data part, hooks and
 * per-session state, plus a second plugin that uses its service.
 *
 *   bun examples/plugin-authoring.ts
 *
 * Everything here uses only the public API — the same API the shipped `filesystem()` plugin uses.
 */
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent, definePlugin, type HarnessPlugin } from 'eharness'
import { memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const todoItem = z.object({ text: z.string(), done: z.boolean() })
type TodoItem = z.infer<typeof todoItem>

/** The service other plugins can use (`requires: ['todos']` → `ctx.services.todos`). */
export interface TodoService {
  items(): TodoItem[]
  open(): number
}

// Declaration merging types `ctx.services.todos` for every plugin and tool.
declare module 'eharness' {
  interface HarnessServices {
    todos: TodoService
  }
}

const todoParts = {
  // Persistent (stored in the assistant message) → `data-todos.list`; the UI renders it after a
  // reload too. Written with a fixed id, so every update replaces the same part.
  list: defineDataPart({ schema: z.object({ items: z.array(todoItem) }) }),
}

/** A checklist the model maintains with `todo_write`; it may not stop while items are open. */
export function todos(): HarnessPlugin<'todos', typeof todoParts> {
  return definePlugin({
    name: 'todos',
    provides: ['todos'],
    dataParts: todoParts,
    // Agent phase: pure and synchronous. Static contributions keep the prompt prefix stable.
    setup: () => ({
      instructions: 'For work with several steps, keep a checklist with todo_write.',
    }),
    // Session phase: runs once per live session; I/O is allowed here.
    session(ctx) {
      // Plugin state is namespaced (`plugins.todos.items`) and saved with the session state.
      const items = (): TodoItem[] => ctx.state.get<TodoItem[]>('items') ?? []
      const open = () => items().filter((item) => !item.done).length

      return {
        services: { todos: { items, open } },
        tools: {
          todo_write: tool({
            description: 'Replace the whole todo list. Mark items done as you finish them.',
            inputSchema: z.object({ items: z.array(todoItem) }),
            execute: async ({ items: next }) => {
              ctx.state.set('items', next)
              ctx.stream.data('list', { items: next }, { id: 'todos' }) // typed by the schema
              return `Saved ${next.length} items (${open()} open).`
            },
          }),
        },
        hooks: {
          // Volatile context goes into a per-step reminder, never into the instructions.
          'step.prepare': () => (open() > 0 ? { reminder: `Open todos: ${open()}.` } : undefined),
          // Keep the agent going while items are open (bounded by loop.maxContinues).
          'turn.beforeEnd': (_ctx, e) =>
            e.stop === 'complete' && open() > 0
              ? { continue: { reason: `${open()} todos are still open. Finish them.` } }
              : undefined,
        },
      }
    },
  })
}

/** A plugin that depends on the `todos` service; it must come after `todos()` in `plugins`. */
export function todoLog(lines: string[]): HarnessPlugin<'todo-log'> {
  return definePlugin({
    name: 'todo-log',
    requires: ['todos'],
    setup: () => ({
      hooks: {
        'turn.end': (ctx, result) => {
          lines.push(`turn ${result.stop}: ${ctx.services.todos.open()} todos open`)
        },
      },
    }),
  })
}

if (import.meta.main) {
  const log: string[] = []
  const state = memoryState()
  const agent = defineHarnessAgent({
    model: exampleModel([
      {
        toolCalls: [
          {
            toolName: 'todo_write',
            input: {
              items: [
                { text: 'outline', done: false },
                { text: 'draft', done: false },
              ],
            },
          },
        ],
      },
      { text: 'I made a plan.' }, // would end the turn — turn.beforeEnd continues it
      {
        toolCalls: [
          {
            toolName: 'todo_write',
            input: {
              items: [
                { text: 'outline', done: true },
                { text: 'draft', done: true },
              ],
            },
          },
        ],
      },
      { text: 'Outline and draft are done.' },
    ]),
    contextWindow: 200_000,
    storage: { state },
    plugins: [todos(), todoLog(log)],
  })

  const session = agent.session('plugin-demo')
  const result = await session.send('Write a short article.').result
  const [, assistant] = await session.messages()
  console.log(`stop: ${result.stop}, steps: ${result.steps}`)
  for (const part of assistant?.parts ?? []) {
    if (part.type === 'text') console.log(`text: ${part.text}`)
    if (part.type === 'data-eh.input') console.log(`input (${part.data.source}): ${part.data.text}`)
    if (part.type === 'data-todos.list') {
      console.log(
        `todos part: ${part.data.items.map((i) => `${i.done ? '✓' : '·'} ${i.text}`).join(', ')}`,
      )
    }
  }
  console.log(`state: ${JSON.stringify((await state.get('plugin-demo'))?.plugins.todos)}`)
  console.log(log.join('\n'))
  await agent.close()
}
