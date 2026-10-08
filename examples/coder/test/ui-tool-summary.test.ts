import { describe, expect, test } from 'bun:test'
import { TOOL } from '../src/contracts.ts'
import {
  bashBody,
  countChanges,
  describeTool,
  displayPath,
  firstLine,
  formatDuration,
  isAgentProgress,
  parseBashFooter,
  splitMcpName,
  type ToolView,
  tailLines,
  todosOf,
  toolView,
} from '../src/ui/tool-summary.ts'

const view = (toolName: string, input: unknown, over: Partial<ToolView> = {}): ToolView => ({
  toolName,
  toolCallId: 'c',
  state: 'output-available',
  input,
  output: 'ok',
  ...over,
})

describe('helpers', () => {
  test('displayPath, firstLine, tailLines, formatDuration', () => {
    expect(displayPath('/')).toBe('.')
    expect(displayPath('')).toBe('.')
    expect(displayPath('/src/a.ts')).toBe('src/a.ts')
    expect(firstLine('abc\ndef')).toBe('abc')
    expect(firstLine('x'.repeat(10), 5)).toBe('xxxx…')
    expect(tailLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c'])
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(65_000)).toBe('1m 05s')
  })

  test('countChanges counts lines added and removed', () => {
    expect(countChanges('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 })
    expect(countChanges('x\n', 'x\n')).toEqual({ added: 0, removed: 0 })
  })

  test('toolView flattens tool parts and ignores others', () => {
    expect(toolView({ type: 'text', text: 'x' } as never)).toBeNull()
    const v = toolView({
      type: 'tool-read_file',
      toolCallId: 'k',
      state: 'input-available',
      input: { path: '/a' },
    } as never)
    expect(v).toMatchObject({ toolName: 'read_file', toolCallId: 'k', state: 'input-available' })
  })

  test('isAgentProgress', () => {
    expect(isAgentProgress({ status: 'running', agent: 'x', steps: 1 })).toBe(true)
    expect(isAgentProgress('text')).toBe(false)
    expect(isAgentProgress(null)).toBe(false)
  })
})

describe('parseBashFooter: the three footers', () => {
  test('exit code with and without seconds', () => {
    expect(parseBashFooter('out\nExit code 0 · 4.2s')).toEqual({
      kind: 'exit',
      code: 0,
      seconds: 4.2,
    })
    expect(parseBashFooter('out\nExit code 2')).toEqual({ kind: 'exit', code: 2 })
    expect(parseBashFooter('x\nexit code -1 · 0.1s\n\n')).toMatchObject({ code: -1 })
  })
  test('timeout and abort', () => {
    expect(parseBashFooter('x\n(timed out after 120s)')).toEqual({ kind: 'timeout' })
    expect(parseBashFooter('x\n(aborted after 1.5s)')).toEqual({ kind: 'aborted' })
  })
  test('no footer', () => {
    expect(parseBashFooter('just output')).toBeUndefined()
    expect(parseBashFooter('')).toBeUndefined()
  })
})

describe('describeTool', () => {
  test('read_file: Read(path) and a line count', () => {
    const d = describeTool(view(TOOL.read, { path: '/src/a.ts' }, { output: 'a\nb\nc' }))
    expect(d).toMatchObject({ label: 'Read', target: 'src/a.ts', summary: 'Read 3 lines' })
    const ranged = describeTool(view(TOOL.read, { path: '/a', offset: 120, limit: 61 }))
    expect(ranged.target).toBe('a, lines 120–180')
    expect(describeTool(view(TOOL.read, { path: '/a', offset: 3 })).target).toBe('a, from line 3')
    const running = describeTool(view(TOOL.read, { path: '/a' }, { state: 'input-available' }))
    expect(running).toMatchObject({ label: 'Read', status: 'running', summary: '' })
  })

  test('list_files, glob, grep: counts and empty results', () => {
    expect(describeTool(view(TOOL.list, { prefix: '/src' }, { output: 'a\nb\n' }))).toMatchObject({
      label: 'List',
      target: 'src',
      summary: 'Found 2 files',
    })
    expect(describeTool(view(TOOL.list, {}, { output: 'No files found' })).summary).toBe(
      'Found 0 files',
    )
    expect(
      describeTool(view(TOOL.glob, { pattern: '**/*.ts' }, { output: 'a\nb\nc' })),
    ).toMatchObject({ label: 'Glob', target: '**/*.ts', summary: 'Found 3 files' })
    expect(describeTool(view(TOOL.glob, { pattern: 'x' }, { output: 'a' })).summary).toBe(
      'Found 1 file',
    )
    expect(
      describeTool(view(TOOL.grep, { pattern: 'foo', path: '/src' }, { output: 'a:1\nb:2' })),
    ).toMatchObject({
      label: 'Search',
      target: 'pattern: "foo", path: "src"',
      summary: 'Found 2 matches',
    })
    expect(describeTool(view(TOOL.grep, { pattern: 'f' }, { output: 'No matches' })).summary).toBe(
      'Found 0 matches',
    )
  })

  test('edit_file: Update(path) with addition and removal counts', () => {
    const d = describeTool(
      view(TOOL.edit, { path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nB\nC\n' }),
    )
    expect(d).toMatchObject({
      label: 'Update',
      target: 'a.ts',
      summary: 'Updated a.ts with 2 additions and 1 removal',
      status: 'ok',
    })
    const one = describeTool(view(TOOL.edit, { path: '/a', old_string: 'x\n', new_string: 'y\n' }))
    expect(one.summary).toBe('Updated a with 1 addition and 1 removal')
  })

  test('write_file: Write(path), created vs wrote', () => {
    const v = view(TOOL.write, { path: '/n.ts', content: 'a\nb\nc' })
    expect(describeTool(v, { change: { action: 'create' } })).toMatchObject({
      label: 'Write',
      target: 'n.ts',
      summary: 'Created 3 lines in n.ts',
    })
    expect(describeTool(v, { change: { action: 'write' } }).summary).toBe('Wrote 3 lines to n.ts')
    expect(describeTool(v, {}).summary).toBe('Wrote 3 lines to n.ts')
  })

  test('delete_file, todo_write, agent, exit_plan_mode, request_directory_access', () => {
    expect(describeTool(view(TOOL.delete, { path: '/x' }))).toMatchObject({
      label: 'Delete',
      target: 'x',
      summary: 'Deleted x',
    })
    expect(describeTool(view(TOOL.todo, { todos: [1, 2] }))).toMatchObject({
      label: 'Update Todos',
      target: '',
    })
    expect(
      describeTool(view(TOOL.agent, { subagent_type: 'explore', description: 'look' })),
    ).toMatchObject({ label: 'Task', target: 'look', note: 'explore' })
    expect(describeTool(view(TOOL.agent, { description: 'd' })).note).toBe('general-purpose')
    expect(describeTool(view(TOOL.exitPlan, {}))).toMatchObject({ label: 'Plan', target: '' })
    expect(describeTool(view(TOOL.dirAccess, { path: '/tmp/x' }))).toMatchObject({
      label: 'Directory access',
      target: '/tmp/x',
    })
  })

  test('MCP tools: server - tool (MCP)(args)', () => {
    const d = describeTool(view('github_search_issues', { q: 'bug', n: 3 }))
    expect(d.label).toBe('github - search_issues (MCP)')
    expect(d.target).toBe('q: "bug", n: 3')
    expect(describeTool(view('mcp__fs__read', {})).label).toBe('fs - read (MCP)')
    expect(describeTool(view('load_skill', {})).label).toBe('load_skill')
    expect(describeTool(view('t', { a: 'x'.repeat(200) })).target.length).toBe(80)
    expect(splitMcpName('nounderscore')).toBeUndefined()
  })

  test('todosOf and bashBody', () => {
    expect(todosOf({ todos: [{ content: 'a', status: 'completed' }, { content: 'b' }] })).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ])
    expect(todosOf({})).toEqual([])
    expect(bashBody('a\nb\nExit code 0 · 1.0s')).toEqual(['a', 'b'])
    expect(bashBody('plain\n')).toEqual(['plain'])
  })

  test('bash: three footers', () => {
    const ok = describeTool(view(TOOL.bash, { command: 'ls' }, { output: 'a\nExit code 0 · 4.2s' }))
    expect(ok).toMatchObject({
      label: 'Bash',
      target: 'ls',
      summary: 'exit 0 · 4.2s',
      status: 'ok',
    })
    expect(ok.summaryError).toBeUndefined()
    const fail = describeTool(view(TOOL.bash, { command: 'x' }, { output: 'Exit code 1 · 0.2s' }))
    expect(fail).toMatchObject({ summary: 'exit 1 · 0.2s', status: 'error', summaryError: true })
    expect(fail.error).toBeUndefined()
    const timeout = describeTool(
      view(TOOL.bash, { command: 'x' }, { output: '(timed out after 5s)' }),
    )
    expect(timeout).toMatchObject({ summary: 'timed out', status: 'error', summaryError: true })
    const aborted = describeTool(
      view(TOOL.bash, { command: 'x' }, { output: '(aborted after 1.0s)' }),
    )
    expect(aborted).toMatchObject({ summary: 'aborted', status: 'error' })
  })

  test('bash without a footer falls back to the observed timing; running shows a tail', () => {
    const d = describeTool(view(TOOL.bash, { command: 'x' }, { output: 'plain' }), {
      timing: { start: 0, end: 1500 },
    })
    expect(d.summary).toBe('1.5s')
    const running = describeTool(view(TOOL.bash, { command: 'x' }, { state: 'input-available' }), {
      bashLive: '1\n2\n3\n4\n5\n6\n',
    })
    expect(running.status).toBe('running')
    expect(running.tail).toEqual(['2', '3', '4', '5', '6'])
  })

  test('classifyToolResult-based error states', () => {
    for (const [prefix, shown] of [
      ['ERROR: nope', 'Error: nope'],
      ['STALE: changed', 'Error: STALE: changed'],
      ['CONFLICT: x', 'Error: CONFLICT: x'],
      ['REJECTED: ro', 'Error: REJECTED: ro'],
    ] as const) {
      const d = describeTool(view(TOOL.edit, { path: '/a' }, { output: `${prefix}\nmore` }))
      expect(d.status).toBe('error')
      expect(d.error).toBe(shown)
      expect(d.summary).toBe('')
    }
  })

  test('output-error, output-denied, approval-requested, preliminary', () => {
    const err = describeTool(
      view(TOOL.read, { path: '/a' }, { state: 'output-error', errorText: 'bad\nx' }),
    )
    expect(err).toMatchObject({ status: 'error', error: 'Error: bad' })
    const reason = describeTool(
      view(TOOL.bash, { command: 'rm' }, { state: 'output-error', errorText: 'Denied: rule X' }),
    )
    expect(reason).toMatchObject({ status: 'denied', error: 'Denied: rule X' })
    const denied = describeTool(view(TOOL.bash, { command: 'rm' }, { state: 'output-denied' }))
    expect(denied).toMatchObject({ status: 'denied', error: 'Denied by user' })
    const waiting = describeTool(
      view(TOOL.bash, { command: 'ls' }, { state: 'approval-requested' }),
    )
    expect(waiting).toMatchObject({ status: 'waiting', summary: 'awaiting approval' })
    const prelim = describeTool(
      view(TOOL.agent, { description: 'd' }, { output: { status: 'running' }, preliminary: true }),
    )
    expect(prelim.status).toBe('running')
  })

  test('agent progress output is a JSON-safe object', () => {
    const progress = {
      status: 'running',
      agent: 'explore',
      description: 'd',
      sessionId: 's',
      steps: 2,
      text: '',
    }
    const d = describeTool(view(TOOL.agent, { description: 'd' }, { output: progress }))
    expect(d.status).toBe('ok')
    expect(isAgentProgress(progress)).toBe(true)
  })
})
