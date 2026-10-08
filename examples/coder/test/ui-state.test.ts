import { describe, expect, test } from 'bun:test'
import type { CoderMessage } from '../src/contracts.ts'
import { hasOpenTodos, initialState, latestTodos, reduce, type ViewState } from '../src/ui/state.ts'

const assistant = (id: string, parts: unknown[]): CoderMessage =>
  ({ id, role: 'assistant', parts }) as unknown as CoderMessage
const toolPart = (state: string, extra: Record<string, unknown> = {}): unknown => ({
  type: 'tool-read_file',
  toolCallId: 'c1',
  state,
  input: { path: '/a.ts' },
  ...extra,
})

describe('ui state reducer', () => {
  test('initial state is the header splash', () => {
    const s = initialState()
    expect(s.entries).toEqual([{ kind: 'header', id: 'header' }])
    expect(s.running).toBe(false)
    expect(s.live).toBeNull()
  })

  test('user-submitted adds an entry and de-duplicates consecutive history', () => {
    let s = reduce(initialState(), { type: 'user-submitted', text: 'hi' })
    s = reduce(s, { type: 'user-submitted', text: 'hi' })
    s = reduce(s, { type: 'user-submitted', text: 'yo' })
    expect(s.history).toEqual(['hi', 'yo'])
    expect(s.entries.filter((e) => e.kind === 'user')).toHaveLength(3)
    expect(new Set(s.entries.map((e) => e.id)).size).toBe(s.entries.length)
  })

  test('history is capped at 200', () => {
    let s = initialState()
    for (let i = 0; i < 250; i++) s = reduce(s, { type: 'user-submitted', text: `p${i}` })
    expect(s.history).toHaveLength(200)
    expect(s.history[199]).toBe('p249')
  })

  test('turn start, live snapshots and finish move the message into entries', () => {
    let s = reduce(initialState(), { type: 'turn-started' })
    expect(s.running).toBe(true)
    s = reduce(s, {
      type: 'live',
      message: assistant('m1', [{ type: 'text', text: 'he' }]),
      now: 1,
    })
    expect(s.live?.id).toBe('m1')
    s = reduce(s, {
      type: 'live',
      message: assistant('m1', [{ type: 'text', text: 'hello' }]),
      now: 2,
    })
    s = reduce(s, { type: 'turn-finished' })
    expect(s.running).toBe(false)
    expect(s.live).toBeNull()
    const last = s.entries[s.entries.length - 1]
    expect(last?.kind).toBe('message')
    expect(last?.kind === 'message' && last.message.parts[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('an empty live message is not kept', () => {
    let s = reduce(initialState(), { type: 'turn-started' })
    s = reduce(s, { type: 'live', message: assistant('m1', []), now: 1 })
    s = reduce(s, { type: 'turn-finished' })
    expect(s.entries).toHaveLength(1)
  })

  test('a non-complete stop becomes a system line with its tone', () => {
    let s = reduce(initialState(), { type: 'turn-started' })
    s = reduce(s, {
      type: 'turn-finished',
      note: { text: 'Interrupted.', tone: 'info' },
    })
    const last = s.entries[s.entries.length - 1]
    expect(last).toMatchObject({ kind: 'system', text: 'Interrupted.', tone: 'info' })
    s = reduce(s, { type: 'turn-finished', note: { text: 'boom', tone: 'error' } })
    expect(s.entries[s.entries.length - 1]).toMatchObject({ tone: 'error' })
  })

  test('bash chunks accumulate per tool call and keep only the tail', () => {
    let s: ViewState = initialState()
    s = reduce(s, {
      type: 'bash-output',
      chunks: [
        { toolCallId: 'a', stream: 'stdout', chunk: 'one\n' },
        { toolCallId: 'b', stream: 'stderr', chunk: 'x' },
        { toolCallId: 'a', stream: 'stdout', chunk: 'two\n' },
      ],
    })
    expect(s.bash).toEqual({ a: 'one\ntwo\n', b: 'x' })
    s = reduce(s, {
      type: 'bash-output',
      chunks: [{ toolCallId: 'a', stream: 'stdout', chunk: 'z'.repeat(20_000) }],
    })
    expect(s.bash.a?.length).toBe(16_000)
    expect(s.bash.a?.endsWith('z')).toBe(true)
  })

  test('timing: start on first sight, end once when the call finishes', () => {
    let s = reduce(initialState(), {
      type: 'live',
      message: assistant('m', [toolPart('input-available')]),
      now: 10,
    })
    expect(s.timing.c1).toEqual({ start: 10 })
    s = reduce(s, {
      type: 'live',
      message: assistant('m', [toolPart('output-available', { output: 'ok' })]),
      now: 25,
    })
    expect(s.timing.c1).toEqual({ start: 10, end: 25 })
    s = reduce(s, {
      type: 'live',
      message: assistant('m', [toolPart('output-available', { output: 'ok' })]),
      now: 99,
    })
    expect(s.timing.c1?.end).toBe(25)
  })

  test('timing: a preliminary output is not an end', () => {
    const s = reduce(initialState(), {
      type: 'live',
      message: assistant('m', [toolPart('output-available', { output: {}, preliminary: true })]),
      now: 5,
    })
    expect(s.timing.c1).toEqual({ start: 5 })
  })

  test('system and shell-result entries; shell result enters the history with a !', () => {
    let s = reduce(initialState(), { type: 'system', text: 'x' })
    expect(s.entries[1]).toMatchObject({ kind: 'system', tone: 'info' })
    s = reduce(s, { type: 'shell-result', command: 'ls', output: 'a', exitCode: 0 })
    expect(s.entries[2]).toMatchObject({ kind: 'shell', command: 'ls', exitCode: 0 })
    expect(s.history).toEqual(['!ls'])
  })

  test('reset clears the transcript, keeps history and expanded, bumps the epoch', () => {
    let s = reduce(initialState(), { type: 'user-submitted', text: 'hi' })
    s = reduce(s, { type: 'toggle-expand' })
    s = reduce(s, { type: 'reset' })
    expect(s.entries).toEqual([{ kind: 'header', id: 'header' }])
    expect(s.history).toEqual(['hi'])
    expect(s.expanded).toBe(true)
    expect(s.epoch).toBe(1)
    expect(reduce(s, { type: 'reset' }).epoch).toBe(2)
  })

  test('load replaces entries with the stored non-empty messages', () => {
    const s = reduce(initialState(), {
      type: 'load',
      messages: [assistant('a', [{ type: 'text', text: 'x' }]), assistant('b', [])],
    })
    expect(s.entries.map((e) => e.id)).toEqual(['header', 'm:a'])
    expect(s.epoch).toBe(1)
  })

  test('latestTodos prefers the live message and hasOpenTodos ignores finished lists', () => {
    const todos = (status: string): unknown => ({
      type: 'data-todos.list',
      data: { todos: [{ id: '1', content: 'a', status }] },
    })
    let s = reduce(initialState(), {
      type: 'load',
      messages: [assistant('a', [todos('completed')])],
    })
    expect(hasOpenTodos(latestTodos(s))).toBe(false)
    s = reduce(s, { type: 'live', message: assistant('l', [todos('pending')]), now: 1 })
    expect(latestTodos(s)?.[0]?.status).toBe('pending')
    expect(hasOpenTodos(latestTodos(s))).toBe(true)
    expect(latestTodos(initialState())).toBeNull()
    expect(hasOpenTodos(null)).toBe(false)
  })
})

describe('subagent run tracking', () => {
  const agentPart = (state: string, output?: unknown, preliminary = false): unknown => ({
    type: 'tool-agent',
    toolCallId: 'a1',
    state,
    input: { description: 'look', subagent_type: 'explore' },
    output,
    preliminary,
  })
  const progress = (status: string) => ({
    status,
    agent: 'explore',
    description: 'look',
    sessionId: 'child-1',
    steps: 2,
    text: '',
  })
  const live = (s: ViewState, part: unknown): ViewState =>
    reduce(s, { type: 'live', message: assistant('m1', [part]), now: 1 })

  test('records progress, then marks done on the final string output', () => {
    let s = live(initialState(), agentPart('output-available', progress('running'), true))
    expect(s.subagents).toEqual([
      {
        toolCallId: 'a1',
        name: 'explore',
        description: 'look',
        sessionId: 'child-1',
        status: 'running',
      },
    ])
    s = live(s, agentPart('output-available', 'final answer'))
    expect(s.subagents).toHaveLength(1)
    expect(s.subagents[0]?.status).toBe('done')
    expect(s.subagents[0]?.sessionId).toBe('child-1')
  })

  test('a tool error marks failed; an interrupted turn fails running runs; reset clears', () => {
    let s = live(initialState(), agentPart('output-available', progress('running'), true))
    s = live(s, agentPart('output-error'))
    expect(s.subagents[0]?.status).toBe('failed')
    let t = live(initialState(), agentPart('output-available', progress('running'), true))
    t = reduce(t, { type: 'turn-finished' })
    expect(t.subagents[0]?.status).toBe('failed')
    expect(reduce(t, { type: 'reset' }).subagents).toEqual([])
  })

  test('the transcript action adds a read-only entry', () => {
    const s = reduce(initialState(), { type: 'transcript', title: 't', messages: [] })
    expect(s.entries.at(-1)).toMatchObject({ kind: 'transcript', title: 't' })
  })
})
