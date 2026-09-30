/**
 * `eharness/todos`: the `todos()` plugin — a `todo_write` checklist tool, the `data-todos.list`
 * part, reminders and an optional progress-bounded "keep going while todos are open".
 *
 * @see docs/specs/13-todos-plugin.md
 */
export {
  latestTodos,
  openTodos,
  renderTodos,
  TODO_TOOL,
  TODOS_CONTINUE,
  TODOS_INSTRUCTION,
  TODOS_REMINDER,
  type Todo,
  type TodoListData,
  type TodoStatus,
  type TodosDataParts,
  type TodosOptions,
  todos,
} from './plugin.ts'
