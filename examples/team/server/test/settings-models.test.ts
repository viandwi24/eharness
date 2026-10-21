/**
 * Product knobs live in the workspace settings: validation, the precedence (saved setting > env
 * initial value > built-in), the effective-models report with its fallback warnings, and that a
 * classifier or search model change applies on the very next call, without a restart.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { modelsReport } from '../src/app/settings-models.ts'
import type { AgentDef } from '../src/domain/agents.ts'
import {
  checkSettingsPatch,
  SETTINGS_BUILTIN,
  settingsDefaults,
  settingsFromEnv,
} from '../src/domain/settings.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const LIST = { data: [] }
const stubFetch = (async (url: string | URL | Request) =>
  String(url).endsWith('/key')
    ? new Response('{}', { status: 200 })
    : new Response(JSON.stringify(LIST))) as typeof fetch

async function boot(env: Record<string, string> = {}): Promise<Server> {
  const server = compose({
    dbFile: ':memory:',
    env: { OPENROUTER_API_KEY: 'sk-test-0000', ...env },
    offline: true,
    fetch: stubFetch,
    changePollMs: 0,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.providersReady
  return server
}

const modelIdOf = (m: unknown): string => (m as { modelId: string }).modelId

describe('validation', () => {
  const bad: Array<Record<string, unknown>> = [
    { contextCap: 100 },
    { connectorHealthTtlMs: -1 },
    { connectorProbeRetryMs: 120_000 },
    { longRunMaxCostUsd: -1 },
    { longRunChunkSteps: 5 },
    { maxRepeatingReminders: 1.5 },
    { eventsMaxRows: 10 },
    { logRetentionDays: 0 },
    { tasksRetentionDays: -1 },
    { teamName: '  ' },
    { classifierModel: '' },
    { searchProfile: 'x'.repeat(65) },
  ]
  for (const patch of bad) {
    test(`rejects ${JSON.stringify(patch)}`, () => {
      expect(() => checkSettingsPatch(patch as never)).toThrow()
    })
  }
  test('accepts the edges and null for the optional knobs', () => {
    expect(() =>
      checkSettingsPatch({
        contextCap: null,
        connectorHealthTtlMs: null,
        longRunMaxCostUsd: 0,
        longRunMaxHours: 0,
        longRunChunkSteps: 10,
        maxRepeatingReminders: 0,
        classifierModel: null,
        searchModel: null,
        teamName: null,
      }),
    ).not.toThrow()
  })
})

describe('precedence: setting > env initial value > built-in', () => {
  test("built-in values are today's behaviour", () => {
    const d = settingsDefaults({})
    expect(d.classifierModel).toBeNull()
    expect(d.searchModel).toBeNull()
    expect(d.connectorHealthTtlMs).toBe(60_000)
    expect(d.connectorProbeRetryMs).toBe(3_000)
    expect(d.longRunChunkSteps).toBe(SETTINGS_BUILTIN.longRunChunkSteps)
    expect(d.stuckRunMinutes).toBe(45)
  })
  test('the environment is the initial value; invalid values are ignored', () => {
    const env = {
      TEAM_CLASSIFIER_MODEL: 'openrouter:x/y',
      TEAM_SEARCH_MODEL: 'g/search',
      TEAM_CONNECTOR_HEALTH_TTL_MS: '-1',
      TEAM_CONNECTOR_PROBE_RETRY_MS: 'nope',
      TEAM_CONTEXT_CAP: '1000',
      TEAM_LONG_RUN_MAX_HOURS: '2',
    }
    const fromEnv = settingsFromEnv(env)
    expect(fromEnv.classifierModel).toBe('openrouter:x/y')
    expect(fromEnv.searchModel).toBe('g/search')
    expect(fromEnv.connectorHealthTtlMs).toBeNull()
    expect(fromEnv.connectorProbeRetryMs).toBeUndefined()
    expect(fromEnv.contextCap).toBeUndefined()
    expect(fromEnv.longRunMaxHours).toBe(2)
  })
  test('a saved setting wins over the env value, also when it is null', async () => {
    const server = await boot({ TEAM_CLASSIFIER_MODEL: 'env/classifier', TEAM_NAME: 'Acme' })
    expect(server.deps.settings.get().classifierModel).toBe('env/classifier')
    expect(server.deps.settings.get().teamName).toBe('Acme')
    server.deps.settings.patch({ classifierModel: null, teamName: 'Beta' }, 1)
    expect(server.deps.settings.get().classifierModel).toBeNull()
    expect(server.deps.settings.get().teamName).toBe('Beta')
  })
})

describe('settings routes', () => {
  test('PATCH validates and persists the new knobs; GET returns them', async () => {
    const server = await boot()
    const patch = async (body: unknown): Promise<Response> =>
      await server.app.request('/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await patch({ connectorHealthTtlMs: 5000, longRunChunkSteps: 20 })).status).toBe(200)
    expect((await patch({ longRunChunkSteps: 3 })).status).toBe(400)
    expect((await patch({ classifierProfile: 'nope' })).status).toBe(400)
    const got = (await (await server.app.request('/settings')).json()) as Record<string, unknown>
    expect(got.connectorHealthTtlMs).toBe(5000)
    expect(got.longRunChunkSteps).toBe(20)
    expect(got.classifierModel).toBeNull()
  })
  test('a legacy profile:model env value is shown split', async () => {
    const server = await boot({ TEAM_CLASSIFIER_MODEL: 'openrouter:x/y' })
    const got = (await (await server.app.request('/settings')).json()) as Record<string, unknown>
    expect(got.classifierProfile).toBe('openrouter')
    expect(got.classifierModel).toBe('x/y')
  })
})

describe('changes apply on the next call, without a restart', () => {
  test('classifier model', async () => {
    const server = await boot()
    const { models } = server
    expect(models.classifierOverride?.()).toBeUndefined() // same as the agent
    server.deps.settings.patch({ classifierModel: 'cheap/one' }, 1)
    expect(modelIdOf(models.classifierOverride?.())).toBe('cheap/one')
    expect(modelIdOf(models.classifierModel?.())).toBe('cheap/one')
    server.deps.settings.patch({ classifierModel: 'cheap/two' }, 2)
    expect(modelIdOf(models.classifierOverride?.())).toBe('cheap/two')
    server.deps.settings.patch({ classifierModel: null }, 3)
    expect(models.classifierOverride?.()).toBeUndefined()
  })
  test('web search model', async () => {
    const server = await boot()
    const calls: string[] = []
    const controller = new AbortController()
    // the fetch of the model call: note the model asked for, then abort (no retries, no network)
    const original = globalThis.fetch
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      try {
        calls.push(String((JSON.parse(String(init?.body)) as { model?: string }).model))
      } catch {}
      throw new DOMException('stop', 'AbortError')
    }) as never
    const probe = async (): Promise<string> => {
      calls.length = 0
      try {
        await server.models.search?.('q', { signal: controller.signal })
      } catch {
        // the stub never answers: only the requested model matters
      }
      return calls.join(',')
    }
    try {
      expect(await probe()).toContain('google/gemini-2.5-flash')
      server.deps.settings.patch({ searchModel: 'other/search-model' }, 1)
      expect(await probe()).toContain('other/search-model')
      server.deps.settings.patch({ searchModel: null }, 2)
      expect(await probe()).toContain('google/gemini-2.5-flash')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('models report', () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    id: 'openrouter',
    label: 'OpenRouter',
    enabled: true,
    isDefault: true,
    defaultModel: 'anthropic/claude-sonnet-5.5',
    ...over,
  })
  const agent = (name: string, model: string | null = null): AgentDef =>
    ({ name, model, modelProfile: null, archivedAt: null }) as AgentDef
  const base = {
    settings: {
      defaultModel: null,
      defaultProfile: null,
      classifierModel: null,
      classifierProfile: null,
      searchModel: null,
      searchProfile: null,
    },
    searchModelOf: (id: string) => (id === 'openrouter' ? 'google/gemini-2.5-flash' : undefined),
  }

  test('warns when nothing picks a model and the built-in fallback is used', () => {
    const r = modelsReport({
      ...base,
      profiles: [profile()],
      agents: [agent('Lead'), agent('Writer', 'deepseek/x')],
      defaultModelSource: () => 'built-in',
    })
    expect(r.workspaceDefault).toMatchObject({
      modelId: 'anthropic/claude-sonnet-5.5',
      source: 'built-in',
    })
    expect(r.agentsOnFallback).toEqual(['Lead'])
    expect(r.warnings.join(' ')).toContain('No default model is picked')
    const classifier = r.background.find((b) => b.key === 'classifier')
    expect(classifier).toMatchObject({ source: 'agent', modelId: null })
    expect(r.background.find((b) => b.key === 'search')).toMatchObject({
      source: 'built-in',
      modelId: 'google/gemini-2.5-flash',
    })
    expect(r.background.map((b) => b.key)).toEqual([
      'classifier',
      'search',
      'compaction',
      'heartbeat',
      'programs',
    ])
  })
  test('no warning when the default model is picked (setting or TEAM_MODEL)', () => {
    const picked = modelsReport({
      ...base,
      settings: { ...base.settings, defaultModel: 'deepseek/v4' },
      profiles: [profile()],
      agents: [agent('Lead')],
      defaultModelSource: () => 'built-in',
    })
    expect(picked.workspaceDefault).toMatchObject({ modelId: 'deepseek/v4', source: 'setting' })
    expect(picked.warnings).toEqual([])
    const env = modelsReport({
      ...base,
      profiles: [profile({ defaultModel: 'deepseek/env' })],
      agents: [agent('Lead')],
      defaultModelSource: () => 'env',
    })
    expect(env.workspaceDefault?.source).toBe('env')
    expect(env.warnings).toEqual([])
  })
  test('a picked classifier and search model are reported as settings', () => {
    const r = modelsReport({
      ...base,
      settings: {
        ...base.settings,
        defaultModel: 'a/b',
        classifierModel: 'cheap/c',
        searchModel: 'x/s',
      },
      profiles: [profile()],
      agents: [],
      defaultModelSource: () => 'built-in',
    })
    expect(r.background[0]).toMatchObject({
      source: 'setting',
      modelId: 'cheap/c',
      profileId: 'openrouter',
    })
    expect(r.background[1]).toMatchObject({ source: 'setting', modelId: 'x/s' })
  })
  test('no provider: no default, no crash', () => {
    const r = modelsReport({
      ...base,
      profiles: [],
      agents: [],
      defaultModelSource: () => 'built-in',
    })
    expect(r.workspaceDefault).toBeNull()
  })
})
