import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { color, sym } from './theme.ts'

/** The fields of a todo item the list needs (`Todo` of `eharness/todos` fits). */
export interface TodoItem {
  content: string
  status: string
  activeForm?: string | undefined
}

/** Checkbox list: `☐` pending, `◼` in progress (bold), `☒` done (dim, struck through). */
export function TodoList({ todos, max = 12 }: { todos: TodoItem[]; max?: number }): ReactElement {
  return (
    <Box flexDirection="column">
      {todos.slice(0, max).map((todo, i) => {
        const done = todo.status === 'completed' || todo.status === 'cancelled'
        const active = todo.status === 'in_progress'
        const mark = (sym.todo as Record<string, string>)[todo.status] ?? sym.todo.pending
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a static list, never reordered
          <Text key={`${i}:${todo.content}`} bold={active} dimColor={done} strikethrough={done}>
            {mark} {active ? (todo.activeForm ?? todo.content) : todo.content}
          </Text>
        )
      })}
      {todos.length > max ? (
        <Text dimColor>
          {sym.ellipsis} {todos.length - max} more
        </Text>
      ) : null}
    </Box>
  )
}

/**
 * The latest todo list, shown above the prompt while items are open. `collapsed` shows one dim
 * line (`☰ 3/7 todos (ctrl+t)`); expanded shows up to 5 items and `… N more`.
 */
export function TodoPanel({
  todos,
  collapsed = false,
}: {
  todos: TodoItem[]
  collapsed?: boolean
}): ReactElement {
  if (collapsed) {
    const done = todos.filter((t) => t.status === 'completed' || t.status === 'cancelled').length
    return (
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>
          ☰ {done}/{todos.length} todos (ctrl+t)
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text color={color.accent}>
        {sym.bullet} <Text bold>Todos</Text>
      </Text>
      <Box paddingLeft={2}>
        <TodoList todos={todos} max={5} />
      </Box>
    </Box>
  )
}
