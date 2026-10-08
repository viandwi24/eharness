/** `/diff`: working-tree changes of the project, file list plus the patch of the selected file. */
import { Box, Text, useInput } from 'ink'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CoderController, DiffFile, DiffResult } from '../../contracts.ts'
import { DiffView } from '../DiffView.tsx'
import { color, sym } from '../theme.ts'
import { Loading, Page } from './Page.tsx'

const STATUS_LETTER: Record<DiffFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}

function statusColor(status: DiffFile['status']): string | undefined {
  switch (status) {
    case 'added':
    case 'untracked':
      return color.added
    case 'deleted':
      return color.removed
    case 'renamed':
      return color.accent
    default:
      return color.warning
  }
}

/** Files shown for the filter. */
export function visibleFiles(result: DiffResult, agentOnly: boolean): DiffFile[] {
  return agentOnly ? result.files.filter((f) => f.editedByAgent) : result.files
}

/** `main · 3 files · +5 −2` (the branch is left out outside git). */
export function diffSummary(result: DiffResult, files: DiffFile[]): string {
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return [
    result.git ? result.branch : undefined,
    `${files.length} ${files.length === 1 ? 'file' : 'files'}`,
    `+${added} ${sym.minus}${removed}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function FileRow({ file, selected }: { file: DiffFile; selected: boolean }): ReactElement {
  return (
    <Box>
      <Box flexShrink={0} width={2}>
        <Text color={color.accent}>{selected ? sym.pointer : ' '}</Text>
      </Box>
      <Box flexShrink={0} width={2}>
        <Text color={statusColor(file.status)} bold>
          {STATUS_LETTER[file.status]}
        </Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        <Text bold={selected} wrap="truncate-start">
          {file.path}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        {file.binary ? (
          <Text dimColor>binary</Text>
        ) : (
          <Text>
            <Text color={color.added}>+{file.added}</Text>{' '}
            <Text color={color.removed}>
              {sym.minus}
              {file.removed}
            </Text>
          </Text>
        )}
        <Text color={color.accent}>{file.editedByAgent ? ` ${sym.bullet}` : '  '}</Text>
      </Box>
    </Box>
  )
}

/** Body of the page for a loaded result. */
export function DiffBody({
  files,
  git,
  selected,
  viewing,
  agentOnly,
}: {
  files: DiffFile[]
  git: boolean
  selected: number
  viewing: boolean
  agentOnly: boolean
}): ReactElement {
  const file = files[selected]
  return (
    <Box flexDirection="column">
      {git ? null : (
        <Text color={color.warning}>
          Not a git repository — showing files edited by the agent in this session.
        </Text>
      )}
      {agentOnly ? <Text dimColor>Showing agent-edited files only.</Text> : null}
      {files.length === 0 ? (
        <Text dimColor>No changes.</Text>
      ) : (
        <Box flexDirection="column" marginTop={git && !agentOnly ? 0 : 1}>
          {files.map((f, i) => (
            <FileRow key={f.path} file={f} selected={i === selected} />
          ))}
        </Box>
      )}
      {viewing && file ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={color.accent}>
            {file.path}
          </Text>
          {file.binary ? (
            <Text dimColor>Binary file</Text>
          ) : file.patch.trim() === '' ? (
            <Text dimColor>No textual changes.</Text>
          ) : (
            <DiffView patch={file.patch} maxLines={2000} expandHint={false} />
          )}
        </Box>
      ) : null}
    </Box>
  )
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: DiffResult }
  | { status: 'error'; message: string }

/** The `/diff` page. */
export function DiffPage({
  controller,
  onClose,
  size,
}: {
  controller: Pick<CoderController, 'diff'>
  onClose(): void
  size?: { rows: number; columns: number }
}): ReactElement {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [selected, setSelected] = useState(0)
  const [viewing, setViewing] = useState(false)
  const [agentOnly, setAgentOnly] = useState(false)
  const generation = useRef(0)

  const load = useCallback(() => {
    const mine = ++generation.current
    setState({ status: 'loading' })
    controller.diff().then(
      (data) => {
        if (mine === generation.current) setState({ status: 'ready', data })
      },
      (error: unknown) => {
        if (mine === generation.current)
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
      },
    )
  }, [controller])
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    load()
    return () => {
      generation.current++
    }
  }, [])

  const files = state.status === 'ready' ? visibleFiles(state.data, agentOnly) : []
  const index = Math.min(selected, Math.max(0, files.length - 1))

  useInput((input, key) => {
    if (input === 'r') {
      setViewing(false)
      return load()
    }
    if (state.status !== 'ready') return
    if (input === 'a') {
      setAgentOnly((v) => !v)
      setSelected(0)
      setViewing(false)
    } else if (key.upArrow) setSelected(Math.max(0, index - 1))
    else if (key.downArrow) setSelected(Math.min(files.length - 1, index + 1))
    else if ((key.return || key.rightArrow) && files.length > 0) setViewing(true)
    else if (key.leftArrow) setViewing(false)
  })

  const subtitle = state.status === 'ready' ? diffSummary(state.data, files) : undefined
  return (
    <Page
      title="Changes"
      {...(subtitle ? { subtitle } : {})}
      onClose={onClose}
      arrows={false}
      size={size}
      hints="esc/q close · ↑↓ select · enter/→ patch · ← list · a agent-only · r reload · PgUp/PgDn scroll"
    >
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <Text color={color.error}>{state.message}</Text> : null}
      {state.status === 'ready' ? (
        <DiffBody
          files={files}
          git={state.data.git}
          selected={index}
          viewing={viewing}
          agentOnly={agentOnly}
        />
      ) : null}
    </Page>
  )
}
