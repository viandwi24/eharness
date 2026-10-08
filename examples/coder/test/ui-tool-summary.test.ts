import { describe, expect, test } from 'bun:test'
import { TOOL } from '../src/contracts.ts'
import {
  countChanges,
  describeTool,
  displayPath,
  firstLine,
  formatDuration,
  isAgentProgress,
  parseBashFooter,
  type ToolView,
  tailLines,
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
  test('read_file, with and without a range, running vs done', () => {
    const d = describeTool(view(TOOL.read, { path: '/src/a.ts', offset: 120, limit: 61 }))
    expect(d).toMatchObject({ label: 'Read', target: 'src/a.ts', suffix: '(lines 120–180)' })
    expect(describeTool(view(TOOL.read, { path: '/a', offset: 3 })).suffix).toBe('(from line 3)')
    expect(describeTool(view(TOOL.read, { path: '/a', limit: 5 })).suffix).toBe('(first 5 lines)')
    const running = describeTool(view(TOOL.read, { path: '/a' }, { state: 'input-available' }))
    expect(running).toMatchObject({ label: 'Reading', status: 'running' })
  })

  test('list_files, glob, grep counts and empty results', () => {
    expect(describeTool(view(TOOL.list, { prefix: '/src' }, { output: 'a\nb\n' }))).toMatchObject({
      label: 'List',
      target: 'src',
      suffix: '(2 files)',
    })
    expect(describeTool(view(TOOL.list, {}, { output: 'No files found' })).suffix).toBe('(0 files)')
    expect(
      describeTool(view(TOOL.glob, { pattern: '**/*.ts' }, { output: 'a\nb\nc' })),
    ).toMatchObject({
      target: '**/*.ts',
      suffix: '(3 files)',
    })
    expect(describeTool(view(TOOL.glob, { pattern: 'x' }, { output: 'No files' })).suffix).toBe(
      '(0 files)',
    )
    expect(describeTool(view(TOOL.grep, { pattern: 'foo' }, { output: 'a:1\nb:2' }))).toMatchObject(
      {
        label: 'Grep',
        target: '"foo"',
        suffix: '(2 matches)',
      },
    )
    expect(describeTool(view(TOOL.grep, { pattern: 'f' }, { output: 'No matches' })).suffix).toBe(
      '(0 matches)',
    )
  })

  test('edit_file shows (+N −M)', () => {
    const d = describeTool(
      view(TOOL.edit, { path: '/a.ts', old_string: 'a\nb\n', new_string: 'a\nB\nC\n' }),
    )
    expect(d).toMatchObject({ label: 'Edited', target: 'a.ts', suffix: '(+2 −1)', status: 'ok' })
  })

  test('write_file: Created vs Wrote and line count', () => {
    const v = view(TOOL.write, { path: '/n.ts', content: 'a\nb\nc' })
    expect(describeTool(v, { change: { action: 'create' } })).toMatchObject({
      label: 'Created',
      suffix: '(3 lines)',
    })
    expect(describeTool(v, { change: { action: 'write' } }).label).toBe('Wrote')
    expect(describeTool(v, {}).label).toBe('Wrote')
  })

  test('delete_file, todo_write, agent, exit_plan_mode, request_directory_access, unknown', () => {
    expect(describeTool(view(TOOL.delete, { path: '/x' }))).toMatchObject({
      label: 'Deleted',
      target: 'x',
    })
    expect(describeTool(view(TOOL.todo, { todos: [1, 2] })).target).toBe('updated (2 items)')
    expect(describeTool(view(TOOL.todo, {})).target).toBe('updated')
    expect(
      describeTool(view(TOOL.agent, { subagent_type: 'explore', description: 'look' })),
    ).toMatchObject({ label: 'Agent', target: 'explore: look' })
    expect(describeTool(view(TOOL.agent, { description: 'd' })).target).toBe('general-purpose: d')
    expect(describeTool(view(TOOL.exitPlan, {}))).toMatchObject({
      label: 'Plan',
      target: 'proposed',
    })
    expect(describeTool(view(TOOL.dirAccess, { path: '/tmp/x' }))).toMatchObject({
      label: 'Directory access',
      target: '/tmp/x',
    })
    const unknown = describeTool(view('mcp_thing', { a: 1 }))
    expect(unknown).toMatchObject({ label: 'mcp_thing', target: '{"a":1}' })
    expect(describeTool(view('t', { a: 'x'.repeat(200) })).target.length).toBe(80)
  })

  test('bash: three footers', () => {
    const ok = describeTool(view(TOOL.bash, { command: 'ls' }, { output: 'a\nExit code 0 · 4.2s' }))
    expect(ok).toMatchObject({
      label: 'Bash:',
      target: 'ls',
      suffix: 'exit 0 · 4.2s',
      status: 'ok',
    })
    expect(ok.suffixError).toBeUndefined()
    const fail = describeTool(view(TOOL.bash, { command: 'x' }, { output: 'Exit code 1 · 0.2s' }))
    expect(fail).toMatchObject({ suffix: 'exit 1 · 0.2s', status: 'error', suffixError: true })
    expect(fail.error).toBeUndefined()
    const timeout = describeTool(
      view(TOOL.bash, { command: 'x' }, { output: '(timed out after 5s)' }),
    )
    expect(timeout).toMatchObject({ suffix: 'timed out', status: 'error', suffixError: true })
    const aborted = describeTool(
      view(TOOL.bash, { command: 'x' }, { output: '(aborted after 1.0s)' }),
    )
    expect(aborted).toMatchObject({ suffix: 'aborted', status: 'error' })
  })

  test('bash without a footer falls back to the observed timing; running shows a tail', () => {
    const d = describeTool(view(TOOL.bash, { command: 'x' }, { output: 'plain' }), {
      timing: { start: 0, end: 1500 },
    })
    expect(d.suffix).toBe('1.5s')
    const running = describeTool(view(TOOL.bash, { command: 'x' }, { state: 'input-available' }), {
      bashLive: '1\n2\n3\n4\n5\n6\n',
    })
    expect(running.status).toBe('running')
    expect(running.tail).toEqual(['2', '3', '4', '5', '6'])
  })

  test('classifyToolResult-based error states', () => {
    for (const prefix of ['ERROR: nope', 'STALE: changed', 'CONFLICT: x', 'REJECTED: ro']) {
      const d = describeTool(view(TOOL.edit, { path: '/a' }, { output: `${prefix}\nmore` }))
      expect(d.status).toBe('error')
      expect(d.error).toBe(prefix)
      expect(d.suffix).toBe('')
    }
  })

  test('output-error, output-denied, approval-requested, preliminary', () => {
    const err = describeTool(
      view(TOOL.read, { path: '/a' }, { state: 'output-error', errorText: 'bad\nx' }),
    )
    expect(err).toMatchObject({ status: 'error', error: 'bad' })
    const denied = describeTool(view(TOOL.bash, { command: 'rm' }, { state: 'output-denied' }))
    expect(denied).toMatchObject({ status: 'denied', error: 'denied' })
    const waiting = describeTool(
      view(TOOL.bash, { command: 'ls' }, { state: 'approval-requested' }),
    )
    expect(waiting).toMatchObject({ status: 'waiting', suffix: 'awaiting approval' })
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
