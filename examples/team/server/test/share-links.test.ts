/**
 * Public share links in agent text: the pure repair (`domain/share-links.ts`), the stored text of a
 * web chat reply, and the delivery to a chat (final text and `channel_send`).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import {
  DEAD_LINK_MARKER,
  editDistance,
  fixShareLinks,
  type KnownShare,
} from '../src/domain/share-links.ts'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const LIVE = 'iYd4wMBJSSY3KqyNR7yRUw'
const TYPO = 'iYd4wMBJQS3KqyNR7yRUw'
const OTHER = 'Zk9pQe2LmXa8TvB5nRcD3g'
const known: KnownShare[] = [
  { token: LIVE, artifactId: 'a1', title: 'Plan' },
  { token: OTHER, artifactId: 'a2', title: 'Report' },
]
const ORIGIN = 'https://team.example.test'

describe('fixShareLinks (pure)', () => {
  test('an exact live token is unchanged', () => {
    const text = `See ${ORIGIN}/s/${LIVE} now.`
    expect(fixShareLinks(text, known)).toEqual({ text, fixed: [], dead: [] })
  })

  test('one typo is repaired and the rest of the URL is kept', () => {
    expect(editDistance(TYPO, LIVE)).toBeLessThanOrEqual(3)
    const out = fixShareLinks(`Open ${ORIGIN}/s/${TYPO}.`, known)
    expect(out.text).toBe(`Open ${ORIGIN}/s/${LIVE}.`)
    expect(out.fixed).toEqual([{ from: TYPO, to: LIVE, title: 'Plan' }])
    expect(out.dead).toEqual([])
  })

  test('a markdown link, a relative path and an /art/s/ path are all found', () => {
    const md = fixShareLinks(`[the plan](${ORIGIN}/s/${TYPO})`, known)
    expect(md.text).toBe(`[the plan](${ORIGIN}/s/${LIVE})`)
    const rel = fixShareLinks(`go to /s/${TYPO} please`, known)
    expect(rel.text).toBe(`go to /s/${LIVE} please`)
    const art = fixShareLinks(`${ORIGIN}/art/s/${TYPO}/index.html?x=1`, known)
    expect(art.text).toBe(`${ORIGIN}/art/s/${LIVE}/index.html?x=1`)
  })

  test('two live tokens within reach is ambiguous: the link is dead, not guessed', () => {
    const near = `${LIVE.slice(0, -1)}X`
    const both: KnownShare[] = [
      { token: LIVE, artifactId: 'a1', title: 'A' },
      { token: `${LIVE.slice(0, -1)}Y`, artifactId: 'a2', title: 'B' },
    ]
    const out = fixShareLinks(`${ORIGIN}/s/${near}`, both)
    expect(out.fixed).toEqual([])
    expect(out.dead).toEqual([near])
    expect(out.text).toBe(`${ORIGIN}/s/${near}${DEAD_LINK_MARKER}`)
  })

  test('a deleted token (not in the live list) is marked after the URL', () => {
    const gone = 'AAAAAAAAAAAAAAAAAAAAAA'
    const out = fixShareLinks(`Here: ${ORIGIN}/s/${gone}. Thanks`, known)
    expect(out.text).toBe(`Here: ${ORIGIN}/s/${gone}${DEAD_LINK_MARKER}. Thanks`)
    expect(out.dead).toEqual([gone])
  })

  test('the marker of a markdown link goes after the closing parenthesis', () => {
    const gone = 'BBBBBBBBBBBBBBBBBBBBBB'
    const out = fixShareLinks(`[plan](${ORIGIN}/s/${gone}) is ready`, known)
    expect(out.text).toBe(`[plan](${ORIGIN}/s/${gone})${DEAD_LINK_MARKER} is ready`)
  })

  test('running it again changes nothing (idempotent), also after a repair', () => {
    const gone = 'CCCCCCCCCCCCCCCCCCCCCC'
    const text = `${ORIGIN}/s/${gone} and [x](/s/${gone}) and ${ORIGIN}/s/${TYPO}`
    const once = fixShareLinks(text, known)
    expect(once.text.split(DEAD_LINK_MARKER).length - 1).toBe(2)
    const twice = fixShareLinks(once.text, known)
    expect(twice.text).toBe(once.text)
    expect(twice.fixed).toEqual([])
  })

  test('far-off tokens, short words and look-alike paths are left alone as dead or ignored', () => {
    const text = 'see /s/settings and /docs/s/AAAAAAAAAAAAAAAAAAAAAA and https://x.test/users/abc'
    expect(fixShareLinks(text, known)).toEqual({ text, fixed: [], dead: [] })
    // a token far from every live one is dead
    const far = 'QQQQQQQQQQQQQQQQQQQQQQ'
    expect(fixShareLinks(`/s/${far}`, known).dead).toEqual([far])
  })
})

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

/** A mistyped copy of a token: one character replaced. */
const mistype = (token: string): string =>
  `${token.slice(0, 4)}${token[4] === 'x' ? 'y' : 'x'}${token.slice(5)}`

async function publicShare(server: Server, title: string): Promise<string> {
  const a = (await server.artifacts.create({
    kind: 'document',
    title,
    files: [{ path: 'document.md', content: '# Hi\n' }],
  } as never)) as { id: string }
  const view = server.artifacts.setVisibility(a.id, 'public', 'test')
  const token = view.shareUrl?.split('/s/')[1]
  if (token === undefined) throw new Error('not public')
  return token
}

describe('the stored reply of a web chat', () => {
  test('a mistyped share link is repaired and a dead one marked in what a reload shows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-share-'))
    dirs.push(dir)
    let live = ''
    const gone = 'DDDDDDDDDDDDDDDDDDDDDD'
    const model = scriptedModel([
      () => ({
        text: `Plan: http://localhost:5173/s/${mistype(live)} and old: http://localhost:5173/s/${gone}`,
      }),
    ])
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(model as never),
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 40 }, abortPollMs: 40 },
      webUrl: 'http://localhost:5173',
    })
    servers.push(server)
    live = await publicShare(server, 'Plan')
    const res = await server.app.request(
      '/sessions/dm:researcher/chat',
      postAs('dm:researcher', userMessage('link?')),
    )
    expect(res.status).toBe(200)
    await res.text()
    const stored = (await (
      await server.app.request('/sessions/dm:researcher/messages')
    ).json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
    }
    const reply = stored.messages.find((m) => m.role === 'assistant')
    const text = reply?.parts.find((p) => p.type === 'text')?.text ?? ''
    expect(text).toContain(`/s/${live} and old:`)
    expect(text).not.toContain(mistype(live))
    expect(text).toContain(`/s/${gone}${DEAD_LINK_MARKER}`)
  })
})

describe('delivery to a chat', () => {
  const KEY = new Uint8Array(32).fill(9)
  function instance(steps: ScriptedStepInput[]) {
    const dir = mkdtempSync(join(tmpdir(), 'team-share-ch-'))
    dirs.push(dir)
    const lead = scriptedModel(steps)
    const server = compose({
      dbFile: join(dir, 'team.db'),
      instanceId: 'share-test',
      models: {
        provider: 'scripted',
        defaultModel: 'none',
        resolve: () => lead as never,
      },
      env: {},
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
      eventsPollMs: 30,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      webUrl: 'http://localhost:5173',
      channels: {
        vault: webCryptoVault(KEY),
        collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
        typingEveryMs: 20,
        purgeEveryMs: 0,
        maintenanceMs: 0,
        delivery: { retryBaseMs: 20, retryMaxMs: 80 },
      },
    })
    servers.push(server)
    const def = server.deps.agents.getBySlug('lead')
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, {
      model: 'm-lead',
      rules: { ...def.rules, allow: [...def.rules.allow, 'channel_send'] },
    })
    return { server, leadId: def.id }
  }
  const owner = { id: '1001', name: 'Rina', username: 'rina' }

  async function connect(i: ReturnType<typeof instance>) {
    const gw = i.server.channels
    gw.configure({
      connectionId: 'c1',
      agentId: i.leadId,
      rate: { chatMinIntervalMs: 0 },
      people: { defaultRole: 'guest', policy: {} },
    })
    const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room' })
    gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
    const mock = createMockAdapter({ connectionId: 'c1' })
    await gw.register(mock)
    gw.people.setRole('c1', owner.id, { role: 'admin' }, 'owner')
    return mock
  }

  test('the final text and a channel_send text are corrected before they are sent', async () => {
    let live = ''
    const gone = 'EEEEEEEEEEEEEEEEEEEEEE'
    const url = (t: string): string => `http://localhost:5173/s/${t}`
    const i = instance([
      () => ({
        toolCalls: [
          {
            toolName: 'channel_send',
            input: { action: 'send', conversation: 'room', text: `Posted: ${url(mistype(live))}` },
            toolCallId: 't1',
          },
        ],
      }),
      () => ({ text: `Final: ${url(mistype(live))} and ${url(gone)}` }),
    ])
    const mock = await connect(i)
    live = await publicShare(i.server, 'Plan')
    await mock.say({ from: owner, text: '@team_bot link please', id: 'm1', mentionSelf: true })
    await until('both messages', () => mock.sent.length >= 2)
    const texts = mock.sent.map((s) => s.message.text)
    const posted = texts.find((t) => t.startsWith('Posted:')) ?? ''
    const final = texts.find((t) => t.startsWith('Final:')) ?? ''
    expect(posted).toBe(`Posted: ${url(live)}`)
    expect(final).toBe(`Final: ${url(live)} and ${url(gone)}${DEAD_LINK_MARKER}`)
  })
})
