/**
 * A feed chat for a router agent: every message (also the account's own posts) wakes the agent, an
 * album is one turn, nothing is posted back, `channel_copy` copies with replies threaded under
 * their copy, edits and deletions reach the copies on their own, and trial mode only records.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import {
  CHAT,
  connectMock,
  type Rig,
  rig,
  sleep,
  toolCall,
  toolResults,
  until,
} from './support/agent-rig.ts'

const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
})

async function routerRig(steps: ScriptedStepInput[], trial = false) {
  const r = rig({ researcher: steps })
  rigs.push(r)
  const mock = await connectMock(r)
  const gw = r.server.channels
  updateAgent(r.server.deps, r.ids.researcher, { permissionMode: 'bypassPermissions' })
  const source = gw.nodes.list('c1').find((n) => n.nativeId === CHAT)
  if (source === undefined) throw new Error('no source chat')
  gw.settings.set(source.id, {
    enabled: true,
    label: 'Signals',
    agentId: r.ids.researcher,
    feed: true,
    ...(trial ? { copyTrial: true } : {}),
  } as never)
  for (const [nativeId, title] of [
    ['-2002', 'VIP'],
    ['-3003', 'Desk'],
  ] as const) {
    const n = gw.settings.ensureNode('c1', { nativeId, kind: 'room', title })
    gw.settings.set(n.id, { enabled: true, label: title, ack: false } as never)
  }
  return { r, mock, gw, source }
}

const photo = (n: string) => ({
  name: `${n}.jpg`,
  mediaType: 'image/jpeg',
  bytes: new Uint8Array([1]),
  media: 'photo' as const,
})

describe('a feed chat for a router agent', () => {
  test('an album is one turn; copies thread follow-ups; own posts count; edits and deletions follow', async () => {
    const { r, mock } = await routerRig([
      toolCall('channel_copy', { messageIds: ['101', '102'], to: 'VIP', note: 'signal 1' }),
      { text: 'Signal 1 copied to VIP.' },
      toolCall('channel_copy', { messageIds: ['103'], to: 'VIP' }),
      { text: 'Follow-up copied under signal 1.' },
      toolCall('channel_copies', { messageId: '101' }),
      { text: 'Checked.' },
    ])
    const analyst = { id: '55', name: 'Analyst' }
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: analyst,
      id: '101',
      text: 'BUY GOLD 4010',
      groupId: 'g1',
      attachments: [photo('a')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: analyst,
      id: '102',
      text: '',
      groupId: 'g1',
      attachments: [photo('b')],
    })
    await until('album copied', () => mock.copies.length === 1)
    // both photos reached the agent in one turn, marked as one album
    const first = JSON.stringify(r.models.researcher?.prompts[0])
    expect(first).toContain('message 101')
    expect(first).toContain('message 102')
    expect(first).toContain('album g1')
    expect(first).toContain('This conversation is a feed')
    expect(mock.copies[0]).toMatchObject({ from: CHAT, ids: ['101', '102'], to: '-2002' })

    // a reply in the source goes under the copy of the message it answers, on its own
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: analyst,
      id: '103',
      text: 'TP1 hit',
      replyTo: { messageId: '102' },
    })
    await until('follow-up copied', () => mock.copies.length === 2)
    expect(mock.copies[1]?.options.replyTo).toBe(mock.copies[0]?.messageIds[1])

    // the account itself posts in the feed (the analyst typing on it): the agent is woken too
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { ...mock.self(), isSelf: true },
      id: '104',
      text: 'Cicil sel dulu @ 4018',
    })
    await until('own post handled', () =>
      toolResults(r.models.researcher).some((x) => x.includes('was copied to')),
    )
    expect(toolResults(r.models.researcher).find((x) => x.includes('was copied to'))).toContain(
      'VIP message',
    )

    // nothing was posted back in the source chat (no answer, no ack)
    expect(mock.sent.filter((s) => s.conversationId === CHAT)).toHaveLength(0)
    expect(mock.reactions.filter((x) => x.conversationId === CHAT)).toHaveLength(0)

    // an edit of the signal reaches its copy (a caption: the copy has a photo), formatting kept
    await mock.emit({
      type: 'message.edited',
      dedupeKey: 'e1',
      at: Date.now(),
      node: mock.ref(CHAT, { kind: 'group' }),
      message: {
        nativeId: '101',
        sender: analyst,
        text: 'BUY GOLD 4012',
        entities: [{ type: 'bold', offset: 0, length: 3 }],
      },
    })
    await until('edit synced', () => mock.edits.length === 1)
    expect(mock.edits[0]).toMatchObject({
      conversationId: '-2002',
      messageId: mock.copies[0]?.messageIds[0],
      text: '<b>BUY</b> GOLD 4012',
      caption: true,
      format: 'html',
    })
    // a deletion removes the copy
    await mock.userDelete({ chat: CHAT, kind: 'group', ids: ['102'] })
    await until('delete synced', () => mock.deletes.length === 1)
    expect(mock.deletes[0]).toEqual({
      conversationId: '-2002',
      messageId: mock.copies[0]?.messageIds[1] as string,
    })
  }, 20_000)

  test('trial mode records where a message would go and sends nothing; a feed may write tables', async () => {
    const { r, mock } = await routerRig(
      [
        toolCall('channel_copy', { messageIds: ['201'], to: 'Desk', note: 'signal 2' }),
        toolCall('tables_write', {
          action: 'create',
          table: 'trade_ideas',
          columns: [{ name: 'message', type: 'string', unique: true }],
        }),
        toolCall('tables_write', {
          action: 'insert',
          table: 'trade_ideas',
          rows: [{ message: '201' }],
        }),
        toolCall('channel_copies', { messageId: '201' }),
        { text: 'Signal 2 would go to Desk.' },
      ],
      true,
    )
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '55', name: 'Analyst' },
      id: '201',
      text: 'SELL GOLD 4023',
    })
    await until('turn done', () => toolResults(r.models.researcher).length >= 4)
    await sleep(100)
    const results = toolResults(r.models.researcher)
    expect(results[0]).toContain('Trial mode: recorded')
    expect(results[0]).toContain('Desk')
    expect(results.some((x) => x.startsWith('ERROR'))).toBe(false)
    expect(results.find((x) => x.includes('was copied to'))).toContain('trial (not sent): Desk')
    expect(mock.copies).toHaveLength(0)
    expect(mock.sent).toHaveLength(0)
    expect(JSON.stringify(r.models.researcher?.prompts[0])).toContain('Trial mode is on')
    const rows = (await r.api('POST', '/tables/trade_ideas/query', {})).json.rows as unknown[]
    expect(rows).toHaveLength(1)
  }, 15_000)

  test('the Signal Router template sets up the agent, the table and the feed; trial first, then live', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await connectMock(r)
    const gw = r.server.channels
    for (const [nativeId, title] of [
      ['-2002', 'VIP'],
      ['-3003', 'Desk'],
    ] as const)
      gw.settings.ensureNode('c1', { nativeId, kind: 'room', title })
    const bad = await r.api('POST', '/channels/connections/c1/signal-router', {
      source: 'Ops',
      targets: ['Nowhere'],
    })
    expect(bad.status).toBe(400)
    const res = await r.api('POST', '/channels/connections/c1/signal-router', {
      source: 'Ops',
      targets: ['VIP', 'Desk'],
      rules: 'Skip posts that start with #promo.',
    })
    expect(res.status).toBe(201)
    const out = res.json as {
      agent: { id: string; slug: string }
      table: string
      trial: boolean
      source: { effective: Record<string, unknown> }
      targets: Array<{ effective: { allowed: boolean } }>
    }
    expect(out).toMatchObject({ table: 'trade_ideas', trial: true })
    expect(out.source.effective).toMatchObject({
      feed: true,
      copyTrial: true,
      wake: 'always',
      delivery: 'message_tool',
      agentId: out.agent.id,
    })
    expect(out.targets.every((t) => t.effective.allowed)).toBe(true)
    const agent = r.server.deps.agents.get(out.agent.id)
    expect(agent?.instructions).toContain('"VIP"')
    expect(agent?.instructions).toContain('TP1 = entry +/- 20 pips')
    expect(agent?.instructions).toContain('Skip posts that start with #promo.')
    expect(agent?.rules.allow).toContain('channel_copy')
    expect((await r.api('GET', '/tables/trade_ideas')).status).toBe(200)
    // a second router on the same source is refused
    expect(
      (
        await r.api('POST', '/channels/connections/c1/signal-router', {
          source: 'Ops',
          targets: ['VIP'],
        })
      ).status,
    ).toBe(409)

    // live: the agent copies on its own allow rules, no approval asked
    const source = gw.nodes.list('c1').find((n) => n.nativeId === CHAT)
    gw.settings.set(source?.id as string, { copyTrial: false } as never)
    updateAgent(r.server.deps, out.agent.id, { model: 'm-router' })
    r.models.router = scriptedModel([
      toolCall('channel_copy', { messageIds: ['301'], to: 'VIP', note: 'signal' }),
      { text: '301: new buy idea -> VIP' },
    ])
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '55', name: 'Analyst' },
      id: '301',
      text: 'Stnby buy zone E: 4010 - 4008 SL 4006',
    })
    await until('copied live', () => mock.copies.length === 1)
    expect(mock.copies[0]).toMatchObject({ ids: ['301'], to: '-2002' })
    expect(JSON.stringify(r.models.router.prompts[0])).toContain('You route trading signals')
  }, 15_000)

  test('via resend: we download the files and post text and files again; replies still thread', async () => {
    const { r, mock } = await routerRig([
      toolCall('channel_copy', { messageIds: ['401'], to: 'Desk', via: 'resend' }),
      { text: 'Resent.' },
      toolCall('channel_copy', { messageIds: ['402'], to: 'Desk', via: 'resend' }),
      { text: 'Follow-up resent.' },
    ])
    const analyst = { id: '55', name: 'Analyst' }
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: analyst,
      id: '401',
      text: 'SELL GOLD 4023',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
      attachments: [photo('chart')],
    })
    await until('resent', () => mock.sent.length === 1)
    expect(mock.copies).toHaveLength(0)
    expect(mock.sent[0]?.conversationId).toBe('-3003')
    expect(mock.sent[0]?.message).toMatchObject({ text: '<b>SELL</b> GOLD 4023', format: 'html' })
    expect(mock.sent[0]?.message.files?.[0]).toMatchObject({ name: 'chart.jpg', media: 'photo' })
    expect(mock.sent[0]?.message.files?.[0]?.bytes?.byteLength).toBe(1)
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: analyst,
      id: '402',
      text: 'TP1',
      replyTo: { messageId: '401' },
    })
    await until('follow-up resent', () => mock.sent.length === 2)
    expect(mock.sent[1]?.message.replyTo).toBe(mock.sent[0]?.messageId)
    void r
  }, 15_000)
})
