/**
 * A composed team server with scripted agent models and a mock chat connection, for tests that
 * drive agent tools through real turns (P59: tables tools, scripts tools). Same shape as the rig of
 * `events.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../../src/app/agents.ts'
import { createMockAdapter, type MockAdapter } from '../../src/infra/channels/index.ts'
import type { AdapterEventType } from '../../src/infra/channels/types.ts'
import type { ModelConfig } from '../../src/infra/eh/provider.ts'
import { compose, type Server } from '../../src/main.ts'
import { postAs, userMessage } from './http.ts'

export type AgentSlug = 'lead' | 'researcher'

export interface Rig {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
  ids: Record<AgentSlug, string>
  dir: string
  /** HTTP as the web owner. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    status: number
    json: Record<string, unknown> & { error?: { code: string; message: string } }
  }>
  close(): Promise<void>
}

export const CHAT = '-1001'

export function rig(
  script: Partial<Record<AgentSlug, ScriptedStepInput[]>> = {},
  extra: Record<string, unknown> = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'team-rig-'))
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      let model = models[slug]
      if (model === undefined) {
        model = scriptedModel([
          () => {
            throw new Error(`unexpected model call of ${slug}`)
          },
        ])
        models[slug] = model
      }
      return model
    },
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'rig',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0, retryUnknown: false },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 60, maxWaitMs: 500, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
    ...extra,
  })
  const ids = {} as Record<AgentSlug, string>
  for (const slug of ['lead', 'researcher'] as const) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
    ids[slug] = def.id
  }
  return {
    server,
    app: server.app,
    models,
    ids,
    dir,
    async api(method, path, body) {
      const res = await server.app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      return { status: res.status, json: text ? JSON.parse(text) : {} }
    },
    async close() {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Bind a mock chat connection `c1` to the lead with the room `Ops` enabled. */
export async function connectMock(
  r: Rig,
  options: { events?: AdapterEventType[] } = {},
): Promise<MockAdapter> {
  const gw = r.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: r.ids.lead,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const node = gw.settings.ensureNode('c1', { nativeId: CHAT, kind: 'room', title: 'Ops' })
  gw.settings.set(node.id, { enabled: true, label: 'Ops', ack: false } as never)
  const mock = createMockAdapter({ connectionId: 'c1', ...options })
  await gw.register(mock)
  return mock
}

/** One scripted step that calls a tool. */
export const toolCall = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input }],
})

/** The web owner writes to an agent's own chat and waits for the turn. */
export async function chat(r: Rig, slug: AgentSlug, text: string): Promise<void> {
  const id = r.ids[slug]
  const res = await r.app.request(`/sessions/dm:${id}/chat`, postAs(`dm:${id}`, userMessage(text)))
  if (res.status !== 200) throw new Error(`chat answered ${res.status}: ${await res.text()}`)
  await res.text()
}

/** The texts of the tool results the model read, in order. */
export function toolResults(m: ScriptedModel | undefined): string[] {
  const out: string[] = []
  for (const prompt of m?.prompts ?? []) {
    for (const msg of prompt as unknown as Array<{ role: string; content: unknown }>) {
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
      for (const part of msg.content as Array<{ output?: { value?: unknown; reason?: unknown } }>) {
        const v = part.output?.value ?? part.output?.reason
        if (typeof v === 'string' && !out.includes(v)) out.push(v)
      }
    }
  }
  return out
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  ms = 6000,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
