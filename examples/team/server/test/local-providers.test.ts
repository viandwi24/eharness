/**
 * Local model servers (Ollama, LM Studio, vLLM, llama.cpp) and custom OpenAI-compatible endpoints:
 * listed in Settings, their models carry the context the server runs them with (and the catalog
 * knows it without opening the list), and "Test tools" tells a model that calls tools from one
 * that answers in text (on the Logs page).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { generateSecretKey, parseSecretKey, teamVault } from '../src/infra/eh/secret-vault.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const fakes: Array<{ stop(force?: boolean): unknown }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const f of fakes.splice(0)) await f.stop(true)
})

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function until(ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10))
}

/** The listing side of an Ollama server (the manager's injected fetch). */
const ollamaListing = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url))
  if (u.pathname === '/v1/models')
    return Response.json({ data: [{ id: 'qwen3:8b' }, { id: 'gemma3:1b' }] })
  if (u.pathname === '/api/ps')
    return Response.json({ models: [{ name: 'qwen3:8b', context_length: 32768 }] })
  if (u.pathname === '/api/show') {
    const { model } = JSON.parse(String(init?.body)) as { model: string }
    return Response.json(
      model === 'qwen3:8b'
        ? { capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 40960 } }
        : { capabilities: ['completion'], model_info: { 'gemma3.context_length': 32768 } },
    )
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

async function boot(): Promise<Server> {
  const server = compose({
    dbFile: ':memory:',
    env: {},
    offline: true,
    fetch: ollamaListing,
    vault: teamVault([parseSecretKey(generateSecretKey())]),
    changePollMs: 0,
    models: undefined,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.providersReady
  return server
}

type Model = {
  id: string
  contextWindow?: number
  tools?: boolean
  description?: string
  pricing?: { input: number; output: number }
  source: string
}

describe('local model servers', () => {
  test('the picker offers them; Ollama models carry the running context, tools and a zero price', async () => {
    const server = await boot()
    const providers = (await (await server.app.request('/providers')).json()) as {
      providers: Array<{ id: string; fields: Array<{ path: string; default?: unknown }> }>
    }
    const ids = providers.providers.map((p) => p.id)
    for (const id of ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'openai-compatible'])
      expect(ids).toContain(id)
    const ollama = providers.providers.find((p) => p.id === 'ollama')
    expect(ollama?.fields.find((f) => f.path === 'baseURL')?.default).toBe(
      'http://localhost:11434/v1',
    )
    expect(ollama?.fields.map((f) => f.path)).toContain('contextWindow')

    const created = await server.app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'ollama',
        id: 'gpu',
        settings: { baseURL: 'http://gpu.lan:11434/v1' },
      }),
    )
    expect(created.status).toBe(201)

    // warmed in the background: the catalog knows the running window before anyone opens the list
    const model = server.providers.manager.resolve({ profile: 'gpu', model: 'qwen3:8b' })
    const catalog = server.providers.manager.catalog()
    const windowOf = (): number | undefined =>
      typeof catalog === 'function' ? catalog(model)?.contextWindow : undefined
    await until(() => windowOf() !== undefined)
    expect(windowOf()).toBe(32768)

    const list = (await (await server.app.request('/providers/profiles/gpu/models')).json()) as {
      models: Model[]
    }
    const qwen = list.models.find((m) => m.id === 'qwen3:8b')
    expect(qwen).toMatchObject({
      contextWindow: 32768,
      tools: true,
      pricing: { input: 0, output: 0 },
    })
    expect(qwen?.description).toBe('Loaded with a 32K context (trained for 40K).')
    // not loaded, no Modelfile setting, no profile value: Ollama's small-GPU default, said so
    const gemma = list.models.find((m) => m.id === 'gemma3:1b')
    expect(gemma?.contextWindow).toBe(4096)
    expect(gemma?.description).toContain('OLLAMA_CONTEXT_LENGTH')
  })

  test('a model added by hand lists with its context length', async () => {
    const server = await boot()
    await server.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'ollama', id: 'gpu', settings: {} }),
    )
    const patched = await server.app.request(
      '/providers/profiles/gpu',
      send('PATCH', {
        models: { extra: [{ id: 'my-finetune', name: 'My finetune', contextWindow: 65536 }] },
      }),
    )
    expect(patched.status).toBe(200)
    const list = (await (await server.app.request('/providers/profiles/gpu/models')).json()) as {
      models: Model[]
    }
    expect(list.models.find((m) => m.id === 'my-finetune')).toMatchObject({
      source: 'extra',
      contextWindow: 65536,
    })
  })

  test('Test tools: a tool call passes, a text answer fails with a hint, both reach the Logs page', async () => {
    // an OpenAI-compatible chat endpoint: `tooly` calls the tool, `chatty` answers in text
    const fake = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string; tools?: unknown[] }
        const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
        const message =
          body.model === 'tooly' && (body.tools?.length ?? 0) > 0
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'echo', arguments: JSON.stringify({ word: 'pong' }) },
                  },
                ],
              }
            : { role: 'assistant', content: 'pong' }
        return Response.json({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: message.content ? 'stop' : 'tool_calls' }],
          usage,
        })
      },
    })
    fakes.push(fake)
    const server = await boot()
    await server.app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'openai-compatible',
        id: 'custom',
        settings: { baseURL: `http://127.0.0.1:${fake.port}/v1`, headers: { 'x-team': 'a' } },
      }),
    )
    const probe = async (modelId: string) =>
      (await (
        await server.app.request('/providers/profiles/custom/probe', send('POST', { modelId }))
      ).json()) as { ok: boolean; tools: boolean; message: string }

    expect(await probe('tooly')).toMatchObject({ ok: true, tools: true })
    const chatty = await probe('chatty')
    expect(chatty).toMatchObject({ ok: true, tools: false })
    expect(chatty.message).toContain('--enable-auto-tool-choice')

    let rows: Array<{ kind: string }> = []
    await until(async () => {
      rows = ((await (await server.app.request('/logs')).json()) as { items: typeof rows }).items
      return rows.length >= 2
    })
    expect(rows.filter((r) => r.kind === 'other')).toHaveLength(2)

    // an unknown profile is a 404, never a model call
    const missing = await server.app.request(
      '/providers/profiles/nope/probe',
      send('POST', { modelId: 'tooly' }),
    )
    expect(missing.status).toBe(404)
  })
})
