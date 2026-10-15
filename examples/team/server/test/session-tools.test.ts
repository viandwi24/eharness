/**
 * "Tools in this session" (`GET /sessions/{id}/tools`) and the forced reload
 * (`POST /sessions/{id}/reload`, `POST /agents/{id}/reload`). Scripted models, a real SQLite file.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { archiveAgent } from '../src/app/agents.ts'
import type { SessionToolsView } from '../src/app/ports.ts'
import type { NewModelCall } from '../src/domain/model-calls.ts'
import {
  compareTools,
  deferredNamesOf,
  isTruncatedBody,
  toolsOfRequestBody,
} from '../src/domain/session-tools.ts'
import { sqliteModelCallStore } from '../src/infra/db/model-calls-repo.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

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

function instance(steps: ScriptedStepInput[]) {
  const dir = mkdtempSync(join(tmpdir(), 'team-session-tools-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: scriptedModelConfig(scriptedModel(steps) as never),
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('researcher')
  if (def === undefined) throw new Error('seed missing')
  return { server, app: server.app, def }
}

const post = (): RequestInit => ({ method: 'POST' })
const enc = encodeURIComponent

describe('request body parsing', () => {
  const body = {
    tools: [{ name: 'a' }, { function: { name: 'b' } }, { name: 'c', defer_loading: true }],
    system: [
      {
        type: 'text',
        text: 'Hi\n\nDeferred tools: these tools exist but their schemas are not loaded. Load one with `tool_search`.\n- d: does d\n- e\n\nOther text',
      },
    ],
  }
  test('loaded = tools array, deferred = the block plus defer_loading entries', () => {
    expect(deferredNamesOf(body)).toEqual(['d', 'e'])
    expect(toolsOfRequestBody(body)).toEqual({ loaded: ['a', 'b'], deferred: ['d', 'e', 'c'] })
  })
  test('no tools array, and a truncated marker', () => {
    expect(toolsOfRequestBody({ messages: [] })).toBeUndefined()
    expect(isTruncatedBody({ _truncated: true, bytes: 9, preview: '' })).toBe(true)
    expect(isTruncatedBody(body)).toBe(false)
  })
  test('missing = configured, allowed, not seen; off tools are not missing', () => {
    const groups = [
      {
        connectionId: 'c1',
        connectorId: 'phone',
        name: 'Phone',
        label: 'phone',
        tools: [
          { name: 'a', mode: 'allow' as const, chatOff: false },
          { name: 'x', mode: 'ask' as const, chatOff: false },
          { name: 'y', mode: 'off' as const, chatOff: false },
          { name: 'z', mode: 'allow' as const, chatOff: true },
        ],
      },
    ]
    expect(compareTools(groups, { loaded: ['a', 'tool_search'], deferred: [] })).toEqual({
      missing: ['x'],
      extra: ['tool_search'],
    })
  })
})

describe('GET /sessions/{id}/tools', () => {
  test('configured tools against the last call: loaded, deferred, missing', async () => {
    const { server, app, def } = instance([])
    const sessionId = `dm:${def.id}`
    const empty = (await (
      await app.request(`/sessions/${enc(sessionId)}/tools`)
    ).json()) as SessionToolsView
    const names = empty.configured
      .flatMap((g) => g.tools)
      .filter((t) => t.mode !== 'off')
      .map((t) => t.name)
    expect(names.length).toBeGreaterThan(3)
    // no call yet: unknown, with a reason
    expect(empty.lastCall).toBeNull()
    expect(empty.lastCallNote).toContain('No model call')
    expect(empty.missing).toEqual([])

    const [loaded, deferred, ...rest] = names as [string, string, ...string[]]
    const call: NewModelCall = {
      id: 'call-1',
      createdAt: 1_700_000_000_000,
      kind: 'step',
      agentId: def.id,
      sessionId,
      turnId: 't1',
      stepIndex: 0,
      messageId: 'm1',
      taskId: null,
      provider: 'anthropic',
      modelId: 'claude-x',
      status: 'ok',
      finishReason: 'stop',
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: null,
      cachedTokens: null,
      costUsd: null,
      startedAt: 1_700_000_000_000,
      firstChunkMs: 5,
      durationMs: 10,
      errorName: null,
      errorMessage: null,
      requestOptions: null,
      requestBody: {
        tools: [{ name: loaded }, { name: 'tool_search' }],
        system: [
          {
            type: 'text',
            text: `Deferred tools: these tools exist but their schemas are not loaded.\n- ${deferred}: first line`,
          },
        ],
      },
      response: null,
      output: null,
      providerMetadata: null,
      usageRaw: null,
    }
    sqliteModelCallStore(server.conn.sqlite).insert(call, call.createdAt)

    // the id may be given as `dm:<slug>` too
    const res = await app.request(`/sessions/${enc('dm:researcher')}/tools`)
    expect(res.status).toBe(200)
    const view = (await res.json()) as SessionToolsView
    expect(view.sessionId).toBe(sessionId)
    expect(view.lastCall).toEqual({
      id: 'call-1',
      at: 1_700_000_000_000,
      loaded: [loaded, 'tool_search'],
      deferred: [deferred],
    })
    expect(view.lastCallNote).toBeNull()
    expect(view.missing).toEqual(rest)
    expect(view.extra).toEqual(['tool_search'])
  })

  test('a truncated request body gives no last call, with a reason', async () => {
    const { server, app, def } = instance([])
    const sessionId = `dm:${def.id}`
    const store = sqliteModelCallStore(server.conn.sqlite, { jsonCap: 200 })
    store.insert(
      {
        id: 'big',
        createdAt: 1,
        kind: 'step',
        agentId: def.id,
        sessionId,
        turnId: null,
        stepIndex: 0,
        messageId: null,
        taskId: null,
        provider: 'p',
        modelId: 'm',
        status: 'ok',
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedTokens: null,
        costUsd: null,
        startedAt: 1,
        firstChunkMs: null,
        durationMs: 1,
        errorName: null,
        errorMessage: null,
        requestOptions: null,
        requestBody: { tools: [{ name: 'x'.repeat(500) }] },
        response: null,
        output: null,
        providerMetadata: null,
        usageRaw: null,
      },
      1,
    )
    const view = (await (
      await app.request(`/sessions/${enc(sessionId)}/tools`)
    ).json()) as SessionToolsView
    expect(view.lastCall).toBeNull()
    expect(view.lastCallNote).toContain('too large')
    expect(view.missing).toEqual([])
  })

  test('an unknown session is 404', async () => {
    const { app } = instance([])
    expect((await app.request(`/sessions/${enc('nope:1')}/tools`)).status).toBe(404)
    expect((await app.request(`/sessions/${enc('nope:1')}/reload`, post())).status).toBe(404)
  })
})

describe('forced reload', () => {
  const reloadedCount = async (app: Server['app'], sessionId: string) => {
    const body = JSON.stringify(
      await (await app.request(`/sessions/${enc(sessionId)}/messages?limit=100`)).json(),
    )
    return body.split('agent.tools.reloaded').length - 1
  }

  test('an idle session is closed; the next open is a new object and the model is told once', async () => {
    const { server, def } = instance([{ text: 'one' }, { text: 'two' }, { text: 'three' }])
    await server.factory.prepare(def)
    const held = server.factory.openSession(def, 'channel:test:held')
    await (await held.send({ text: 'hello' } as never)).result

    const out = await server.factory.reloadSession(def, 'channel:test:held')
    expect(out.closed).toBe(1)
    expect(out.pending).toBe(0)
    expect(out.tools.length).toBeGreaterThan(0)

    const next = server.factory.openSession(def, 'channel:test:held')
    expect(next).not.toBe(held)
    await (await next.send({ text: 'again' } as never)).result
    const third = server.factory.openSession(def, 'channel:test:held')
    await (await third.send({ text: 'and again' } as never)).result
    const messages = JSON.stringify(await server.factory.peek('channel:test:held').messages())
    expect(messages.split('agent.tools.reloaded').length - 1).toBe(1)
    expect(messages).toContain('Your tools were reloaded')
  })

  test('a busy session is not cut: pending, closed right after its turn', async () => {
    const { server, def } = instance([{ text: 'slow answer', delayMs: 500 }, { text: 'next' }])
    await server.factory.prepare(def)
    const held = server.factory.openSession(def, 'channel:test:busy')
    const run = await held.send({ text: 'hello' } as never)
    await until('the turn runs', async () => (await held.busy()) !== null)
    const out = await server.factory.reloadSession(def, 'channel:test:busy')
    expect(out.pending).toBe(1)
    expect(out.closed).toBe(0)
    // the running turn finishes
    const result = await run.result
    expect(JSON.stringify(result)).toContain('complete')
    await until('the held session is replaced', () => {
      const probe = server.factory.openSession(def, 'channel:test:busy')
      return probe !== held
    })
  })

  test('POST /sessions/{id}/reload and POST /agents/{id}/reload', async () => {
    const { server, app, def } = instance([{ text: 'a' }, { text: 'b' }])
    const say = async (sessionId: string, text: string) =>
      (
        await app.request(`/sessions/${enc(sessionId)}/chat`, postAs(sessionId, userMessage(text)))
      ).text()
    const sessionId = `dm:${def.id}`
    await say(sessionId, 'hi')
    const one = await app.request(`/sessions/${enc(sessionId)}/reload`, post())
    expect(one.status).toBe(200)
    const body = (await one.json()) as { sessions: number; pending: boolean; tools: string[] }
    expect(body.pending).toBe(false)
    expect(body.tools.length).toBeGreaterThan(0)
    expect(await reloadedCount(app, sessionId)).toBe(0) // told on the next turn, not stored yet

    // agent reload: every live session of the agent
    const s1 = server.factory.openSession(def, 'channel:test:one')
    const s2 = server.factory.openSession(def, 'channel:test:two')
    const all = await app.request(`/agents/${def.id}/reload`, post())
    expect(all.status).toBe(200)
    const agent = (await all.json()) as { sessions: number; closed: number }
    expect(agent.sessions).toBeGreaterThanOrEqual(2)
    expect(agent.closed).toBeGreaterThanOrEqual(2)
    expect(server.factory.openSession(def, 'channel:test:one')).not.toBe(s1)
    expect(server.factory.openSession(def, 'channel:test:two')).not.toBe(s2)
  })

  test('an archived agent cannot be reloaded', async () => {
    const { server, app, def } = instance([])
    archiveAgent(server.deps, def.id)
    const res = await app.request(`/agents/${def.id}/reload`, post())
    expect(res.status).toBe(409)
  })
})
