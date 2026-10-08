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
          {sym.ellipsis} +{todos.length - max} more
        </Text>
      ) : null}
    </Box>
  )
}

/** The latest todo list, shown above the prompt while items are open. */
export function TodoPanel({ todos }: { todos: TodoItem[] }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text color={color.accent}>
        {sym.bullet} <Text bold>Todos</Text>
      </Text>
      <Box paddingLeft={2}>
        <TodoList todos={todos} />
      </Box>
    </Box>
  )
}
