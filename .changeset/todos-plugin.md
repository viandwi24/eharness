---
"eharness": minor
---

**New: `eharness/todos`** (spec 13, ADR-0018): the `todos()` plugin gives the model a
`todo_write` checklist tool (whole-list replacement, one `in_progress` at a time, `cancelled`
status), streams `data-todos.list` for UIs (`latestTodos(messages)`), reminds open todos with
volatile step reminders (`remindEvery`, and once after a compaction) and, with `enforce: true`,
keeps the turn going while todos are open — bounded by `maxNudges` and by progress.
