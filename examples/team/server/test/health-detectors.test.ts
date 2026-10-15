/** Agent health detectors (pure) on fixtures, and the authority suggestion rules. */
import { describe, expect, test } from 'bun:test'
import {
  type CallEvent,
  deniedToolCandidates,
  detectProgramRuns,
  detectProviderErrors,
  detectRepeatedDenials,
  detectRepeatedErrors,
  detectTokenSpikes,
  detectToolLoops,
  detectWaitingApprovals,
  fingerprintOf,
  HEALTH,
  normalizeError,
  readToolPart,
  safeToSuggest,
  stableJson,
  type ToolEvent,
} from '../src/domain/health.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000

let seq = 0
const tool = (over: Partial<ToolEvent> = {}): ToolEvent => ({
  sessionId: 's1',
  messageId: 'm1',
  at: NOW - 5 * MIN,
  agentId: 'a1',
  programId: null,
  link: '/tasks/t1',
  toolName: 'grep',
  inputKey: `{"q":"x${seq++}"}`,
  denied: false,
  denialReason: null,
  error: null,
  outputChars: 10,
  ...over,
})
const many = (n: number, over: Partial<ToolEvent> = {}): ToolEvent[] =>
  Array.from({ length: n }, (_, i) => tool({ ...over, at: (over.at ?? NOW - 5 * MIN) + i }))
const call = (over: Partial<CallEvent> = {}): CallEvent => ({
  id: `c${seq++}`,
  sessionId: 's1',
  agentId: 'a1',
  link: null,
  at: NOW - 10 * MIN,
  kind: 'step',
  status: 'ok',
  inputTokens: 1000,
  errorName: null,
  errorMessage: null,
  ...over,
})

describe('repeated denial', () => {
  test('three denials of one tool in a session', () => {
    const out = detectRepeatedDenials(many(3, { denied: true, denialReason: 'no' }), NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'repeated-denial', count: 3, severity: 'medium' })
    expect(out[0]?.fingerprint).toBe('denial:session:s1:grep')
  })
  test('two are not enough; other tools do not add up', () => {
    const events = [
      ...many(2, { denied: true }),
      ...many(2, { denied: true, toolName: 'glob' }),
      ...many(5, { denied: false }),
    ]
    expect(detectRepeatedDenials(events, NOW)).toEqual([])
  })
  test('across runs of one program: one high finding', () => {
    const events = ['p:1', 'p:2', 'p:3'].flatMap((sessionId) =>
      many(1, { sessionId, programId: 'prog', denied: true, toolName: 'list_topics' }),
    )
    const out = detectRepeatedDenials(events, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ severity: 'high', programId: 'prog', count: 3 })
    expect(out[0]?.explanation).toContain('3 runs')
  })
  test('older than 24 h is ignored', () => {
    expect(
      detectRepeatedDenials(many(4, { denied: true, at: NOW - HEALTH.windowMs - MIN }), NOW),
    ).toEqual([])
  })
})

describe('tool loop', () => {
  const same = (n: number, over: Partial<ToolEvent> = {}): ToolEvent[] =>
    many(n, { toolName: 'read_file', inputKey: 'in', outputKey: 'out', ...over })
  test('same full input and same output three times in a turn', () => {
    const out = detectToolLoops(same(3), NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tool-loop', count: 3 })
    expect(out[0]?.explanation).toContain('same result')
    expect(detectToolLoops(same(2), NOW)).toEqual([])
  })
  test('different inputs of one tool are not a loop (61 searches with different queries)', () => {
    const searches = Array.from({ length: 61 }, (_, i) =>
      tool({
        toolName: 'telegram_user_search_messages',
        inputKey: fingerprintOf(stableJson({ query: `giveaway ${i}`, limit: 20 })),
        outputKey: 'same-empty-result',
      }),
    )
    expect(detectToolLoops(searches, NOW)).toEqual([])
  })
  test('polling: same input, changing outputs is not a loop', () => {
    const polls = Array.from({ length: 12 }, (_, i) =>
      tool({ toolName: 'browser_snapshot', inputKey: '{}', outputKey: `screen-${i}` }),
    )
    expect(detectToolLoops(polls, NOW)).toEqual([])
  })
  test('identical rate-limit errors with the same input are a loop', () => {
    const out = detectToolLoops(
      many(4, {
        toolName: 'telegram_user_read',
        inputKey: 'in',
        error: 'ERROR: rate limited, retry after 30 s',
      }),
      NOW,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.count).toBe(4)
  })
  test('stableJson sorts keys and fingerprints differ for long inputs with a common prefix', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }))
    const prefix = 'x'.repeat(500)
    expect(fingerprintOf(stableJson({ q: `${prefix}a` }))).not.toBe(
      fingerprintOf(stableJson({ q: `${prefix}b` })),
    )
  })
  test('readToolPart keys the full input and the output', () => {
    const mk = (q: string, output: string): Record<string, unknown> => ({
      type: 'tool-search',
      state: 'output-available',
      input: { q, n: 1 },
      output,
    })
    const a = readToolPart(mk('giveaway', 'r1'))
    const b = readToolPart(mk('undian', 'r1'))
    const c = readToolPart(mk('giveaway', 'r2'))
    expect(a?.inputKey).not.toBe(b?.inputKey)
    expect(a?.outputKey).toBe(b?.outputKey)
    expect(a?.outputKey).not.toBe(c?.outputKey)
  })
  test('different turns do not add up; tool_search repeats whatever the query', () => {
    const split = [...same(2, { messageId: 'm1' }), ...same(2, { messageId: 'm2' })]
    expect(detectToolLoops(split, NOW)).toEqual([])
    const search = Array.from({ length: 19 }, (_, i) =>
      tool({ toolName: 'tool_search', inputKey: `{"query":"telegram ${'x'.repeat(i)}"}` }),
    )
    const out = detectToolLoops(search, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ count: 19, severity: 'high' })
    expect(out[0]?.explanation).toContain('tool_search')
  })
})

describe('repeated error', () => {
  test('the same normalized error three times across sessions', () => {
    const events = [1, 2, 3].map((n) =>
      tool({
        sessionId: `s${n}`,
        toolName: 'run_python',
        error: `ERROR: sandbox failed at step ${n} (job 8f3a9c2d11e4)`,
      }),
    )
    const out = detectRepeatedErrors(events, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'repeated-error', count: 3, agentId: 'a1' })
    expect(out[0]?.explanation).toContain('sandbox failed')
  })
  test('different errors, denials and two repeats are not findings', () => {
    const events = [
      tool({ error: 'ERROR: a' }),
      tool({ error: 'ERROR: b' }),
      tool({ error: 'ERROR: c' }),
      ...many(4, { denied: true, error: 'x' }),
    ]
    expect(detectRepeatedErrors(events, NOW)).toEqual([])
  })
  test('normalizeError blurs ids and numbers', () => {
    expect(normalizeError('Failed 12 times: "/tmp/a" 0198f0a2-0000-7000-8000-000000000000')).toBe(
      'failed # times: "*" *',
    )
  })
})

describe('approval waiting', () => {
  const pending = (id: string, waitedMin: number) => ({
    id,
    sessionId: 's1',
    agentId: 'a1',
    link: null,
    toolName: 'write_file',
    since: NOW - waitedMin * MIN,
  })
  test('older than 15 minutes only; two hours is high', () => {
    const out = detectWaitingApprovals([pending('x', 10), pending('y', 20), pending('z', 150)], NOW)
    expect(out.map((f) => [f.fingerprint, f.severity])).toEqual([
      ['approval:y', 'medium'],
      ['approval:z', 'high'],
    ])
  })
})

describe('token spike', () => {
  test('input above 50k and more than double the previous step', () => {
    const calls = [
      call({ at: NOW - 3 * MIN, inputTokens: 20_000 }),
      call({ at: NOW - 2 * MIN, inputTokens: 90_000 }),
      call({ at: NOW - 1 * MIN, inputTokens: 95_000 }),
    ]
    const out = detectTokenSpikes(calls, [], NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'token-spike', count: 1, fingerprint: 'spike:s1' })
  })
  test('a big but gradual rise, or a small jump, is not a spike', () => {
    const calls = [
      call({ at: NOW - 3 * MIN, inputTokens: 60_000 }),
      call({ at: NOW - 2 * MIN, inputTokens: 100_000 }),
      call({ at: NOW - 1 * MIN, inputTokens: 40_000 }),
    ]
    expect(detectTokenSpikes(calls, [], NOW)).toEqual([])
    const small = [call({ inputTokens: 1000, at: NOW - 2 * MIN }), call({ inputTokens: 9000 })]
    expect(detectTokenSpikes(small, [], NOW)).toEqual([])
  })
  test('a tool output over the limit is a high finding at 150k', () => {
    const out = detectTokenSpikes(
      [],
      [tool({ toolName: 'browser_screenshot', outputChars: 184_000 })],
      NOW,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'big-output', severity: 'high' })
    expect(detectTokenSpikes([], [tool({ outputChars: 49_000 })], NOW)).toEqual([])
  })
})

describe('program runs and provider errors', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    programId: 'p',
    programName: 'Weekly audit',
    agentId: 'a1',
    sessionId: 'program:p:1',
    taskId: 't1',
    link: '/tasks/t1',
    at: NOW - MIN,
    status: 'done',
    reportStatus: 'done' as string | null,
    summary: 'ok' as string | null,
    ...over,
  })
  test('partial is medium, failed is high, done is nothing', () => {
    const out = detectProgramRuns(
      [
        run(),
        run({ sessionId: 'program:p:2', reportStatus: 'partial', summary: 'missing data' }),
        run({ sessionId: 'program:p:3', status: 'failed', reportStatus: null }),
      ],
      NOW,
    )
    expect(out.map((f) => [f.fingerprint, f.severity])).toEqual([
      ['run:program:p:2', 'medium'],
      ['run:program:p:3', 'high'],
    ])
    expect(out[0]?.explanation).toContain('missing data')
  })
  test('provider errors group by agent and message; a notice of a logged failure is not counted twice', () => {
    const failed = [1, 2, 3].map((n) =>
      call({
        status: 'error',
        errorName: 'APICallError',
        errorMessage: `Rate limited: retry in ${n}s`,
        at: NOW - n * 10 * MIN,
      }),
    )
    const notice = {
      sessionId: 's1',
      agentId: 'a1',
      link: null,
      at: NOW - 10 * MIN + 5_000,
      code: 'EH_PROVIDER',
      message: 'Rate limited',
    }
    const other = {
      ...notice,
      sessionId: 's9',
      at: NOW - 100 * MIN,
      code: 'EH_PROVIDER',
      message: 'HTTP 500',
    }
    const out = detectProviderErrors(failed, [notice, other, { ...notice, code: 'EH_OTHER' }], NOW)
    expect(out).toHaveLength(2)
    const rate = out.find((f) => f.explanation.includes('Rate limited'))
    expect(rate).toMatchObject({ count: 3, severity: 'high' })
    expect(out.find((f) => f.explanation.includes('HTTP 500'))).toMatchObject({
      count: 1,
      severity: 'medium',
    })
  })
})

describe('readToolPart', () => {
  test('denied, error text, ERROR result, big output and open calls', () => {
    expect(
      readToolPart({
        type: 'tool-grep',
        state: 'output-denied',
        input: {},
        approval: { approved: false, reason: 'Outside the authority of program "X"' },
      }),
    ).toMatchObject({
      toolName: 'grep',
      denied: true,
      denialReason: 'Outside the authority of program "X"',
    })
    expect(
      readToolPart({
        type: 'dynamic-tool',
        toolName: 'mcp_x',
        state: 'output-error',
        errorText: 'Forbidden by program "P": x',
      }),
    ).toMatchObject({ toolName: 'mcp_x', denied: true })
    expect(
      readToolPart({
        type: 'tool-run_python',
        state: 'output-available',
        input: {},
        output: 'ERROR: boom',
      }),
    ).toMatchObject({ denied: false, error: 'ERROR: boom' })
    expect(
      readToolPart({ type: 'tool-x', state: 'output-available', output: 'x'.repeat(184_000) }),
    ).toMatchObject({ outputChars: 184_000, error: null })
    expect(readToolPart({ type: 'tool-x', state: 'input-available', input: {} })).toBeUndefined()
    expect(readToolPart({ type: 'text', text: 'hi' })).toBeUndefined()
  })
})

describe('authority suggestions', () => {
  const programs = new Map([['p', { forbidden: ['channel_delete'], tools: ['web_fetch'] }]])
  const denial = (sessionId: string, toolName: string, n = 1) =>
    many(n, {
      sessionId,
      programId: 'p',
      toolName,
      denied: true,
      denialReason: 'Outside the authority of program "P": x',
    })
  const cands = (events: ToolEvent[]) =>
    deniedToolCandidates(events, programs, NOW, ['grep', 'read_file'])

  test('two runs or three denials; one denial is not enough', () => {
    expect(cands(denial('p:1', 'list_topics'))).toEqual([])
    expect(cands([...denial('p:1', 'list_topics'), ...denial('p:2', 'list_topics')])).toMatchObject(
      [{ tool: 'list_topics', runs: 2, denials: 2 }],
    )
    expect(cands(denial('p:1', 'list_topics', 3))).toMatchObject([{ runs: 1, denials: 3 }])
  })
  test('never forbidden, already granted, file tools, or a Forbidden refusal', () => {
    expect(cands(denial('p:1', 'channel_delete', 5))).toEqual([])
    expect(cands(denial('p:1', 'web_fetch', 5))).toEqual([])
    expect(cands(denial('p:1', 'grep', 5))).toEqual([])
    const forbiddenText = many(5, {
      programId: 'p',
      toolName: 'x',
      denied: true,
      denialReason: 'Forbidden by program "P": x',
    })
    expect(cands(forbiddenText)).toEqual([])
  })
  test('risk: destructive and unknown tools are not suggested', () => {
    expect(safeToSuggest('channel_describe', undefined)).toBe(true)
    expect(safeToSuggest('list_topics', 'read')).toBe(true)
    expect(safeToSuggest('memory_str_replace', 'unknown')).toBe(true)
    expect(safeToSuggest('delete_file', 'read')).toBe(false)
    expect(safeToSuggest('telegram_send', 'write')).toBe(false)
    expect(safeToSuggest('mystery_tool', 'unknown')).toBe(false)
    expect(safeToSuggest('list_topics', 'destructive')).toBe(false)
    expect(safeToSuggest('list_topics', 'read', true)).toBe(false)
  })
})
