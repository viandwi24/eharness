/**
 * The world of the Channels scenarios: one team server composed in-process, talking to a FAKE
 * Telegram Bot API (so the real Telegram adapter, normalizer, HTML formatting and outbound
 * governor run), the Tracker (demo) MCP as a custom connector, and a cast of actors in a forum
 * supergroup "Acme HQ" plus DMs. Nothing here touches the real network except the model in
 * `real` mode. Test fixture; not part of the library.
 *
 * Only public compose/test helpers are used: `compose` from the server, the fake Telegram of the
 * server tests and the Tracker fixture. Server `src/` is never edited from here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../../server/src/app/agents.ts'
import type { ModelConfig } from '../../server/src/infra/eh/provider.ts'
import { compose, type Server } from '../../server/src/main.ts'
import { type FakeTelegram, fakeTelegram } from '../../server/test/support/fake-telegram.ts'
import { createTrackerApp, store as trackerStore } from '../tracker/server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const teamDir = resolve(here, '../..')

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
export type Json = Record<string, any>

export const BOT_USERNAME = 'acme_team_bot'
export const BOT_ID = 777
export const GROUP_ID = -1001000000001
export const OTHER_GROUP_ID = -1001000000002

/** The agents of the seed and the slugs scripts address. */
export const AGENT_SLUGS = ['lead', 'ops', 'researcher', 'writer', 'analyst'] as const
export type AgentSlug = (typeof AGENT_SLUGS)[number]

/** Topics of Acme HQ: native thread id and name. General is the forum's own stream (no thread id). */
export const TOPICS = {
  general: { thread: undefined, title: 'General' },
  produksi: { thread: 11, title: 'produksi' },
  clipper: { thread: 12, title: 'clipper' },
  programming: { thread: 13, title: 'programming' },
  finance: { thread: 14, title: 'finance' },
} as const
export type TopicKey = keyof typeof TOPICS

export type Role = 'owner' | 'admin' | 'member' | 'guest'
export interface ActorDef {
  key: string
  id: number
  name: string
  username?: string
  isBot?: boolean
  /** The role in the team directory (undefined = not in the directory). */
  role?: Role
  /** The topics (divisions) of the person. */
  divisions?: TopicKey[]
  /** The platform account is linked to this team member. */
  linkedMember?: string
  /** Speaks as the group itself (anonymous admin). */
  anonymous?: boolean
}

export const ACTORS: ActorDef[] = [
  {
    key: 'ceo',
    id: 1001,
    name: 'Rini Wijaya',
    username: 'rini_ceo',
    role: 'owner',
    linkedMember: 'owner',
  },
  { key: 'admin', id: 1002, name: 'Andi Pratama', username: 'andi_admin', role: 'admin' },
  {
    key: 'budi',
    id: 1003,
    name: 'Budi Santoso',
    username: 'budi_prod',
    role: 'member',
    divisions: ['produksi'],
  },
  {
    key: 'sari',
    id: 1004,
    name: 'Sari Lestari',
    username: 'sari_clip',
    role: 'member',
    divisions: ['clipper'],
  },
  {
    key: 'dodi',
    id: 1005,
    name: 'Dodi Kurnia',
    username: 'dodi_dev',
    role: 'member',
    divisions: ['programming'],
  },
  { key: 'guest', id: 1006, name: 'Gina Tamu', username: 'gina_guest' },
  { key: 'stranger', id: 1007, name: 'Eko Asing', username: 'eko_x' },
  { key: 'otherbot', id: 9001, name: 'Helper Bot', username: 'helper_bot', isBot: true },
  {
    key: 'anon',
    id: 1087968824,
    name: 'Group',
    username: 'GroupAnonymousBot',
    isBot: true,
    anonymous: true,
  },
]

export interface WorldOptions {
  mode: 'scripted' | 'real'
  /** OpenRouter model id of `real` mode. */
  model?: string
  /** Scripted steps per agent slug (scripted mode). */
  script?: Partial<Record<AgentSlug, ScriptedStepInput[]>>
  /** Monthly budget cap of the workspace ledger (USD). */
  budgetUsd?: number
  /** Outbound pacing is real (governor scenarios); default: fast in scripted mode. */
  realOutbound?: boolean
  /** The bot sees only mentions, replies and commands in groups (Telegram privacy mode). */
  privacyMode?: boolean
  /** Group wake policy (default `mention`). */
  wake?: 'mention' | 'always' | 'never'
  /** Default role of somebody not in the directory (default `guest`). */
  defaultRole?: Role
  /** Keep the data dir after close (debugging). */
  keepDir?: boolean
  /** Extra compose config (restart scenarios pass `dbFile`). */
  dir?: string
}

export interface TrackerHandle {
  url: string
  stop(): void
}

let sharedTracker: { url: string; server: ReturnType<typeof Bun.serve> } | undefined
/** One Tracker per process (ephemeral port); every world resets it. */
export function startTracker(): TrackerHandle {
  if (sharedTracker === undefined) {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createTrackerApp().fetch })
    sharedTracker = { url: `http://127.0.0.1:${server.port}`, server }
  }
  const t = sharedTracker
  return {
    url: t.url,
    stop() {
      t.server.stop(true)
      sharedTracker = undefined
    },
  }
}
export const tracker = { store: trackerStore }

const usedPorts = new Set<number>()
/** A free port never handed out before in this process (a closed world's poller must not reach the next fake). */
async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const p = s.port as number
    s.stop(true)
    if (!usedPorts.has(p)) {
      usedPorts.add(p)
      return p
    }
  }
  throw new Error('no free port')
}

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface World {
  opts: WorldOptions
  server: Server
  fake: FakeTelegram
  dir: string
  connectionId: string
  agentIds: Record<AgentSlug, string>
  /** Node ids (ours) of the group and its topics. */
  nodes: { hq: string } & Record<TopicKey, string>
  /** Platform id of the second chat "Acme Partners" (an unrelated group the bot is in). */
  otherGroupNode: string
  actors: Record<string, ActorDef>
  trackerUrl: string
  /** Failures injected into the fake Bot API (`world.fail`): the nth call of a method fails. */
  failures: Array<{ method: string; from: number; times: number }>
  fail(method: string, failure: Parameters<FakeTelegram['fail']>[1], times?: number): void
  models: Partial<Record<AgentSlug, ScriptedModel>>
  /** Admin API over HTTP (the same routes as the web UI), as the owner. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json; text: string }>
  /** Stop the server (a crash: nothing is drained) and start a new one on the same database. */
  restart(): Promise<void>
  close(): Promise<void>
}

const KEY = new Uint8Array(32).fill(9)

async function call(server: Server, method: string, path: string, body?: unknown) {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: Json = {}
  try {
    json = text ? (JSON.parse(text) as Json) : {}
  } catch {
    json = {}
  }
  return { status: res.status, json, text }
}

/** Build the world: server, fake Telegram, connection, bot bound to Lead, chats, directory, Tracker. */
export async function buildWorld(opts: WorldOptions): Promise<World> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'team-chan-e2e-'))
  mkdirSync(dir, { recursive: true })
  const fake = fakeTelegram(await freePort())
  fake.setBot({
    id: BOT_ID,
    username: BOT_USERNAME,
    first_name: 'Acme Team Bot',
    can_read_all_group_messages: opts.privacyMode !== true,
  })
  const trackerHandle = startTracker()
  trackerStore.reset()

  const models: Partial<Record<AgentSlug, ScriptedModel>> = {}
  let modelConfig: ModelConfig | undefined
  const env: Record<string, string | undefined> = {
    TEAM_SECRET_KEY: Buffer.from(KEY).toString('base64'),
    TEAM_TELEGRAM_API_ROOT: fake.url,
    TEAM_ALLOW_PRIVATE_MCP: '1',
    TZ: 'Asia/Jakarta',
  }
  if (opts.mode === 'scripted') {
    for (const [slug, steps] of Object.entries(opts.script ?? {}))
      models[slug as AgentSlug] = scriptedModel(steps as ScriptedStepInput[])
    modelConfig = {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: (id) => {
        const slug = (id ?? '').replace('m-', '') as AgentSlug
        let m = models[slug]
        if (m === undefined) {
          m = scriptedModel([
            () => {
              throw new Error(`unexpected model call of ${slug}`)
            },
          ])
          models[slug] = m
        }
        return m
      },
    }
  } else {
    const dotenv = readEnvFile(join(teamDir, '.env'))
    if (!dotenv.OPENROUTER_API_KEY)
      throw new Error('OPENROUTER_API_KEY missing in examples/team/.env')
    env.OPENROUTER_API_KEY = dotenv.OPENROUTER_API_KEY
    if (dotenv.OPENROUTER_BASE_URL) env.OPENROUTER_BASE_URL = dotenv.OPENROUTER_BASE_URL
    env.TEAM_MODEL = opts.model ?? 'deepseek/deepseek-v4.1-flash'
    env.TEAM_PROVIDER = 'openrouter'
  }
  const scripted = opts.mode === 'scripted'
  const boot = (restarted = false): Server =>
    compose({
      dbFile: join(dir, 'team.db'),
      instanceId: 'chan-e2e',
      ...(modelConfig === undefined ? {} : { models: modelConfig }),
      ...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
      env,
      offline: scripted,
      tuning: scripted
        ? { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
        : { inbox: { pollMs: 100 } },
      eventsPollMs: 100,
      changePollMs: 0,
      reconcile: { onBoot: restarted, everyMs: 0 },
      routines: { tickMs: 0 },
      publicUrl: 'http://api.test',
      webUrl: 'http://web.test',
      telegram: { pollTimeoutSec: 1, syncPollMs: 0, retryMs: 0 },
      channels: {
        vault: webCryptoVault(KEY),
        collect: scripted
          ? { quietMs: 25, maxWaitMs: 300, maxItems: 20 }
          : { quietMs: 700, maxWaitMs: 5000, maxItems: 20 },
        typingEveryMs: scripted ? 20 : 4000,
        purgeEveryMs: 0,
        maintenanceMs: 0,
        delivery: { retryBaseMs: 50, retryMaxMs: 400 },
        ...(scripted && opts.realOutbound !== true
          ? { outbound: { sleep: async (ms: number) => void (await sleep(Math.min(ms, 5))) } }
          : {}),
      },
    })
  let server = boot()
  await server.connectorsReady
  await server.providersReady
  const api = (method: string, path: string, body?: unknown) => call(server, method, path, body)

  const agentIds = {} as Record<AgentSlug, string>
  for (const slug of AGENT_SLUGS) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error(`seed agent ${slug} missing`)
    agentIds[slug] = def.id
    if (scripted) updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }

  // Tracker as a custom connector available to every agent
  const made = await api('POST', '/connectors/custom', {
    name: 'Tracker',
    url: `${trackerHandle.url}/mcp`,
    signIn: 'none',
    availableToAll: true,
  })
  if (made.status !== 201)
    throw new Error(`tracker connector failed: ${made.status} ${made.text.slice(0, 200)}`)

  // the bot: connect through the connector flow, bind to Lead
  const started = await api('POST', '/connections/flows', {
    definitionId: 'telegram-bot',
    label: 'Acme bot',
  })
  const done = await api('POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: started.json.flow.view.viewId,
    action: 'submit',
    data: { token: fake.token },
  })
  const connectionId = done.json.connection?.id as string
  if (!connectionId) throw new Error(`bot connection failed: ${done.text.slice(0, 200)}`)
  const bound = await api('PUT', `/channels/connections/${connectionId}/binding`, {
    agentId: agentIds.lead,
  })
  if (bound.status !== 200) throw new Error(`binding failed: ${bound.text.slice(0, 200)}`)

  // chats: the forum, its topics, the partner group, discovered the way a real bot learns them
  const hq = server.channels.settings.ensureNode(connectionId, {
    nativeId: String(GROUP_ID),
    kind: 'room',
    title: 'Acme HQ',
    traits: { multiUser: true },
  })
  const nodes = { hq: hq.id } as World['nodes']
  for (const [key, t] of Object.entries(TOPICS)) {
    if (t.thread === undefined) {
      nodes[key as TopicKey] = hq.id
      continue
    }
    nodes[key as TopicKey] = server.channels.settings.ensureNode(
      connectionId,
      { nativeId: `${GROUP_ID}/${t.thread}`, kind: 'thread', title: t.title },
      String(GROUP_ID),
    ).id
  }
  const other = server.channels.settings.ensureNode(connectionId, {
    nativeId: String(OTHER_GROUP_ID),
    kind: 'room',
    title: 'Acme Partners',
    traits: { multiUser: true },
  })
  // policy: HQ (and its topics) allowed, wake on mention, partner group observed only
  await api('PATCH', `/channels/connections/${connectionId}/chats/${hq.id}/policy`, {
    wake: opts.wake ?? 'mention',
    retentionDays: 30,
  })
  await api('PATCH', `/channels/connections/${connectionId}/chats/${other.id}/policy`, {
    wake: 'never',
  })
  await api('PUT', `/channels/connections/${connectionId}/people/settings`, {
    defaultRole: opts.defaultRole ?? 'guest',
  })

  // directory: roles and divisions are set by the team, never by chat text
  const actors: Record<string, ActorDef> = {}
  for (const a of ACTORS) {
    // a copy: a scenario that renames somebody must not rename them in the next scenario
    actors[a.key] = { ...a }
    if (a.linkedMember !== undefined)
      await api('POST', `/channels/connections/${connectionId}/links`, {
        peerId: String(a.id),
        memberId: a.linkedMember,
        name: a.name,
      })
    if (a.role !== undefined)
      await api('PUT', `/channels/connections/${connectionId}/people/${a.id}/role`, {
        role: a.role,
        ...(a.divisions === undefined ? {} : { divisions: a.divisions.map((d) => nodes[d]) }),
      })
  }
  const failures: World['failures'] = []
  const world: World = {
    opts,
    get server() {
      return server
    },
    fake,
    dir,
    connectionId,
    agentIds,
    nodes,
    otherGroupNode: other.id,
    actors,
    trackerUrl: trackerHandle.url,
    failures,
    fail(method, failure, times = 1) {
      failures.push({ method, from: fake.callsOf(method).length, times })
      fake.fail(method, failure, times)
    },
    models,
    api,
    async restart() {
      await server.close()
      server = boot(true)
      await server.connectorsReady
      await server.providersReady
    },
    async close() {
      // stop the Telegram transport first: a poller must not outlive the database it writes to
      await api('DELETE', `/channels/connections/${connectionId}/binding`).catch(() => undefined)
      await server.close()
      fake.stop()
      if (opts.keepDir !== true && opts.dir === undefined)
        rmSync(dir, { recursive: true, force: true })
    },
  }
  return world
}
