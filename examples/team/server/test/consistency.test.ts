/**
 * Consistency detectors (pure) on fixtures shaped like what a real deployment showed: a memory file
 * naming tools of a deleted connection, programs that were duplicated and deleted, a stale
 * connection status, two files on one topic with a placeholder. Names are generic.
 */
import { describe, expect, test } from 'bun:test'
import {
  CONSISTENCY,
  type ConsistencyInput,
  type ConsistencyKind,
  deadIdsIn,
  detectConsistency,
  topicOfName,
} from '../src/domain/consistency.ts'
import type { Program } from '../src/domain/programs.ts'
import type { Routine } from '../src/domain/routines.ts'
import type { StandingOrder } from '../src/domain/standing-orders.ts'

const NOW = 1_800_000_000_000
const DAY = 24 * 3_600_000
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const U4 = '44444444-4444-4444-8444-444444444444'

const program = (over: Partial<Program> = {}): Program => ({
  id: U1,
  agentId: 'a1',
  name: 'Morning check',
  brief: 'Check the inbox and summarise the open requests.',
  authority: { tools: [], connectors: [], read: [], write: [] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
  trigger: { kind: 'manual' },
  report: 'task',
  worker: null,
  deliverables: [],
  notes: [],
  status: 'active',
  createdBy: 'client',
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
  version: 1,
  ...over,
})

const order = (over: Partial<StandingOrder> = {}): StandingOrder => ({
  id: 'o1',
  text: 'Report every new invoice dispute to the finance group before noon',
  by: 'web:owner',
  name: '',
  role: 'owner',
  report: { kind: 'web', sessionId: 's1' },
  mention: false,
  at: NOW - DAY,
  active: true,
  kind: 'watch',
  refs: [],
  needs: [],
  ...over,
})

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  agentId: 'a1',
  name: 'Daily follow up',
  prompt: 'Follow up the open quotations of yesterday and report the answers',
  schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
  sessionMode: 'task',
  overlap: 'skip',
  catchUpWindowMs: null,
  status: 'active',
  pausedReason: null,
  nextFireAt: null,
  lastFireAt: null,
  lastStatus: null,
  failures: 0,
  maxFailures: 3,
  fireCount: 0,
  maxFires: null,
  endAt: null,
  createdAt: NOW - DAY,
  updatedAt: NOW - DAY,
  version: 1,
  programId: null,
  ...over,
})

const base = (over: Partial<ConsistencyInput> = {}): ConsistencyInput => ({
  now: NOW,
  agents: [{ id: 'a1', name: 'Alex', slug: 'alex' }],
  programs: [],
  programToolProblems: new Map(),
  orders: [],
  routines: [],
  decisions: [],
  sessionExists: () => true,
  connections: [],
  agentConnections: new Map(),
  tools: new Map(),
  knownIds: new Set([U1, 'a1']),
  memory: [],
  ...over,
})

const kinds = (input: ConsistencyInput): ConsistencyKind[] =>
  detectConsistency(input).map((f) => f.kind)

const mem = (path: string, text: string, updatedAt = NOW - DAY) => ({
  agentId: 'a1',
  path,
  text,
  updatedAt,
})

describe('programs', () => {
  test('same name (case-insensitive) is a duplicate', () => {
    const out = detectConsistency(
      base({
        programs: [program(), program({ id: U2, name: 'MORNING CHECK', brief: 'Something else' })],
        knownIds: new Set([U1, U2]),
      }),
    )
    const f = out.find((x) => x.kind === 'program-duplicate')
    expect(f?.refs).toEqual([U1, U2])
    expect(f?.fix).toContain('delete')
  })

  test('near-identical briefs are a duplicate; different programs are not', () => {
    const brief =
      'Collect pending quotations, compare supplier prices, update the price sheet, notify purchasing about increases, archive stale offers'
    const dup = base({
      programs: [program({ brief }), program({ id: U2, name: 'Prices', brief: `${brief} weekly` })],
      knownIds: new Set([U1, U2]),
    })
    expect(kinds(dup)).toContain('program-duplicate')
    const other = base({
      programs: [
        program({ brief }),
        program({
          id: U2,
          name: 'Onboarding',
          brief:
            'Welcome new employees, create accounts, schedule orientation meetings with managers',
        }),
      ],
      knownIds: new Set([U1, U2]),
    })
    expect(kinds(other)).not.toContain('program-duplicate')
  })

  test('programs of two agents with one name are fine', () => {
    const out = base({
      agents: [
        { id: 'a1', name: 'Alex', slug: 'alex' },
        { id: 'a2', name: 'Bo', slug: 'bo' },
      ],
      programs: [program(), program({ id: U2, agentId: 'a2' })],
      knownIds: new Set([U1, U2]),
    })
    expect(kinds(out)).not.toContain('program-duplicate')
  })

  test('needs a tool: brief asks for python without run_python; unavailable tools of a scheduled program are high', () => {
    const out = detectConsistency(
      base({
        programs: [
          program({
            brief: 'Calculate the totals with python and write the report',
            trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
          }),
        ],
        programToolProblems: new Map([[U1, ['phone-2_screenshot: the agent has no such tool']]]),
      }),
    ).filter((f) => f.kind === 'program-needs-tool')
    expect(out.map((f) => f.severity).sort()).toEqual(['high', 'low'])
  })

  test('dead program id in notes and brief; a living one is not flagged', () => {
    const out = detectConsistency(
      base({
        programs: [
          program({
            brief: `Same as program ${U1}.`,
            notes: [`Replaces the old program ${U3}`, `Proposal ${U4} was rejected`],
          }),
        ],
      }),
    ).filter((f) => f.kind === 'program-dead-ref')
    expect(out.map((f) => f.refs[1]).sort()).toEqual([U3, U4])
  })
})

describe('orders and routines', () => {
  test('active order that repeats a program note', () => {
    const n = 'Report every new invoice dispute to the finance group before noon'
    const out = base({
      programs: [program({ notes: [n] })],
      orders: [{ agentId: 'a1', order: order() }],
    })
    expect(kinds(out)).toContain('order-duplicates-note')
    expect(
      kinds({ ...out, orders: [{ agentId: 'a1', order: order({ active: false }) }] }),
    ).not.toContain('order-duplicates-note')
    expect(
      kinds({ ...out, programs: [program({ notes: ['Prefer short summaries in the report'] })] }),
    ).not.toContain('order-duplicates-note')
  })

  test('routines: same agent, schedule and prompt; a different schedule is fine', () => {
    const a = routine()
    const b = routine({ id: 'r2', name: 'Follow up (copy)' })
    expect(kinds(base({ routines: [a, b] }))).toContain('routine-duplicate')
    expect(
      kinds(
        base({
          routines: [
            a,
            routine({ id: 'r2', schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' } }),
          ],
        }),
      ),
    ).not.toContain('routine-duplicate')
    expect(kinds(base({ routines: [a, routine({ id: 'r2', status: 'paused' })] }))).not.toContain(
      'routine-duplicate',
    )
  })
})

describe('decisions', () => {
  const d = (over: Record<string, unknown> = {}) => ({
    id: 'd1',
    kind: 'escalation',
    status: 'open',
    title: 'Approve the quote?',
    agentId: 'a1',
    sessionId: null,
    programId: null,
    createdAt: NOW,
    ...over,
  })
  test('stale after 3 days (medium) and 7 days (high); fresh and answered ones are not', () => {
    const sev = (age: number, status = 'open') =>
      detectConsistency(base({ decisions: [d({ createdAt: NOW - age, status })] })).map(
        (f) => `${f.kind}:${f.severity}`,
      )
    expect(sev(2 * DAY)).toEqual([])
    expect(sev(CONSISTENCY.decisionStaleMs + 1)).toEqual(['decision-stale:medium'])
    expect(sev(CONSISTENCY.decisionHighMs + 1)).toEqual(['decision-stale:high'])
    expect(sev(9 * DAY, 'approved')).toEqual([])
  })
  test('dead program or session', () => {
    const out = detectConsistency(
      base({
        decisions: [d({ programId: U3, sessionId: 'program:x:1' })],
        sessionExists: () => false,
      }),
    )
    expect(out.map((f) => f.kind)).toEqual(['decision-dead-ref'])
    expect(out[0]?.explanation).toContain(U3)
  })
})

describe('connections', () => {
  const conn = (status: 'connected' | 'error' | 'disabled' | 'needs-auth') => ({
    id: 'c1',
    connectorId: 'phone',
    label: 'Phone',
    status,
    names: ['phone'],
  })
  test('a program authority on a connection in error', () => {
    const out = detectConsistency(
      base({
        connections: [conn('error')],
        programs: [program({ authority: { tools: [], connectors: ['c1'], read: [], write: [] } })],
      }),
    ).filter((f) => f.kind === 'connection-used-but-broken')
    expect(out).toHaveLength(1)
    expect(out[0]?.severity).toBe('medium')
    expect(out[0]?.explanation).toContain('in error')
  })
  test('an order needing a deleted connection; one that works is quiet', () => {
    const o = order({ needs: ['phone/phone-2'] })
    const gone = detectConsistency(
      base({ connections: [conn('connected')], orders: [{ agentId: 'a1', order: o }] }),
    )
    expect(gone.map((f) => f.kind)).toEqual(['connection-used-but-broken'])
    const ok = detectConsistency(
      base({
        connections: [conn('connected')],
        orders: [{ agentId: 'a1', order: order({ needs: ['phone/phone'] }) }],
      }),
    )
    expect(ok).toEqual([])
  })
  test('only an explicit enablement of a broken connection counts', () => {
    const mk = (explicit: boolean) =>
      kinds(
        base({
          connections: [conn('needs-auth')],
          agentConnections: new Map([
            [
              'a1',
              [{ connectionId: 'c1', label: 'Phone', status: 'needs-auth' as const, explicit }],
            ],
          ]),
        }),
      )
    expect(mk(true)).toEqual(['connection-used-but-broken'])
    expect(mk(false)).toEqual([])
  })
})

describe('memory', () => {
  const tools = new Map([
    [
      'a1',
      {
        available: ['phone_screenshot', 'phone_tap', 'phone_list_devices', 'web_fetch'],
        prefixes: ['phone'],
      },
    ],
  ])

  test('tools of a deleted connection (production shape)', () => {
    const out = detectConsistency(
      base({
        tools,
        memory: [
          mem(
            'phone-rules.md',
            'Notes\n\nOnly phone-2_* tools can drive the phone. Use `phone-2_screenshot` first.\nThen phone_tap is fine.',
          ),
        ],
      }),
    ).filter((f) => f.kind === 'memory-dead-ref')
    expect(out.map((f) => f.line)).toEqual([3, 3])
    expect(out[0]?.memoryPath).toBe('phone-rules.md')
    expect(out[0]?.fix).toContain('line 3')
  })

  test('a tool under a live prefix that is not offered any more', () => {
    const out = detectConsistency(
      base({ tools, memory: [mem('x.md', 'Call phone_old_gesture to swipe, then phone_tap.')] }),
    )
    expect(out.map((f) => f.kind)).toEqual(['memory-dead-ref'])
    expect(out[0]?.explanation).toContain('phone_old_gesture')
  })

  test('ordinary snake case and prose are never flagged', () => {
    const text =
      'Use the run_python tool and read_file. The follow_up list lives in my_notes, see web_fetch and phone_list_devices. We reply to every_customer within a day. Max-retries_count is 3.'
    expect(kinds(base({ tools, memory: [mem('prose.md', text)] }))).toEqual([])
  })

  test('dead ids need a context word; device ids and living ids are left alone', () => {
    const text = [
      `Use the programs ${U2}, ${U3} for follow-up.`,
      `Device id: ${U4}`,
      `Program ${U1} is the real one.`,
    ].join('\n')
    expect(deadIdsIn(text, new Set([U1])).map((d) => d.id)).toEqual([U2, U3])
    const heading = `## Programs\n- ${U2}`
    expect(deadIdsIn(heading, new Set()).map((d) => d.id)).toEqual([U2])
  })

  test('placeholders', () => {
    const out = detectConsistency(
      base({
        memory: [
          mem('follow-up.md', 'Program\nid: <isi setelah approve>\nOwner: TBD\nTODO: add the list'),
        ],
      }),
    ).filter((f) => f.kind === 'memory-placeholder')
    expect(out).toHaveLength(1)
    expect(out[0]?.line).toBe(2)
    expect(out[0]?.explanation).toContain('2 more')
    for (const ok of [
      'The todo list tool is useful.',
      'to be decided by the owner later',
      'Use <b>bold</b>',
    ]) {
      expect(kinds(base({ memory: [mem('ok.md', ok)] }))).toEqual([])
    }
  })

  test('system state (production shape) and the stale "cannot amend" claim', () => {
    const out = detectConsistency(
      base({
        memory: [
          mem(
            'status.md',
            'Telegram: NOT connected, topics "empty".\ndevice id: abc123\nStatus per 2026-01-02: ok\nThe platform does not support amending programs.',
          ),
        ],
      }),
    ).filter((f) => f.kind === 'memory-system-state')
    expect(out.map((f) => `${f.severity}:${f.line}`).sort()).toEqual(['low:1', 'medium:4'])
    expect(out.find((f) => f.severity === 'low')?.fix).toContain('channel_status')
    for (const ok of [
      'If the phone is connected, take a screenshot first.',
      'Ask the owner for the device before starting.',
      'Amend a program with propose_plan.',
    ]) {
      expect(kinds(base({ memory: [mem('ok.md', ok)] }))).toEqual([])
    }
  })

  test('fenced code is not judged for placeholders', () => {
    expect(kinds(base({ memory: [mem('t.md', '```\nid: <id>\n```')] }))).toEqual([])
  })

  test('two files on one topic: by name and by content', () => {
    expect(topicOfName('follow-up-pagi-program.md')).toBe(topicOfName('follow-up-pagi.md'))
    expect(topicOfName('rules-2026-01-02.md')).toBe(topicOfName('rules.md'))
    const out = detectConsistency(
      base({
        memory: [
          mem('follow-up-pagi.md', 'Morning follow up of open quotations.', NOW - 5 * DAY),
          mem('follow-up-pagi-program.md', 'Different words entirely here.', NOW - DAY),
        ],
      }),
    ).filter((f) => f.kind === 'memory-duplicate-topic')
    expect(out).toHaveLength(1)
    expect(out[0]?.memoryPath).toBe('follow-up-pagi.md')
    expect(out[0]?.fix).toContain('delete follow-up-pagi.md')

    const body =
      'quotation supplier invoice approval reminder customer shipping warehouse payment contract discount'
    const byContent = detectConsistency(
      base({ memory: [mem('a.md', body), mem('b.md', `${body} extra`)] }),
    ).filter((f) => f.kind === 'memory-duplicate-topic')
    expect(byContent).toHaveLength(1)
    // unrelated files and short files are fine
    expect(
      kinds(
        base({
          memory: [
            mem('a.md', body),
            mem('b.md', 'meeting rooms catalog parking building access cafeteria schedule vendors'),
            mem('c.md', 'short'),
            mem('d.md', 'short'),
          ],
        }),
      ),
    ).toEqual([])
  })

  test('fingerprints are stable and findings are deduplicated', () => {
    const input = base({ memory: [mem('f.md', 'id: <isi>\n')] })
    const a = detectConsistency(input)
    const b = detectConsistency(input)
    expect(a.map((f) => f.fingerprint)).toEqual(b.map((f) => f.fingerprint))
    expect(new Set(a.map((f) => f.fingerprint)).size).toBe(a.length)
  })
})
