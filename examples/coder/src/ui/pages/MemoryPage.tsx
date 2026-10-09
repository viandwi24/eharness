/** `/memory`: the memory files (CLAUDE.md / AGENTS.md) the agent reads. */
import { Text, useInput } from 'ink'
import { type ReactElement, useState } from 'react'
import type { CoderController } from '../../contracts.ts'
import { moveIndex, selectAction } from '../select.ts'
import { color, sym } from '../theme.ts'
import { Loading, Page, Section } from './Page.tsx'
import { useAsync } from './useAsync.ts'

/** The memory page. Enter shows the command that opens the file in `$VISUAL` / `$EDITOR`. */
export function MemoryPage({
  controller,
  onClose,
  size,
}: {
  controller: CoderController
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const state = useAsync(() => controller.memoryFiles())
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState<string | null>(null)
  const files = state.status === 'ready' ? state.data : []
  useInput((input, key) => {
    const action = selectAction(input, key)
    if (action === 'accept') {
      const file = files[index]
      if (file) {
        const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
        setShown(`${editor} ${file.real}`)
      }
    } else setIndex((i) => moveIndex(i, files.length, action))
  })
  return (
    <Page
      title="Memory"
      subtitle="files the agent reads"
      hints="esc/q close · ↑↓ select · enter show the edit command"
      arrows={false}
      onClose={onClose}
      size={size}
    >
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <Text color={color.error}>{state.message}</Text> : null}
      {state.status === 'ready' ? (
        <Section>
          {files.length === 0 ? <Text dimColor>(no memory files)</Text> : null}
          {files.map((f, i) => (
            <Text key={f.real} wrap="truncate-end" color={i === index ? color.accent : undefined}>
              {i === index ? sym.pointer : ' '} {f.path}
              <Text dimColor>
                {'  '}
                {f.scope} · {f.exists ? 'exists' : 'not created'}
                {f.ignored && f.ignored.length > 0 ? ` · ${f.ignored.join(', ')} ignored` : ''}
              </Text>
            </Text>
          ))}
          {shown ? <Text dimColor>Edit with: {shown}</Text> : null}
        </Section>
      ) : null}
    </Page>
  )
}
