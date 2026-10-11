/**
 * `eharness/todos`: the `todos()` plugin — a `todo_write` checklist tool, the `data-todos.list`
 * part, reminders and an optional progress-bounded "keep going while todos are open".
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/13-todos-plugin.md
 */
export {
  latestTodos,
  openTodos,
  renderTodos,
  TODO_TOOL,
  type Todo,
  type TodoListData,
  type TodoStatus,
  type TodosDataParts,
  type TodosOptions,
  todos,
} from './plugin.ts'
