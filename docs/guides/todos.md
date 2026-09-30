# Todos

`todos()` from `eharness/todos` gives the model a checklist for multi-step work: a `todo_write`
tool, a `data-todos.list` part your UI can render, reminders that do not break the prompt cache,
and optionally "keep going while todos are open" — bounded by progress, so a model can never loop
on its own list. Contract: spec 13, ADR-0018. Runnable: [`examples/todos.ts`](../../examples/todos.ts).

```ts
import { defineHarnessAgent } from 'eharness'
import { todos } from 'eharness/todos'

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  plugins: [
    todos({
      enforce: false, // default — true: continue the turn while todos are open
      maxNudges: 3, // default — continuations per turn the plugin asks for
      remindEvery: 5, // default — steps without todo_write before open todos are reminded; 0 = never
      maxItems: 50, // default — maximum items in the list
    }),
  ],
})
```

Add it for models that benefit. Frontier models track multi-step work well without a list; smaller
or older models, and long unattended turns, benefit most.

## What the model gets

- The static instruction `TODOS_INSTRUCTION`: write the full list once the steps are known, keep
  exactly one item `in_progress`, mark items `completed` as soon as they are done, mark them
  `cancelled` (never silently drop them) when no longer needed, and skip the tool for one-step
  requests.
- The tool `todo_write` (`TODO_TOOL`) with input `{ todos: Array<{ content, status, activeForm? }> }`
  — it **replaces the whole list**. Statuses: `'pending'`, `'in_progress'`, `'completed'`,
  `'cancelled'`. `content` is the imperative form ("Run the tests"); `activeForm` the present
  continuous for spinners ("Running the tests").
- Results: `Todo list updated: 2 open, 1 completed.` followed by one line per todo — `[x]`
  completed, `[>]` in progress, `[ ]` pending, `[-]` cancelled (`renderTodos`). More than one
  `in_progress` is rejected with an `ERROR: …` result and the list stays unchanged.

## Rendering the list

Every successful `todo_write` writes a persistent `data-todos.list` part `{ todos }` with the fixed
id `list`, so the message keeps one, always-current list (the model never sees the part itself).

```ts
import { defineHarnessAgent, type InferHarnessUIMessage } from 'eharness'
import { latestTodos, renderTodos, type Todo, todos } from 'eharness/todos'

const agent = defineHarnessAgent({ model, plugins: [todos()] })
type ChatMessage = InferHarnessUIMessage<typeof agent>

// live, from the stream (or `useChat` → message.parts with type 'data-todos.list')
const run = agent.session('s1').send('Refactor the parser')
for await (const chunk of run.stream) {
  if (chunk.type === 'data-todos.list') console.log(renderTodos(chunk.data.todos))
}

// from history, e.g. a sidebar after a reload: the last list of the conversation
function currentTodos(messages: ChatMessage[]): Todo[] {
  return latestTodos(messages) // [] when there is none
}
```

`openTodos(list)` returns the items that still need work (`pending` or `in_progress`).

## Where the list lives

The source of truth is the **conversation**: the current list is the input of the last successful
`todo_write` call on the current branch, read from the model wire before every step. Regenerate,
edit and rewind therefore always see the right list, with no state to roll back.

Compaction may summarize the last `todo_write` away. The plugin adds the list to the summarizer
context, keeps a copy in plugin state (`plugins.todos.carried`) and reminds the model of it once
after the compaction. (Known limit: rewinding behind a compaction marker to a point without any
`todo_write` still shows the carried list.)

## Reminders

When open todos exist and `remindEvery` model steps passed without a `todo_write` (or a compaction
just carried the list), the next step gets `TODOS_REMINDER` with the open list. It is a step
reminder: never stored and never part of the system prompt, so the prompt cache prefix stays
stable.

## Enforcement (`enforce: true`)

When the model stops with `'complete'` while todos are open, the plugin's `turn.beforeEnd` hook
continues the turn with `TODOS_CONTINUE`: the open list, and "continue with the next one; if an
item is blocked or no longer needed, mark it cancelled and say why; if you need the user, ask". The
reason is stored in the assistant message as a `data-eh.input` part with `source: 'plugin:todos'`.

It stops pushing when:

- it already asked `maxNudges` times in this turn; or
- the previous nudge changed nothing: the list is the same as at the last nudge **and** no new tool
  result appeared since (`idleContinues > 0`).

The core bounds it further: `loop.maxIdleContinues` (default 3), `loop.maxContinues`, budgets and
aborts ([long-running turns](long-running-turns.md)). Any other stop (`'length'`, `'tool-pending'`,
`'max-steps'`, errors, aborts) is never extended by the plugin. The first stop with open todos is
always nudged; a model that needs the user can end the turn after at most one reminder by asking
without touching the list (or at once by marking the blocked items `cancelled`).

## Exports

| Export | What |
|---|---|
| `todos(options?)` | the plugin (`HarnessPlugin<'todos', TodosDataParts>`) |
| `latestTodos(messages)` | last `data-todos.list` of a message list, `[]` if none |
| `openTodos(list)`, `renderTodos(list)` | helpers for UIs and logs |
| `TODO_TOOL`, `TODOS_INSTRUCTION`, `TODOS_REMINDER`, `TODOS_CONTINUE` | the tool name and the fixed model-visible texts (changing them is a minor change) |
| `Todo`, `TodoStatus`, `TodoListData`, `TodosOptions`, `TodosDataParts` | types |
