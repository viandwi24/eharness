/**
 * Writing a plugin: a `checklist` plugin with a service, a tool, a persistent data part, hooks and
 * per-session state, plus a second plugin that uses its service.
 *
 *   bun examples/plugin-authoring.ts
 *
 * Everything here uses only the public API — the same API the shipped `filesystem()` and `todos()`
 * plugins use. (For a ready-made checklist, use `todos()` from `eharness/todos`.)
 */
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent, definePlugin, type HarnessPlugin } from 'eharness'
import { memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const checklistItem = z.object({ text: z.string(), done: z.boolean() })
type ChecklistItem = z.infer<typeof checklistItem>

/** The service other plugins can use (`requires: ['checklist']` → `ctx.services.checklist`). */
export interface ChecklistService {
  items(): ChecklistItem[]
  open(): number
}

// Declaration merging types `ctx.services.checklist` for every plugin and tool.
declare module 'eharness' {
  interface HarnessServices {
    checklist: ChecklistService
  }
}

const checklistParts = {
  // Persistent (stored in the assistant message) → `data-checklist.list`; the UI renders it after a
  // reload too. Written with a fixed id, so every update replaces the same part.
  list: defineDataPart({ schema: z.object({ items: z.array(checklistItem) }) }),
}

/** A checklist the model maintains with `checklist_write`; it may not stop while items are open. */
export function checklist(): HarnessPlugin<'checklist', typeof checklistParts> {
  return definePlugin({
    name: 'checklist',
    provides: ['checklist'],
    dataParts: checklistParts,
    // Agent phase: pure and synchronous. Static contributions keep the prompt prefix stable.
    setup: () => ({
      instructions: 'For work with several steps, keep a checklist with checklist_write.',
    }),
    // Session phase: runs once per live session; I/O is allowed here.
    session(ctx) {
      // Plugin state is namespaced (`plugins.checklist.items`) and saved with the session state.
      const items = (): ChecklistItem[] => ctx.state.get<ChecklistItem[]>('items') ?? []
      const open = () => items().filter((item) => !item.done).length

      return {
        services: { checklist: { items, open } },
        tools: {
          checklist_write: tool({
            description: 'Replace the whole checklist. Mark items done as you finish them.',
            inputSchema: z.object({ items: z.array(checklistItem) }),
            execute: async ({ items: next }) => {
              ctx.state.set('items', next)
              ctx.stream.data('list', { items: next }, { id: 'checklist' }) // typed by the schema
              return `Saved ${next.length} items (${open()} open).`
            },
          }),
        },
        hooks: {
          // Volatile context goes into a per-step reminder, never into the instructions.
          'step.prepare': () => (open() > 0 ? { reminder: `Open items: ${open()}.` } : undefined),
          // Keep the agent going while items are open. The core bounds continuations by progress
          // (`loop.maxIdleContinues`, default 3) and optionally by `loop.maxContinues`.
          'turn.beforeEnd': (_ctx, e) =>
            e.stop === 'complete' && open() > 0
              ? { continue: { reason: `${open()} items are still open. Finish them.` } }
              : undefined,
        },
      }
    },
  })
}

/** A plugin that depends on the `checklist` service; it must come after `checklist()` in `plugins`. */
export function checklistLog(lines: string[]): HarnessPlugin<'checklist-log'> {
  return definePlugin({
    name: 'checklist-log',
    requires: ['checklist'],
    setup: () => ({
      hooks: {
        'turn.end': (ctx, result) => {
          lines.push(`turn ${result.stop}: ${ctx.services.checklist.open()} items open`)
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
            toolName: 'checklist_write',
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
            toolName: 'checklist_write',
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
    plugins: [checklist(), checklistLog(log)],
  })

  const session = agent.session('plugin-demo')
  const result = await session.send('Write a short article.').result
  const [, assistant] = await session.messages()
  console.log(`stop: ${result.stop}, steps: ${result.steps}`)
  for (const part of assistant?.parts ?? []) {
    if (part.type === 'text') console.log(`text: ${part.text}`)
    if (part.type === 'data-eh.input') console.log(`input (${part.data.source}): ${part.data.text}`)
    if (part.type === 'data-checklist.list') {
      console.log(
        `checklist part: ${part.data.items.map((i) => `${i.done ? '✓' : '·'} ${i.text}`).join(', ')}`,
      )
    }
  }
  console.log(`state: ${JSON.stringify((await state.get('plugin-demo'))?.plugins.checklist)}`)
  console.log(log.join('\n'))
  await agent.close()
}
