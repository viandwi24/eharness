import type { Todo } from 'eharness/todos'
import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { color, sym } from './theme.ts'

/** The latest todo list with ☐ / ◐ / ☑ markers. */
export function TodoPanel({ todos }: { todos: Todo[] }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {todos.slice(0, 12).map((todo, i) => {
        const done = todo.status === 'completed' || todo.status === 'cancelled'
        const active = todo.status === 'in_progress'
        return (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a static list, never reordered
            key={`${i}:${todo.content}`}
            color={active ? color.running : done ? color.ok : undefined}
            dimColor={done}
            strikethrough={todo.status === 'cancelled'}
          >
            {sym.todo[todo.status] ?? sym.todo.pending}{' '}
            {active ? (todo.activeForm ?? todo.content) : todo.content}
          </Text>
        )
      })}
      {todos.length > 12 ? <Text dimColor>… {todos.length - 12} more</Text> : null}
    </Box>
  )
}
