/**
 * The `todos()` plugin: the model plans with `todo_write`, the UI renders `data-todos.list`, and
 * `enforce: true` keeps the turn going while todos are still open (bounded by `maxNudges` and by
 * progress).
 *
 *   bun examples/todos.ts
 */
import { defineHarnessAgent } from 'eharness'
import { latestTodos, renderTodos, todos } from 'eharness/todos'
import { exampleModel } from './shared/model.ts'

type Status = 'pending' | 'in_progress' | 'completed' | 'cancelled'
const write = (...items: Array<[string, Status]>) => ({
  toolCalls: [
    {
      toolName: 'todo_write',
      input: { todos: items.map(([content, status]) => ({ content, status })) },
    },
  ],
})

const model = exampleModel([
  write(['Read the report', 'in_progress'], ['Fix the typos', 'pending'], ['Send it', 'pending']),
  write(['Read the report', 'completed'], ['Fix the typos', 'in_progress'], ['Send it', 'pending']),
  // the model tries to stop with open todos → the plugin asks it to continue (TODOS_CONTINUE)
  { text: 'I fixed the typos.' },
  write(['Read the report', 'completed'], ['Fix the typos', 'completed'], ['Send it', 'cancelled']),
  { text: 'Done. I did not send the report: there is no recipient yet.' },
])

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  instructions: 'You edit reports.',
  plugins: [todos({ enforce: true, maxNudges: 3, remindEvery: 5 })],
})

const session = agent.session('report')
const run = session.send('Proofread the report and send it.')
for await (const chunk of run.stream) {
  // `data-todos.list` carries the whole list after every successful todo_write (same id: 'list')
  if (chunk.type === 'data-todos.list') console.log(`todos:\n${renderTodos(chunk.data.todos)}`)
  // the continuation reason is delivered inside the assistant message as `data-eh.input`
  if (chunk.type === 'data-eh.input') {
    console.log(`nudge (${chunk.data.source}): ${chunk.data.text.split('\n')[0]}`)
  }
}
const result = await run.result
console.log(`${result.stop} after ${result.steps} steps`)

// From stored history (e.g. after a reload): the last list of the conversation.
const list = latestTodos(await session.messages())
console.log(`latest: ${list.map((t) => `${t.content} (${t.status})`).join(', ')}`)

await agent.close()
