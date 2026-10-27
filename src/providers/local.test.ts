import { describe, expect, test } from 'bun:test'
import {
  llamaCppProvider,
  lmStudioProvider,
  ollamaProvider,
  openAICompatibleProvider,
  vllmProvider,
} from './builtin.ts'
import { validateSettings } from './form.ts'
import type { ListedModel, ProviderDefinition } from './types.ts'

const create = () => (id: string) => ({ id }) as never

type Route = (body: unknown) => unknown
/** A fake server: `METHOD path` → JSON (or a status number). Unknown routes answer 404. */
function server(routes: Record<string, unknown>): {
  fetch: typeof globalThis.fetch
  calls: Array<{ method: string; url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = []
  const fake = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string> })
    const key = `${method} ${new URL(url).pathname}`
    if (!(key in routes)) return new Response('not found', { status: 404 })
    const r = routes[key]
    const body = typeof r === 'function' ? (r as Route)(JSON.parse(String(init?.body))) : r
    if (typeof body === 'number') return new Response('err', { status: body })
    return new Response(JSON.stringify(body))
  }) as unknown as typeof globalThis.fetch
  return { fetch: fake, calls }
}

async function list(
  def: ProviderDefinition,
  settings: Record<string, unknown>,
  fetch: typeof globalThis.fetch,
): Promise<ListedModel[]> {
  const s = validateSettings(def.settings, settings)
  return (def.listModels as NonNullable<ProviderDefinition['listModels']>)(s, { fetch })
}

const byId = (models: ListedModel[]) => Object.fromEntries(models.map((m) => [m.id, m]))

describe('local server presets', () => {
  test('ids, labels and default base URLs; no API key needed', () => {
    const defs = [ollamaProvider, lmStudioProvider, vllmProvider, llamaCppProvider].map((f) =>
      f({ createOpenAICompatible: create }),
    )
    expect(defs.map((d) => [d.id, d.label])).toEqual([
      ['ollama', 'Ollama'],
      ['lmstudio', 'LM Studio'],
      ['vllm', 'vLLM'],
      ['llamacpp', 'llama.cpp'],
    ])
    const s = validateSettings((defs[0] as ProviderDefinition).settings, {}) as { baseURL: string }
    expect(s.baseURL).toBe('http://localhost:11434/v1')
  })

  test('Ollama: running context > Modelfile num_ctx > profile > assumed 4K; capabilities; free', async () => {
    const shows: Record<string, unknown> = {
      'qwen3:8b': {
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: { 'qwen3.context_length': 40960 },
        parameters: 'temperature 0.6',
      },
      'llava:7b': {
        capabilities: ['completion', 'vision'],
        model_info: { 'llama.context_length': 32768 },
        parameters: 'num_ctx 16384\nstop "<|im_end|>"',
      },
      'tiny:1b': { capabilities: ['completion'], model_info: { 'tiny.context_length': 2048 } },
      'gpt-oss:120b-cloud': { capabilities: ['completion', 'tools'] },
    }
    const { fetch, calls } = server({
      'GET /v1/models': { data: Object.keys(shows).map((id) => ({ id })) },
      'GET /api/ps': { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 8192 }] },
      'POST /api/show': (b: unknown) => shows[(b as { model: string }).model] ?? 404,
    })
    const def = ollamaProvider({ createOpenAICompatible: create })
    const m = byId(
      await list(def, { baseURL: 'http://gpu:11434/v1', headers: { 'x-a': '1' } }, fetch),
    )

    expect(m['qwen3:8b']?.info).toEqual({
      contextWindow: 8192,
      pricing: { input: 0, output: 0 },
      inputModalities: ['text'],
    })
    expect(m['qwen3:8b']).toMatchObject({ tools: true, reasoning: true })
    expect(m['qwen3:8b']?.description).toBe('Loaded with a 8K context (trained for 40K).')

    expect(m['llava:7b']?.info?.contextWindow).toBe(16384)
    expect(m['llava:7b']?.info?.inputModalities).toEqual(['text', 'image'])
    expect(m['llava:7b']?.tools).toBe(false)

    // trained for less than the assumed default: its own maximum
    expect(m['tiny:1b']?.info?.contextWindow).toBe(2048)
    // a cloud model is not free
    expect(m['gpt-oss:120b-cloud']?.info?.pricing).toBeUndefined()
    expect(m['gpt-oss:120b-cloud']?.info?.contextWindow).toBe(4096)
    expect(m['gpt-oss:120b-cloud']?.description).toContain('OLLAMA_CONTEXT_LENGTH')

    // native endpoints at the root, with the profile's headers
    expect(calls.some((c) => c.url === 'http://gpu:11434/api/ps' && c.headers['x-a'] === '1')).toBe(
      true,
    )

    // the profile's context length wins over the assumed default, not over what the server says
    const withProfile = byId(
      await list(def, { baseURL: 'http://gpu:11434/v1', contextWindow: 32768 }, fetch),
    )
    expect(withProfile['gpt-oss:120b-cloud']?.info?.contextWindow).toBe(32768)
    expect(withProfile['qwen3:8b']?.info?.contextWindow).toBe(8192)
    expect(withProfile['llava:7b']?.info?.contextWindow).toBe(16384)
  })

  test('Ollama behind a proxy without native endpoints keeps the ids', async () => {
    const { fetch } = server({ 'GET /v1/models': { data: [{ id: 'a' }] } })
    const models = await list(
      ollamaProvider({ createOpenAICompatible: create }),
      { baseURL: 'https://p.example/v1' },
      fetch,
    )
    expect(models[0]?.id).toBe('a')
    expect(models[0]?.info?.contextWindow).toBe(4096)
    expect(models[0]?.tools).toBeUndefined()
  })

  test('LM Studio: loaded context, display names, capabilities; embeddings left out', async () => {
    const { fetch } = server({
      'GET /v1/models': {
        data: [{ id: 'google/gemma-4' }, { id: 'deepseek-r1' }, { id: 'nomic-embed' }],
      },
      'GET /api/v1/models': {
        models: [
          {
            type: 'llm',
            key: 'google/gemma-4',
            display_name: 'Gemma 4',
            max_context_length: 262144,
            capabilities: { vision: true, trained_for_tool_use: true },
            loaded_instances: [{ id: 'google/gemma-4', config: { context_length: 8192 } }],
          },
          { type: 'llm', key: 'deepseek-r1', max_context_length: 131072, loaded_instances: [] },
          { type: 'embedding', key: 'nomic-embed', loaded_instances: [] },
        ],
      },
    })
    const m = await list(lmStudioProvider({ createOpenAICompatible: create }), {}, fetch)
    expect(m.map((x) => x.id)).toEqual(['google/gemma-4', 'deepseek-r1'])
    expect(m[0]).toMatchObject({ name: 'Gemma 4', tools: true })
    expect(m[0]?.info).toEqual({
      contextWindow: 8192,
      pricing: { input: 0, output: 0 },
      inputModalities: ['text', 'image'],
    })
    expect(m[1]?.info?.contextWindow).toBe(4096)
    expect(m[1]?.description).toContain('Assumed 4K')
  })

  test('LM Studio falls back to /api/v0/models', async () => {
    const { fetch } = server({
      'GET /v1/models': { data: [{ id: 'qwen' }] },
      'GET /api/v0/models': {
        data: [
          {
            id: 'qwen',
            type: 'llm',
            state: 'loaded',
            max_context_length: 32768,
            loaded_context_length: 16384,
            capabilities: ['tool_use'],
          },
        ],
      },
    })
    const m = await list(lmStudioProvider({ createOpenAICompatible: create }), {}, fetch)
    expect(m[0]).toMatchObject({ tools: true, info: { contextWindow: 16384 } })
  })

  test('vLLM: max_model_len is the context window', async () => {
    const { fetch } = server({
      'GET /v1/models': { data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 32768 }] },
    })
    const m = await list(vllmProvider({ createOpenAICompatible: create }), {}, fetch)
    expect(m[0]?.info).toEqual({ contextWindow: 32768, pricing: { input: 0, output: 0 } })
  })

  test('llama.cpp: n_ctx of /props', async () => {
    const { fetch } = server({
      'GET /v1/models': { data: [{ id: 'model.gguf' }] },
      'GET /props': { default_generation_settings: { n_ctx: 8192 } },
    })
    const m = await list(llamaCppProvider({ createOpenAICompatible: create }), {}, fetch)
    expect(m[0]?.info).toEqual({ contextWindow: 8192, pricing: { input: 0, output: 0 } })
  })

  test('custom OpenAI-compatible: the profile context length fills unknown windows only', async () => {
    const { fetch } = server({
      'GET /v1/models': { data: [{ id: 'a' }, { id: 'b', max_model_len: 4000 }] },
    })
    const def = openAICompatibleProvider({ createOpenAICompatible: create, apiKeyOptional: true })
    const m = byId(await list(def, { baseURL: 'http://h/v1', contextWindow: 65536 }, fetch))
    expect(m.a?.info).toEqual({ contextWindow: 65536 })
    expect(m.b?.info).toEqual({ contextWindow: 4000 })
    // without one, nothing is made up
    const plain = byId(await list(def, { baseURL: 'http://h/v1' }, fetch))
    expect(plain.a?.info).toBeUndefined()
  })
})
