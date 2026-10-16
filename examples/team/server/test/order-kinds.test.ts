/**
 * Order kinds, exact deadline wakes, tools that follow the orders, factual notes, order hygiene and
 * the weekly review (docs/plans/P52-context-and-orders.md, part 2). Scripted models and a mock chat
 * adapter only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { appendNote, setHeartbeat } from '../src/app/heartbeat.ts'
import {
  appendPattern,
  hygieneFindings,
  raiseConflicts,
  weeklyReview,
} from '../src/app/order-care.ts'
import { addOrder, completeOrder, listOrders, removeOrder } from '../src/app/standing-orders.ts'
import {
  beatPrompt,
  checklistPath,
  heartbeatKey,
  ledgerWriteRefusal,
  notesPath,
  orderKey,
  parseSystemKey,
} from '../src/domain/heartbeat.ts'
import { checkNoteEvidence, checkPattern, markUnresolved } from '../src/domain/heartbeat-notes.ts'
import { orderHygiene, retireCandidates } from '../src/domain/order-hygiene.ts'
import {
  formatOrderLine,
  grantsOf,
  needTools,
  normalizeNeeds,
  orderState,
  parseChecklist,
  parseOrderLine,
  type StandingOrder,
  type ToolFact,
} from '../src/domain/standing-orders.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import { resolveOrderTime } from '../src/infra/eh/order-due.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
let n = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `k-${toolName}-${++n}` }],
})
const final = (status: 'ok' | 'attention' = 'ok'): ScriptedStepInput =>
  call('final_answer', { status, items: [] })

const NOW = Date.UTC(2026, 9, 16, 5, 0) // Fri 2026-10-16 05:00 UTC
const HOUR = 3_600_000
const DAY = 24 * HOUR

const order = (over: Partial<StandingOrder> = {}): StandingOrder => ({
  id: 'o1',
  text: 'Watch the YouTube channel and report anomalies',
  by: 'ident-1',
  name: 'Owen',
  role: 'owner',
  uid: '1001',
  report: { kind: 'chat', connectionId: 'c1', nodeId: 'n1' },
  mention: true,
  at: NOW - DAY,
  active: true,
  kind: 'watch',
  refs: [],
  needs: [],
  ...over,
})

describe('the tail of an order line', () => {
  test('an old line (no kind) is a watch; new fields round-trip, percent-encoded', () => {
    const old =
      '- Pantau channel. <!-- order:a by:ident-1 name:Ana role:admin uid:1 report:chat:c1/n1 mention:yes at:5 -->'
    expect(parseOrderLine(old)).toMatchObject({ kind: 'watch', refs: [], needs: [] })
    expect(parseOrderLine(old)?.due).toBeUndefined()
    // a plain watch keeps the short tail
    expect(formatOrderLine(order())).not.toContain('kind:')
    const full = order({
      kind: 'deadline',
      due: NOW + HOUR,
      expires: NOW + DAY,
      refs: ['General #12345', 'dm:abc'],
      needs: ['web', 'phone/hp-owen', 'files:/library/audit/**'],
      ledger: '/library/trackers/ihsg.md',
      done: { at: NOW + 2 * HOUR, outcome: 'video was up --> recorded' },
    })
    const line = formatOrderLine(full)
    expect(line).not.toContain('--> recorded')
    expect(parseOrderLine(line)).toEqual(full)
    const parsed = parseChecklist(`${line}\n`, NOW)
    expect(parsed.orders[0]?.kind).toBe('deadline')
    expect(parsed.active).toEqual([]) // done
  })

  test('done and expired orders are not active and not "something to watch"', () => {
    expect(orderState(order({ expires: NOW - 1 }), NOW)).toBe('expired')
    expect(orderState(order({ expires: NOW + 1 }), NOW)).toBe('active')
    expect(orderState(order({ active: false }), NOW)).toBe('paused')
    expect(orderState(order({ done: { at: NOW, outcome: 'x' } }), NOW)).toBe('done')
    const text = `${formatOrderLine(order({ expires: NOW - 1 }))}\n`
    expect(parseChecklist(text, NOW).active).toEqual([])
    expect(parseChecklist(text).active).toHaveLength(1) // no clock, no expiry check
  })

  test('needs are validated and normalised', () => {
    expect(normalizeNeeds(['web', 'web', 'browser', 'phone/hp-1', 'files:/library/a/**'])).toEqual({
      needs: ['web', 'browser', 'phone/hp-1', 'files:/library/a/**'],
      invalid: [],
    })
    expect(
      normalizeNeeds(['phone', 'files:/etc/passwd', 'files:/library/../x', 'camera']).invalid,
    ).toHaveLength(4)
  })

  test('natural times resolve in the team timezone', () => {
    const jkt = 'Asia/Jakarta'
    expect(resolveOrderTime('2026-10-16 12:00', jkt, NOW)).toEqual({
      at: Date.UTC(2026, 9, 16, 5, 0),
    })
    expect(resolveOrderTime('today 15:00', jkt, NOW)).toEqual({ at: Date.UTC(2026, 9, 16, 8, 0) })
    expect(resolveOrderTime('tomorrow 09:00', jkt, NOW)).toEqual({
      at: Date.UTC(2026, 9, 17, 2, 0),
    })
    // 11:00 Jakarta has not come yet at 12:00 Jakarta: the next time the clock shows it
    expect(resolveOrderTime('11:00', jkt, NOW)).toEqual({ at: Date.UTC(2026, 9, 17, 4, 0) })
    expect(resolveOrderTime('in 90 minutes', jkt, NOW)).toEqual({ at: NOW + 90 * 60_000 })
    expect(resolveOrderTime('Friday noon', jkt, NOW)).toHaveProperty('error')
  })
})

describe('tools follow the orders', () => {
  const tools: ToolFact[] = [
    { name: 'web_fetch', connectorId: 'web', connectionSlugs: ['web'], kind: 'read' },
    {
      name: 'browser_snapshot',
      connectorId: 'browser',
      connectionSlugs: ['browser'],
      kind: 'read',
    },
    { name: 'browser_act', connectorId: 'browser', connectionSlugs: ['browser'], kind: 'external' },
    { name: 'phone_screenshot', connectorId: 'mcp', connectionSlugs: ['hp-owen'], kind: 'read' },
    { name: 'phone_tap', connectorId: 'mcp', connectionSlugs: ['hp-owen'], kind: 'write' },
    { name: 'other_tool', connectorId: 'mcp', connectionSlugs: ['other'], kind: 'read' },
  ]
  const none = { deny: [], ask: [] }
  test('a need opens only its own tools; acts follow the connector mode', () => {
    expect(needTools(['web'], tools, none)).toEqual(['web_fetch'])
    expect(needTools(['browser'], tools, none)).toEqual(['browser_snapshot', 'browser_act'])
    // "ask first" cannot be answered in a beat; "off" is off
    expect(needTools(['browser'], tools, { deny: [], ask: ['browser_act'] })).toEqual([
      'browser_snapshot',
    ])
    expect(needTools(['browser'], tools, { deny: ['browser_snapshot'], ask: [] })).toEqual([
      'browser_act',
    ])
    expect(needTools(['phone/hp-owen'], tools, none)).toEqual(['phone_screenshot', 'phone_tap'])
    expect(needTools(['phone/nobody'], tools, none)).toEqual([])
    expect(needTools(['files:/library/a/**'], tools, none)).toEqual([])
  })

  test('only orders of an owner or admin (today) grant tools and a ledger', () => {
    const orders = [
      order({ id: 'a', needs: ['web'], ledger: '/library/trackers/a.md' }),
      order({ id: 'b', role: 'member', needs: ['browser'], ledger: '/library/trackers/b.md' }),
      order({ id: 'c', needs: ['phone/hp-owen'], expires: NOW - 1 }),
      order({ id: 'd', needs: ['browser'], ledger: '/library/trackers/d.md' }),
    ]
    const role = (o: StandingOrder): string | undefined => (o.id === 'd' ? 'member' : o.role)
    expect(grantsOf(orders, role, NOW)).toEqual({
      needs: ['web'],
      writes: ['/library/trackers/a.md'],
    })
  })

  test('file writes only to a ledger path, never a delete', () => {
    const writes = ['/library/trackers/a.md']
    expect(
      ledgerWriteRefusal(
        { toolName: 'write_file', input: { path: '/library/trackers/a.md' } },
        writes,
      ),
    ).toBeUndefined()
    expect(
      ledgerWriteRefusal({ toolName: 'edit_file', input: { path: '/library/other.md' } }, writes),
    ).toContain('only the ledger')
    expect(
      ledgerWriteRefusal({ toolName: 'write_file', input: { path: '/library/trackers/a.md' } }, []),
    ).toContain('No standing order')
    expect(
      ledgerWriteRefusal(
        { toolName: 'delete_file', input: { path: '/library/trackers/a.md' } },
        writes,
      ),
    ).toContain('never deletes')
  })

  test('the beat rubric names the sensitive acts, and a focused deadline beat is about one order', () => {
    const o = order({
      id: 'dl',
      kind: 'deadline',
      due: NOW,
      refs: ['General #12345'],
      needs: ['web'],
    })
    const text = beatPrompt({
      now: NOW,
      timezone: 'UTC',
      plain: ['my own item'],
      agentName: 'Scout',
      trigger: 'deadline',
      focus: 'dl',
      orders: [
        {
          order: o,
          label: 'General',
          postsLeft: 8,
          granted: { tools: ['web_fetch'], missing: [], ledger: false },
        },
      ],
    })
    expect(text).toContain('This beat is for ONE order')
    expect(text).toContain('its time has come')
    expect(text).toContain('Removing, kicking or banning anyone is never yours')
    expect(text).toContain('heartbeat_order_done')
    expect(text).toContain('tools you may use: web_fetch')
    expect(text).toContain('General #12345')
    expect(text).not.toContain('my own item')
  })
})

describe('factual notes', () => {
  test('a note needs evidence and a confidence', () => {
    expect(checkNoteEvidence({ chat: 'General', noticed: 'x' } as never)).toContain('confidence')
    expect(checkNoteEvidence({ chat: 'General', confidence: 'seen' })).toContain(
      'at least one piece of evidence',
    )
    expect(
      checkNoteEvidence({ chat: 'General', confidence: 'maybe', messageIds: ['1'] }),
    ).toContain('confidence')
    expect(
      checkNoteEvidence({ chat: 'General', confidence: 'seen', evidence: ['I saw it'] }),
    ).toContain('not an evidence reference')
    expect(
      checkNoteEvidence({ chat: 'General', confidence: 'seen', messageIds: ['12345'] }),
    ).toBeUndefined()
    expect(
      checkNoteEvidence({
        chat: 'General',
        confidence: 'inferred',
        evidence: ['https://youtube.com/@x'],
      }),
    ).toBeUndefined()
    expect(
      checkNoteEvidence({
        chat: 'G',
        confidence: 'seen',
        evidence: ['/library/a.md', 'session:dm:a#m1'],
      }),
    ).toBeUndefined()
  })

  test('references that no longer resolve are marked when notes are read', () => {
    const line =
      '- 10:00 [G]: saw it (note, seen; ev: /library/a.md, /library/gone.md, session:dm:gone#m1)'
    const out = markUnresolved(line, {
      library: (p) => p === '/library/a.md',
      session: () => false,
    })
    expect(out).toContain('[no longer resolves: /library/gone.md, session:dm:gone]')
    expect(markUnresolved(line, { library: () => true, session: () => true })).toBe(line)
  })

  test('a pattern is confirmed only with notes on at least two days', () => {
    const have = new Set(['2026-10-12', '2026-10-13'])
    expect(checkPattern({ pattern: 'p', days: ['2026-10-12'], haveNotes: have })).toContain(
      'at least 2 different days',
    )
    expect(
      checkPattern({ pattern: 'p', days: ['2026-10-12', '2026-10-12'], haveNotes: have }),
    ).toContain('at least 2')
    expect(
      checkPattern({ pattern: 'p', days: ['2026-10-12', '2026-10-20'], haveNotes: have }),
    ).toContain('at least 2')
    expect(
      checkPattern({ pattern: 'p', days: ['2026-10-12', '2026-10-13'], haveNotes: have }),
    ).toBeUndefined()
  })
})

describe('order hygiene', () => {
  const base = {
    now: NOW,
    destinationExists: () => true,
    giverRole: (o: StandingOrder) => o.role,
  }
  test('gone destination, gone or demoted giver, expired, overdue', () => {
    const found = orderHygiene({
      ...base,
      orders: [
        order({
          id: 'dest',
          text: 'Alpha uploads rhythm',
          report: { kind: 'chat', connectionId: 'c1', nodeId: 'gone' },
        }),
        order({ id: 'gone', by: 'ident-2', text: 'Bravo community spam' }),
        order({ id: 'demoted', by: 'ident-3', text: 'Charlie broker screenshots' }),
        order({ id: 'exp', expires: NOW - 1, text: 'Delta weekly summary' }),
        order({ id: 'late', kind: 'deadline', due: NOW - 3 * HOUR, text: 'Echo analysis video' }),
        order({
          id: 'done',
          kind: 'deadline',
          due: NOW - 9 * HOUR,
          done: { at: NOW - 8 * HOUR, outcome: 'ok' },
        }),
      ],
      destinationExists: (d) => d.kind !== 'chat' || d.nodeId !== 'gone',
      giverRole: (o) => (o.id === 'gone' ? undefined : o.id === 'demoted' ? 'member' : o.role),
    })
    const kinds = found.map((f) => `${f.kind}:${f.orderIds.join('+')}`).sort()
    expect(kinds).toEqual([
      'destination-gone:dest',
      'expired:exp',
      'giver-gone:gone',
      'giver-not-staff:demoted',
      'overdue:late',
    ])
  })

  test('nearly the same order for different places or from different givers overlaps', () => {
    const text =
      'Report upload anomalies, early views and live sessions of YouTube channel AcmeAcademy'
    const a = order({ id: 'a', text })
    const b = order({
      id: 'b',
      text: 'Report upload anomalies, views and live sessions of YouTube channel AcmeAcademy',
      report: { kind: 'chat', connectionId: 'c1', nodeId: 'n2' },
    })
    const c = order({ id: 'c', by: 'ident-9', text })
    const d = order({ id: 'd', text: 'Kick spammers from the community group' })
    const found = orderHygiene({ ...base, orders: [a, b, c, d] })
    const pairs = found.filter((f) => f.kind === 'conflict').map((f) => f.orderIds.join('+'))
    expect(pairs).toEqual(['a+b', 'a+c', 'b+c'])
    // a few shared words are not a conflict (production: a YouTube watch and a leave ledger of the
    // same giver were flagged on "awal, tito, info, catat")
    const yt = order({
      id: 'yt',
      name: 'Tito',
      text: 'Pantau akun YouTube Academy: video baru, irama upload, views awal, live; kalau janggal laporkan ke Sir Tito',
    })
    const leave = order({
      id: 'leave',
      name: 'Tito',
      kind: 'ledger',
      text: 'Anggota tim info izin, sakit, atau pulang lebih awal: catat tanggal dan alasannya, info ke Sir Tito',
      report: { kind: 'chat', connectionId: 'c1', nodeId: 'n2' },
    })
    expect(
      orderHygiene({ ...base, orders: [yt, leave] }).filter((f) => f.kind === 'conflict'),
    ).toEqual([])
    // same place and same giver: just two ways of saying the same thing, no conflict
    expect(orderHygiene({ ...base, orders: [a, { ...a, id: 'a2' }] })).toEqual([])
  })

  test('the weekly review proposes retiring, never removes', () => {
    const fired = { fresh: { count: 2, lastAt: NOW } }
    const c = retireCandidates({
      now: NOW,
      fired,
      orders: [
        order({ id: 'quiet', at: NOW - 20 * DAY }),
        order({ id: 'fresh', at: NOW - 20 * DAY }),
        order({ id: 'young', at: NOW - 2 * DAY }),
        order({ id: 'dl', kind: 'deadline', due: NOW - 2 * DAY }),
        order({
          id: 'old-done',
          kind: 'deadline',
          due: NOW - 9 * DAY,
          done: { at: NOW - 8 * DAY, outcome: 'x' },
        }),
      ],
    })
    expect(c.map((x) => x.order.id).sort()).toEqual(['dl', 'old-done', 'quiet'])
  })
})

// --- with a server ---------------------------------------------------------------------------------

interface Instance {
  server: Server
  model: ScriptedModel
  agentId: string
  slug: string
}
function instance(steps: ScriptedStepInput[]): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-ok-'))
  dirs.push(dir)
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) =>
      id === 'm-agent'
        ? model
        : scriptedModel([
            () => {
              throw new Error(`unexpected model call: ${id}`)
            },
          ]),
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'ok-test',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    heartbeat: { activitySettleMs: 20 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-agent' })
  return { server, model, agentId: def.id, slug: def.slug }
}
async function connect(i: Instance): Promise<{ mock: MockAdapter; internal: string }> {
  const gw = i.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: i.agentId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const internal = gw.settings.ensureNode('c1', {
    nativeId: 'internal',
    kind: 'room',
    title: 'Internal',
  })
  gw.settings.set(internal.id, {
    enabled: true,
    ack: false,
    proactive: { allowed: true, digest: false },
  } as never)
  const mock = createMockAdapter({ connectionId: 'c1' })
  await gw.register(mock)
  return { mock, internal: internal.id }
}
const sessionText = async (i: Instance): Promise<string> =>
  JSON.stringify(await i.server.factory.peek(`heartbeat:${i.agentId}`).messages({ limit: 100 }))
const input = (
  i: Instance,
  report: StandingOrder['report'],
  over: Record<string, unknown> = {},
) => ({
  text: 'Check whether the IHSG analysis video is up; if not, record it and report to me',
  by: 'ident-1',
  name: 'Owen',
  role: 'owner',
  uid: '1001',
  report,
  mention: true,
  ...over,
})

describe('deadline orders', () => {
  test('add with kind, due, refs, needs; list; the exact wake fires once and the order ends with an outcome', async () => {
    const i = instance([final('ok')])
    const rooms = await connect(i)
    const deps = i.server.deps
    const now = Date.now()
    const due = now + 10 * 60_000
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }

    // validation: a deadline needs a future due; needs and ledger are checked
    await expect(addOrder(deps, i.agentId, input(i, dest, { kind: 'deadline' }))).rejects.toThrow(
      /needs due/,
    )
    await expect(
      addOrder(deps, i.agentId, input(i, dest, { kind: 'deadline', due: now - 1 })),
    ).rejects.toThrow(/past/)
    await expect(addOrder(deps, i.agentId, input(i, dest, { needs: ['camera'] }))).rejects.toThrow(
      /unknown need/,
    )
    await expect(addOrder(deps, i.agentId, input(i, dest, { ledger: '/etc/x' }))).rejects.toThrow(
      /ledger must/,
    )

    const added = await addOrder(
      deps,
      i.agentId,
      input(i, dest, {
        kind: 'deadline',
        due,
        expires: due + DAY,
        refs: ['General #12345'],
        needs: ['web', 'browser'],
        ledger: '/library/audit/team-audit.md',
      }),
    )
    expect(added.created).toBe(true)
    const [stored] = await listOrders(deps, i.agentId)
    expect(stored).toMatchObject({
      kind: 'deadline',
      due,
      refs: ['General #12345'],
      needs: ['web', 'browser'],
      ledger: '/library/audit/team-audit.md',
    })

    // the wake: one routine at `due`, fires once
    const key = orderKey(i.agentId, added.order.id)
    expect(parseSystemKey(key)).toEqual({
      kind: 'order',
      agentId: i.agentId,
      orderId: added.order.id,
    })
    const wake = deps.routines.getByProgram(key)
    expect(wake).toMatchObject({ schedule: { kind: 'at', at: due }, maxFires: 1, nextFireAt: due })
    expect(deps.routines.getByProgram(heartbeatKey(i.agentId))).toBeDefined()

    // before the time nothing fires for it; at the time one focused beat runs
    await i.server.routines.tick(due - 5 * 60_000)
    expect(i.model.calls).toHaveLength(0)
    await i.server.routines.tick(due + 1_000)
    await i.server.heartbeats.idle()
    await until('the deadline beat', () => i.model.calls.length >= 1)
    const text = await sessionText(i)
    expect(text).toContain('This beat is for ONE order')
    expect(text).toContain('its time has come')
    expect(text).toContain('General #12345')
    expect(text).toContain('/library/audit/team-audit.md')
    await i.server.routines.tick(due + 2 * 60_000)
    await i.server.heartbeats.idle()
    expect(i.model.calls).toHaveLength(1)

    // the outcome ends it: done in the file, no wake, no longer watched
    const done = await completeOrder(deps, i.agentId, added.order.id, 'The video was up; recorded.')
    expect(done?.done?.outcome).toBe('The video was up; recorded.')
    expect(deps.routines.getByProgram(key)).toBeUndefined()
    const file = (await deps.library.read(checklistPath(i.agentId)))?.text ?? ''
    expect(file).toContain('done:')
    expect(parseChecklist(file, Date.now()).active).toEqual([])
    const view = (await (await i.server.app.request(`/agents/${i.agentId}/heartbeat`)).json()) as {
      orders: Array<{ state: string }>
      checklist: { empty: boolean }
    }
    expect(view.orders[0]?.state).toBe('done')
    expect(view.checklist.empty).toBe(true)
  })

  test('an order past its expiry is inactive and listed as expired; removing an order drops its wake', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const deps = i.server.deps
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    const soon = await addOrder(
      deps,
      i.agentId,
      input(i, dest, { kind: 'deadline', due: Date.now() + HOUR, text: 'one' }),
    )
    expect(deps.routines.getByProgram(orderKey(i.agentId, soon.order.id))).toBeDefined()
    await removeOrder(deps, i.agentId, soon.order.id)
    expect(deps.routines.getByProgram(orderKey(i.agentId, soon.order.id))).toBeUndefined()
    // a hand-written expired order: not active, a hygiene finding, and no beat for it
    const past = order({ id: 'old', expires: Date.now() - 1000, report: dest })
    await deps.library.writeText(checklistPath(i.agentId), `${formatOrderLine(past)}\n`)
    const v = (await (await i.server.app.request(`/agents/${i.agentId}/heartbeat`)).json()) as {
      orders: Array<{ state: string }>
      hygiene: Array<{ kind: string }>
      checklist: { empty: boolean }
    }
    expect(v.orders[0]?.state).toBe('expired')
    expect(v.hygiene.map((h) => h.kind)).toContain('expired')
    expect(v.checklist.empty).toBe(true)
    expect(await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })).toMatchObject({
      started: false,
    })
    expect(i.model.calls).toHaveLength(0)
  })

  test('a ledger order gets a default tracker path; a kind of a member order cannot carry tools', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    const l = await addOrder(
      i.server.deps,
      i.agentId,
      input(i, dest, { kind: 'ledger', text: 'Video takes: record date and count' }),
    )
    expect(l.order.ledger).toMatch(/^\/library\/trackers\/video-takes-record-date-and-count\.md$/)
    const l2 = await addOrder(
      i.server.deps,
      i.agentId,
      input(i, dest, { kind: 'ledger', text: 'Video takes: record date and count', by: 'ident-2' }),
    )
    expect(l2.order.ledger).not.toBe(l.order.ledger)
  })
})

describe('the gate follows the orders', () => {
  test('web tools and the ledger only for an owner/admin order; other paths stay closed', async () => {
    const path = '/library/trackers/ihsg.md'
    const i = instance([
      call('web_fetch', { url: 'http://127.0.0.1:1/x' }),
      call('write_file', { path, content: '# ledger\n' }),
      call('write_file', { path: '/library/elsewhere.md', content: 'x' }),
      call('delete_file', { path }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await setHeartbeat(i.server.deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    await addOrder(
      i.server.deps,
      i.agentId,
      input(i, dest, {
        kind: 'ledger',
        needs: ['web'],
        ledger: path,
        by: 'web:owner',
        uid: undefined,
        mention: false,
      }),
    )
    const out = await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })
    expect(out).toMatchObject({ started: true })
    await i.server.heartbeats.idle()
    await until('the beat', () => i.model.calls.length >= 5)
    const text = await sessionText(i)
    expect(text.includes('No live standing order of an owner or an admin needs it')).toBe(false)
    expect(text).toContain('a beat may write only the ledger')
    expect(text).toContain('never deletes')
    expect((await i.server.deps.library.read(path))?.text).toContain('# ledger')
    expect(await i.server.deps.library.read('/library/elsewhere.md')).toBeUndefined()
  })

  test("the same calls are refused when the only order is a member's", async () => {
    const path = '/library/trackers/m.md'
    const i = instance([
      call('web_fetch', { url: 'http://127.0.0.1:1/x' }),
      call('write_file', { path, content: 'x' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await setHeartbeat(i.server.deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    await addOrder(i.server.deps, i.agentId, input(i, dest, { role: 'member', mention: false }))
    expect((await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })).started).toBe(
      true,
    )
    await i.server.heartbeats.idle()
    await until('the beat', () => i.model.calls.length >= 3)
    const text = await sessionText(i)
    expect(text).toContain('Not available in a heartbeat: web_fetch')
    expect(text).toContain('No standing order of an owner or an admin names a ledger')
    expect(await i.server.deps.library.read(path)).toBeUndefined()
  })
})

describe('notes, patterns and the weekly review', () => {
  test('appendNote refuses a note without evidence, writes the proof and the confidence', async () => {
    const i = instance([])
    const deps = i.server.deps
    const bad = await appendNote(deps, i.agentId, {
      chat: 'General',
      noticed: 'x',
      decision: 'note',
      confidence: 'seen',
    })
    expect(bad).toContain('Not noted')
    expect(await deps.library.read(notesPath(i.slug, '2026-01-01'))).toBeUndefined()
    const ok = await appendNote(deps, i.agentId, {
      chat: 'General',
      noticed: 'Arif uploaded the video',
      decision: 'note',
      confidence: 'seen',
      messageIds: ['12345'],
      evidence: ['https://www.youtube.com/watch?v=abc'],
    })
    expect(ok).toContain('Noted in')
    const path = ok.replace('Noted in ', '').replace(/\.$/, '')
    const text = (await deps.library.read(path))?.text ?? ''
    expect(text).toContain(
      'ids 12345: Arif uploaded the video (note, seen; ev: https://www.youtube.com/watch?v=abc)',
    )
  })

  test('the weekly review runs on the first beat of a Monday: asks the owners, removes nothing, writes only patterns with two days', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const deps = i.server.deps
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    const agent = deps.agents.getBySlug('lead')
    if (agent === undefined) throw new Error('seed')
    const monday = Date.UTC(2026, 9, 19, 10, 0)
    const tz = deps.settings.get().timezone
    expect(tz).toBeTruthy()
    // notes of two days of last week
    for (const day of ['2026-10-13', '2026-10-14'])
      await deps.library.writeText(
        notesPath(i.slug, day),
        `# notes ${day}\n- 10:00 [G]: x (note, seen)\n`,
      )
    const stale = order({ id: 'stale', at: monday - 30 * DAY, report: dest })
    const fresh = order({ id: 'fresh2', at: monday - 1 * DAY, report: dest })
    const first = await weeklyReview(deps, agent, [stale, fresh], monday)
    expect(first?.days).toContain('2026-10-13')
    const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 20 })
    expect(open.map((d) => d.title).filter((t) => t.includes('retire'))).toHaveLength(1)
    expect(open[0]?.title).toContain('stale')
    // once a week
    expect(await weeklyReview(deps, agent, [stale], monday + HOUR)).toBeUndefined()
    // not on other days
    expect(await weeklyReview(deps, agent, [stale], monday + DAY)).toBeUndefined()

    expect(
      await appendPattern(
        deps,
        agent,
        { pattern: 'Uploads slip on Mondays', days: ['2026-10-13'] },
        monday,
      ),
    ).toContain('at least 2')
    const written = await appendPattern(
      deps,
      agent,
      { pattern: 'Uploads slip on Mondays', days: ['2026-10-13', '2026-10-14'] },
      monday,
    )
    expect(written).toContain('patterns.md')
    const patterns =
      (await deps.library.read(`/library/notes/heartbeat/${i.slug}/patterns.md`))?.text ?? ''
    expect(patterns).toContain('Uploads slip on Mondays (days: 2026-10-13, 2026-10-14)')
  })

  test('overlapping orders become one question to the owners, once; hygiene is a Health finding', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const deps = i.server.deps
    const agent = deps.agents.getBySlug('lead')
    if (agent === undefined) throw new Error('seed')
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.internal }
    const a = order({
      id: 'ca',
      text: 'Report upload anomalies, early views and live sessions of YouTube channel AcmeAcademy',
      report: dest,
    })
    const b = order({
      id: 'cb',
      text: 'Report upload anomalies, views and live sessions of YouTube channel AcmeAcademy',
      by: 'ident-7',
      report: dest,
    })
    const lost = order({
      id: 'cl',
      text: 'Something else entirely',
      report: { kind: 'chat', connectionId: 'c1', nodeId: 'gone-node' },
    })
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${[a, b, lost].map(formatOrderLine).join('\n')}\n`,
    )
    const findings = (await hygieneFindings(deps, Date.now())).map(
      (f) => `${f.kind}|${f.severity}|${f.explanation.slice(0, 20)}`,
    )
    expect(findings.length).toBeGreaterThanOrEqual(2)
    const all = await hygieneFindings(deps, Date.now())
    expect(all.every((f) => f.kind === 'order-hygiene')).toBe(true)
    expect(all.some((f) => f.explanation.includes('no longer exists'))).toBe(true)
    const res = await i.server.app.request('/agent-health/findings')
    const body = (await res.json()) as { findings: Array<{ kind: string }> }
    expect(body.findings.some((f) => f.kind === 'order-hygiene')).toBe(true)

    const hyg = orderHygiene({
      now: Date.now(),
      orders: [a, b],
      destinationExists: () => true,
      giverRole: (o) => o.role,
    })
    expect(raiseConflicts(deps, agent, hyg, [a, b], Date.now())).toBe(1)
    expect(raiseConflicts(deps, agent, hyg, [a, b], Date.now())).toBe(0)
    const q = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 10 })
    expect(q).toHaveLength(1)
    expect(q[0]?.title).toContain('overlap')
    // nothing was removed
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['ca', 'cb', 'cl'])
    // once the orders no longer overlap, the open question closes itself
    expect(raiseConflicts(deps, agent, [], [a, b], Date.now())).toBe(0)
    expect(deps.decisions.list({ status: 'open', agentId: agent.id, limit: 10 })).toHaveLength(0)
    const closed = deps.decisions.list({ status: 'expired', agentId: agent.id, limit: 10 })
    expect(closed[0]?.title).toContain('overlap')
  })
})
