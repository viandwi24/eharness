# Spec 13 — Todos plugin (`eharness/todos`)

Status: **Draft (0.3)** (shipped in 0.3.0). Module: `src/todos/*`. Built only with the public core API (ADR-0008).

A checklist the model keeps while it works on a multi-step task, visible to the UI, reminded to the
model without breaking the prompt cache, and optionally used to keep a turn going until the work
is done — bounded by progress (spec 05 §3.2). Design: ADR-0018.

## 1. Usage

```ts
import { todos } from 'eharness/todos'

defineHarnessAgent({ model, plugins: [todos({ enforce: true })] })

export interface TodosOptions {
  enforce?: boolean      // default false — keep the turn going while todos are open (§5)
  maxNudges?: number     // default 3 — continuations per turn the plugin asks for
  remindEvery?: number   // default 5 — steps without todo_write before open todos are reminded; 0 = never
  maxItems?: number      // default 50
}
```

Add the plugin only for models that benefit: frontier models track multi-step work well without a
list (Claude Code turned its todo tools off by default for newer models in 2026).

## 2. Tool `todo_write` (model-visible)

Input `{ todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' |
'cancelled'; activeForm?: string }> }` (at most `maxItems`); **replaces the whole list**.

- More than one `in_progress` → result `ERROR: only one todo may be in_progress at a time; you
  marked {n}. Send the list again.` (the list is unchanged).
- Otherwise result `Todo list updated: {open} open, {completed} completed.` followed by one line
  per todo: `[x]` completed, `[>]` in progress, `[ ]` pending, `[-]` cancelled.
- Static instruction `TODOS_INSTRUCTION` (instructions block 1, cache-stable).

## 3. Where the list lives

- **Source of truth: the conversation.** The current list is the input of the last `todo_write`
  call on the current branch whose result is not an error, read from the model wire at every
  `step.prepare`. A call denied by approval (`execution-denied`) never ran and counts as a failed
  write. Regenerate, edit and rewind therefore always see the right list.
- **UI:** every successful write streams `data-todos.list` `{ todos }` with id `list` (reconciled
  within the message, persisted, `model: 'omit'`). `latestTodos(messages)` returns the last one.
- **Compaction:** `compaction.prompt` computes the list from the messages being summarized (its
  `out.messages`: the last successful `todo_write` part) or, when they have none, from the
  carried list — never from in-memory state, which is empty on a fresh instance (a restart
  followed by a compaction keeps the list); it adds the list to the summarizer context, and
  `compaction.after` stores it in plugin state (`carried`). When the wire has no `todo_write` (it was summarized
  away), the carried list is used. Known limit: rewinding behind a compaction marker to a point
  without any `todo_write` still shows the carried list.

## 4. Reminders (volatile)

At `step.prepare`, when open todos (`pending` / `in_progress`) exist and either `remindEvery` model
steps passed since the last `todo_write`, or a compaction just carried the list, the step gets the
reminder `TODOS_REMINDER` (`Open todos (update them with todo_write as you work):\n{list}`). It is
a step reminder (spec 02 §5): never stored, never in the system prompt.

## 5. Enforcement (`enforce: true`)

`turn.beforeEnd` for stop `'complete'` with open todos returns `{ continue: { reason:
TODOS_CONTINUE } }` (the open list, "continue with the next one, or mark it cancelled and say why,
or ask the user"), unless:

- `maxNudges` continuations were already asked in this turn; or
- the previous nudge changed nothing: the list's (content, status) fingerprint is the same as at
  the last nudge **and** the core reports `idleContinues > 0` (no new tool results since).

The core bounds it further (`loop.maxIdleContinues`, budgets, abort). Any other stop (`'length'`,
`'tool-pending'`, errors, aborts) is never extended by the plugin.
