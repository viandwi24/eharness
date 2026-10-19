/**
 * The two gates extracted from the agent factory (`infra/eh/gates/*`): the closed-world authority of
 * a program run and the fixed authority of a heartbeat beat. Table-driven, no model, no server.
 */
import { describe, expect, test } from 'bun:test'
import type { ActivatedConnectors } from 'eharness/connectors'
import { agentMemory } from '../src/domain/memory.ts'
import { PROGRAM_BASE_TOOLS, type Program } from '../src/domain/programs.ts'
import { createHeartbeatGate } from '../src/infra/eh/gates/heartbeat-gate.ts'
import { createProgramGate } from '../src/infra/eh/gates/program-gate.ts'

const outOf = (
  tools: Record<string, string> = {},
  deny: string[] = [],
  toolKinds: Record<string, unknown> = {},
): ActivatedConnectors =>
  ({
    toolNameMap: Object.fromEntries(
      Object.entries(tools).map(([name, connectorId]) => [
        name,
        { connectorId, connectionIds: [`${connectorId}-1`] },
      ]),
    ),
    connections: [],
    rules: { allow: [], ask: [], deny, toolKinds, pinnedAsk: [] },
  }) as unknown as ActivatedConnectors

const programOf = (over: {
  tools?: string[]
  connectors?: string[]
  read?: string[]
  write?: string[]
  forbidden?: string[]
}): Program =>
  ({
    id: 'p1',
    name: 'Weekly report',
    authority: {
      tools: over.tools ?? [],
      connectors: over.connectors ?? [],
      read: over.read ?? [],
      write: over.write ?? [],
    },
    forbidden: over.forbidden ?? [],
    worker: null,
  }) as unknown as Program

const gateFor = (program: Program | undefined, out = outOf()) =>
  createProgramGate({
    programId: 'p1',
    out,
    programs: { get: () => program },
  })

const call = (toolName: string, input: unknown = {}) => ({ toolName, input })

describe('program gate', () => {
  test.each([
    ['granted tool', { tools: ['web_fetch'] }, 'web_fetch', true],
    ['tool never granted', { tools: ['web_fetch'] }, 'send_email', false],
    ['unknown tool', {}, 'no_such_tool', false],
    ['base tool is always allowed', {}, PROGRAM_BASE_TOOLS[0] as string, true],
  ])('%s', (_name, authority, tool, allowed) => {
    const gate = gateFor(programOf(authority))
    const reason = gate.refuse(call(tool))
    if (allowed) expect(reason).toBeUndefined()
    else expect(reason).toContain(`Outside the authority of program "Weekly report": ${tool}`)
  })

  test('a connector grant allows every tool of the connector, others stay refused', () => {
    const gate = gateFor(
      programOf({ connectors: ['crm'] }),
      outOf({ crm_lookup: 'crm', mail_send: 'mail' }),
    )
    expect(gate.refuse(call('crm_lookup'))).toBeUndefined()
    expect(gate.refuse(call('mail_send'))).toContain('mail_send')
  })

  test('forbidden wins over a grant', () => {
    const gate = gateFor(programOf({ tools: ['web_fetch'], forbidden: ['web_fetch'] }))
    expect(gate.refuse(call('web_fetch'))).toContain('Forbidden by program "Weekly report"')
  })

  test('a tool granted by connector AND forbidden is refused (forbidden)', () => {
    const gate = gateFor(
      programOf({ connectors: ['crm'], forbidden: ['crm_delete'] }),
      outOf({ crm_lookup: 'crm', crm_delete: 'crm' }),
    )
    expect(gate.rules.allow).toContain('crm_delete')
    expect(gate.rules.deny).toContain('crm_delete')
    expect(gate.refuse(call('crm_delete'))).toContain('Forbidden by program')
    expect(gate.refuse(call('crm_lookup'))).toBeUndefined()
  })

  test('a deleted program grants nothing, not even a tool it had', () => {
    let program: Program | undefined = programOf({ tools: ['web_fetch'] })
    const gate = createProgramGate({
      programId: 'p1',
      out: outOf(),
      programs: { get: () => program },
    })
    expect(gate.refuse(call('web_fetch'))).toBeUndefined()
    program = undefined
    expect(gate.refuse(call('web_fetch'))).toContain('web_fetch')
    expect(gate.rules.allow.length).toBeGreaterThan(0) // snapshot at creation
  })

  test('rules are read from the program on every call (an amendment widens a live run)', () => {
    let program = programOf({})
    const gate = createProgramGate({
      programId: 'p1',
      out: outOf(),
      programs: { get: () => program },
    })
    expect(gate.refuse(call('web_fetch'))).toBeDefined()
    program = programOf({ tools: ['web_fetch'] })
    expect(gate.refuse(call('web_fetch'))).toBeUndefined()
  })

  test('askedReason names the program', () => {
    expect(gateFor(programOf({})).askedReason('web_fetch')).toContain('Weekly report')
  })

  test('sync teaches the engine the current rules at session scope', async () => {
    const added: string[] = []
    const gate = gateFor(programOf({ tools: ['web_fetch'], forbidden: ['send_email'] }))
    await gate.sync?.({
      addRule: async (polarity: string, rule: string, scope: string) => {
        added.push(`${polarity}:${rule}:${scope}`)
      },
    } as never)
    expect(added).toContain('allow:web_fetch:session')
    expect(added).toContain('deny:send_email:session')
  })
})

// --- heartbeat ------------------------------------------------------------------------------------

const DEST = { connectionId: 'tg-1', nodeId: 'chat-1' }

function beat(
  opts: {
    allowed?: (typeof DEST)[]
    grants?: { needs: string[]; writes: string[] }
    fixing?: boolean
    readCheck?: string | undefined
    postPrivacy?: string | undefined
    reservePost?: string | undefined
    out?: ActivatedConnectors
    kinds?: Record<string, string>
  } = {},
) {
  const gateway = {
    connectionsOf: () => [{ connectionId: 'tg-1', platform: 'telegram', connected: true }],
    resolveTarget: (_a: string, _s: string, t: { connection?: string; conversation?: string }) => {
      if (t.conversation === 'unknown') throw new Error('No such chat.')
      return {
        config: { connectionId: t.connection ?? 'tg-1' },
        node: { id: t.conversation ?? 'chat-1' },
      }
    },
    nodeOf: (_c: string, chat: string) =>
      chat === 'chat-1' || chat === 'dm-1'
        ? { id: chat, title: chat, nativeId: chat, kind: chat === 'dm-1' ? 'direct' : 'group' }
        : undefined,
    nodes: { chain: () => [] },
  }
  const hb = {
    allowed: () => opts.allowed ?? [DEST],
    grants: () => opts.grants ?? { needs: [], writes: [] },
    memoryFix: () => opts.fixing === true,
    readCheck: () => opts.readCheck,
    postPrivacy: () => opts.postPrivacy,
    reservePost: () => opts.reservePost,
  }
  return createHeartbeatGate({
    agentId: 'a1',
    sessionId: 's1',
    out: opts.out ?? outOf({ write_file: 'files', edit_file: 'files', memory_view: 'memory' }),
    connectors: {
      toolKinds: () => opts.kinds ?? {},
      definitions: [
        { id: 'files', source: 'builtin' },
        { id: 'crm', source: 'mcp' },
      ],
    } as never,
    heartbeat: (() => hb) as never,
    channels: (() => gateway) as never,
  })
}

const sendInput = (over: Record<string, unknown> = {}) => ({
  action: 'send',
  connection: 'tg-1',
  conversation: 'chat-1',
  text: 'hello',
  ...over,
})
const NOT_AVAILABLE = 'Not available in a heartbeat'

describe('heartbeat gate', () => {
  test('reads of the library and the fixed tools go through', () => {
    const gate = beat()
    expect(gate.refuse(call('team_status'))).toBeUndefined()
    expect(gate.refuse(call('list_tasks'))).toBeUndefined()
  })

  test('unknown or write tools are refused as read-only', () => {
    const gate = beat()
    for (const tool of ['send_email', 'shell', 'no_such_tool', 'delete_file']) {
      expect(gate.refuse(call(tool))).toContain(NOT_AVAILABLE)
    }
    expect(gate.askedReason('x')).toContain(NOT_AVAILABLE)
  })

  test('the allow rules never include writes the agent does not have', () => {
    expect(beat().rules.allow).toContain('channel_send')
    expect(beat({ out: outOf({}) }).rules.allow).not.toContain('write_file')
    expect(beat().rules.deny).toEqual([])
  })

  describe('post to a standing order chat', () => {
    test.each([
      ['to the order chat', {}, {}, undefined],
      ['no order reports to a chat', {}, { allowed: [] }, NOT_AVAILABLE],
      ['reply is not a new message', { action: 'reply' }, {}, NOT_AVAILABLE],
      ['to a member', { member: 'x' }, {}, NOT_AVAILABLE],
      ['to a chat that is not an order destination', { conversation: 'chat-2' }, {}, 'Not posted'],
      ['to an unresolvable chat', { conversation: 'unknown' }, {}, 'Not posted'],
      ['empty text', { text: '  ' }, {}, 'Not posted: send needs text.'],
      ['privacy: DM content into a group', {}, { postPrivacy: 'NO-PRIVACY' }, 'NO-PRIVACY'],
      ['over the daily cap', {}, { reservePost: 'CAP-REACHED' }, 'CAP-REACHED'],
    ] as const)('%s', (_name, input, opts, expected) => {
      const reason = beat(opts as never).refuse(call('channel_send', sendInput(input)))
      if (expected === undefined) expect(reason).toBeUndefined()
      else expect(reason).toContain(expected)
    })
  })

  describe('chat content reads (privacy scope)', () => {
    test('must name a chat', () => {
      expect(beat().refuse(call('chat_history', {}))).toContain('must name the chat')
    })
    test('a chat that is not ingested', () => {
      expect(beat().refuse(call('chat_history', { chat: 'nope' }))).toContain('not a chat I ingest')
    })
    test('the scope check decides (refusal and allowed)', () => {
      expect(
        beat({ readCheck: 'OUT-OF-SCOPE' }).refuse(call('chat_history', { chat: 'chat-1' })),
      ).toBe('OUT-OF-SCOPE')
      expect(beat().refuse(call('chat_history', { chat: 'dm-1' }))).toBeUndefined()
    })
    test('a download of channel_read is refused (it writes a file)', () => {
      expect(beat().refuse(call('channel_read', { action: 'download', chat: 'chat-1' }))).toContain(
        NOT_AVAILABLE,
      )
    })
  })

  describe('memory', () => {
    const own = agentMemory('a1')
    test.each([
      ['view own folder', 'memory_view', { path: `${own}/notes.md` }, false, undefined],
      ['view another agent', 'memory_view', { path: '/memories/other/x.md' }, false, 'own folder'],
      ['edit without findings', 'memory_create', { path: `${own}/x.md` }, false, NOT_AVAILABLE],
      ['edit own folder with findings', 'memory_create', { path: `${own}/x.md` }, true, undefined],
      [
        'edit outside with findings',
        'memory_create',
        { path: '/memories/other/x.md' },
        true,
        'own folder',
      ],
      ['edit escaping with ..', 'memory_create', { path: `${own}/../x.md` }, true, 'own folder'],
      ['edit HEARTBEAT.md', 'memory_create', { path: `${own}/HEARTBEAT.md` }, true, 'HEARTBEAT.md'],
    ] as const)('%s', (_name, tool, input, fixing, expected) => {
      const gate = beat({ fixing, out: outOf({ memory_view: 'memory', memory_create: 'memory' }) })
      const reason = gate.refuse(call(tool, input))
      if (expected === undefined) expect(reason).toBeUndefined()
      else expect(reason).toContain(expected)
    })

    test('a memory tool the agent has denied is refused as read-only', () => {
      const out = outOf({ memory_view: 'memory', memory_create: 'memory' }, ['memory_create'])
      expect(
        beat({ fixing: true, out }).refuse(call('memory_create', { path: `${own}/x` })),
      ).toContain(NOT_AVAILABLE)
    })
  })

  describe('ledger writes and tools opened by orders', () => {
    test('a file write only on a granted ledger path', () => {
      const gate = beat({ grants: { needs: [], writes: [] } })
      expect(
        gate.refuse(call('write_file', { file_path: '/library/x.md', content: '' })),
      ).toBeDefined()
    })
    test('a denied file write tool is refused as read-only', () => {
      const out = outOf({ write_file: 'files' }, ['write_file'])
      expect(beat({ out }).refuse(call('write_file', {}))).toContain(NOT_AVAILABLE)
    })
    test('a read-only third-party tool is a lookup, a write one needs a live order', () => {
      const out = outOf({ crm_get: 'crm', crm_set: 'crm' })
      const gate = beat({ out, kinds: { crm_get: 'read', crm_set: 'write' } })
      expect(gate.rules.allow).toContain('crm_get')
      expect(gate.refuse(call('crm_get'))).toBeUndefined()
      expect(gate.refuse(call('crm_set'))).toContain(NOT_AVAILABLE)
    })
  })
})
