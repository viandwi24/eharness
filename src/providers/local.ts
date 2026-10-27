/**
 * What local model servers say about their models, beyond the ids of `GET /v1/models`: the
 * context the server really runs a model with, tools / vision / thinking support, and a zero price.
 * Internal: the presets of `builtin.ts` (`ollamaProvider`, `lmStudioProvider`, `vllmProvider`,
 * `llamaCppProvider`) use it.
 *
 * Every function here is best effort: a server that does not answer the native endpoints (an older
 * version, a proxy in front) keeps the plain id list. Nothing here throws.
 *
 * The context window matters most. A local server runs a model with a context it was started with,
 * often far below what the model was trained for (Ollama: 4K on a GPU under 24 GB; LM Studio: 4K
 * unless the model was loaded with more). A prompt longer than that is cut silently by the server,
 * so the harness must compact before it: the window reported here is the running one, never the
 * trained maximum.
 *
 * @see docs/specs/23-providers.md#6-built-in-definitions
 */
import type { ModelInfo } from '../index.ts'
import type { ListedModel, ProviderContext } from './types.ts'

/** The settings of a local server profile the functions here need. */
export interface LocalServer {
  baseURL: string
  headers: Record<string, string>
  /** The context the server runs models with, from the profile (when the server does not say). */
  contextWindow?: number | undefined
}

/** Ollama and LM Studio load a model with this context unless told otherwise (small GPUs). */
export const ASSUMED_LOCAL_CONTEXT = 4096

const FREE: ModelInfo['pricing'] = { input: 0, output: 0 }
/** At most this many `POST /api/show` calls at once. */
const SHOW_CONCURRENCY = 4

/** `http://host:11434/v1` → `http://host:11434` (native endpoints live at the root). */
export const serverRoot = (baseURL: string): string =>
  baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')

/** `32768` → `32K`, `131072` → `128K`. */
export const tokensLabel = (n: number): string =>
  n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

async function tryJson(
  url: string,
  headers: Record<string, string>,
  ctx: ProviderContext,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  try {
    const response = await ctx.fetch(url, {
      method: init.method ?? 'GET',
      headers:
        init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Where a context window came from, for the model's description. */
type ContextSource = 'running' | 'model' | 'profile' | 'assumed'

interface Picked {
  window: number
  source: ContextSource
}

/** The running context, else the model's own setting, else the profile, else the assumed default. */
function pickContext(
  running: number | undefined,
  modelSetting: number | undefined,
  server: LocalServer,
  trained: number | undefined,
): Picked {
  if (running !== undefined) return { window: running, source: 'running' }
  if (modelSetting !== undefined) return { window: modelSetting, source: 'model' }
  if (server.contextWindow !== undefined) return { window: server.contextWindow, source: 'profile' }
  return {
    window:
      trained === undefined ? ASSUMED_LOCAL_CONTEXT : Math.min(trained, ASSUMED_LOCAL_CONTEXT),
    source: 'assumed',
  }
}

function contextNote(p: Picked, trained: number | undefined, server: string, how: string): string {
  const max =
    trained === undefined || trained === p.window ? '' : ` (trained for ${tokensLabel(trained)})`
  switch (p.source) {
    case 'running':
      return `Loaded with a ${tokensLabel(p.window)} context${max}.`
    case 'model':
      return `Its settings give it a ${tokensLabel(p.window)} context${max}.`
    case 'profile':
      return `Context ${tokensLabel(p.window)} from the profile${max}.`
    case 'assumed':
      return `Assumed ${tokensLabel(p.window)} context, ${server}'s default on a small GPU${max}. Set "Context length" on the profile when the server runs more (${how}).`
  }
}

function withInfo(m: ListedModel, info: ModelInfo, extra: Partial<ListedModel> = {}): ListedModel {
  return { ...m, ...extra, info: { ...m.info, ...info } }
}

// ---------------------------------------------------------------------- Ollama

/** Ollama cloud models (`gpt-oss:120b-cloud`) are billed by Ollama, not free. */
const isOllamaCloud = (id: string): boolean => /[-:]cloud$/.test(id)

/**
 * `GET /api/ps` (the context of loaded models), then `POST /api/show` per model: capabilities
 * (`tools`, `vision`, `thinking`), the trained context (`model_info.<arch>.context_length`) and a
 * `num_ctx` of the Modelfile.
 */
export async function describeOllama(
  models: readonly ListedModel[],
  server: LocalServer,
  ctx: ProviderContext,
): Promise<ListedModel[]> {
  const root = serverRoot(server.baseURL)
  const running = new Map<string, number>()
  const ps = obj(await tryJson(`${root}/api/ps`, server.headers, ctx))
  for (const m of Array.isArray(ps?.models) ? ps.models : []) {
    const o = obj(m)
    const n = num(o?.context_length)
    if (n === undefined) continue
    for (const key of [o?.name, o?.model]) if (typeof key === 'string') running.set(key, n)
  }
  return mapLimited(models, SHOW_CONCURRENCY, async (m) => {
    const show = obj(
      await tryJson(`${root}/api/show`, server.headers, ctx, {
        method: 'POST',
        body: { model: m.id },
      }),
    )
    const info = obj(show?.model_info)
    const trained = info
      ? num(Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1])
      : undefined
    const params = typeof show?.parameters === 'string' ? show.parameters : ''
    const numCtx = num(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(params)?.[1]))
    const caps = Array.isArray(show?.capabilities)
      ? show.capabilities.filter((c) => typeof c === 'string')
      : undefined
    const picked = pickContext(running.get(m.id), numCtx, server, trained)
    return withInfo(
      m,
      {
        contextWindow: picked.window,
        ...(isOllamaCloud(m.id) ? {} : { pricing: FREE }),
        ...(caps === undefined
          ? {}
          : { inputModalities: caps.includes('vision') ? ['text', 'image'] : ['text'] }),
      },
      {
        description: contextNote(picked, trained, 'Ollama', 'OLLAMA_CONTEXT_LENGTH'),
        ...(caps === undefined
          ? {}
          : { tools: caps.includes('tools'), reasoning: caps.includes('thinking') }),
      },
    )
  })
}

// ------------------------------------------------------------------- LM Studio

interface LmModel {
  id: string
  name?: string
  type?: string
  max?: number
  loaded?: number
  tools?: boolean
  vision?: boolean
}

function lmModels(v1: unknown, v0: unknown): LmModel[] | undefined {
  const a = obj(v1)?.models
  if (Array.isArray(a)) {
    return a.flatMap((raw) => {
      const o = obj(raw)
      if (typeof o?.key !== 'string') return []
      const loaded = Array.isArray(o.loaded_instances)
        ? num(obj(obj(o.loaded_instances[0])?.config)?.context_length)
        : undefined
      const caps = obj(o.capabilities)
      const max = num(o.max_context_length)
      return [
        {
          id: o.key,
          ...(typeof o.display_name === 'string' ? { name: o.display_name } : {}),
          ...(typeof o.type === 'string' ? { type: o.type } : {}),
          ...(max === undefined ? {} : { max }),
          ...(loaded === undefined ? {} : { loaded }),
          ...(typeof caps?.trained_for_tool_use === 'boolean'
            ? { tools: caps.trained_for_tool_use }
            : {}),
          ...(typeof caps?.vision === 'boolean' ? { vision: caps.vision } : {}),
        },
      ]
    })
  }
  const b = obj(v0)?.data
  if (!Array.isArray(b)) return undefined
  return b.flatMap((raw) => {
    const o = obj(raw)
    if (typeof o?.id !== 'string') return []
    const caps = Array.isArray(o.capabilities) ? o.capabilities : undefined
    const max = num(o.max_context_length)
    const loaded = o.state === 'loaded' ? num(o.loaded_context_length) : undefined
    return [
      {
        id: o.id,
        ...(typeof o.type === 'string' ? { type: o.type } : {}),
        ...(max === undefined ? {} : { max }),
        ...(loaded === undefined ? {} : { loaded }),
        ...(caps === undefined ? {} : { tools: caps.includes('tool_use') }),
        ...(o.type === 'vlm' ? { vision: true } : {}),
      },
    ]
  })
}

/** `GET /api/v1/models` (else the older `/api/v0/models`): loaded context, maximum, capabilities. */
export async function describeLmStudio(
  models: readonly ListedModel[],
  server: LocalServer,
  ctx: ProviderContext,
): Promise<ListedModel[]> {
  const root = serverRoot(server.baseURL)
  const v1 = await tryJson(`${root}/api/v1/models`, server.headers, ctx)
  const list = lmModels(
    v1,
    v1 === undefined ? await tryJson(`${root}/api/v0/models`, server.headers, ctx) : undefined,
  )
  const byId = new Map((list ?? []).map((m) => [m.id, m]))
  return models.flatMap((m) => {
    const lm = byId.get(m.id)
    // embedding models answer no chat
    if (lm?.type === 'embedding' || lm?.type === 'embeddings') return []
    const picked = pickContext(lm?.loaded, undefined, server, lm?.max)
    return [
      withInfo(
        m,
        {
          contextWindow: picked.window,
          pricing: FREE,
          ...(lm?.vision === undefined
            ? {}
            : { inputModalities: lm.vision ? ['text', 'image'] : ['text'] }),
        },
        {
          ...(lm?.name === undefined ? {} : { name: lm.name }),
          description: contextNote(
            picked,
            lm?.max,
            'LM Studio',
            'the context length you load the model with',
          ),
          ...(lm?.tools === undefined ? {} : { tools: lm.tools }),
        },
      ),
    ]
  })
}

// ------------------------------------------------------------------------ vLLM

/** vLLM reports `max_model_len` (the running limit) on `GET /v1/models`; `models` carry it already. */
export function describeVllm(models: readonly ListedModel[]): ListedModel[] {
  return models.map((m) =>
    withInfo(
      m,
      { pricing: FREE },
      m.info?.contextWindow === undefined
        ? {}
        : { description: `Serves a ${tokensLabel(m.info.contextWindow)} context (max_model_len).` },
    ),
  )
}

// ------------------------------------------------------------------- llama.cpp

/** `GET /props`: the context of the server's slots (`default_generation_settings.n_ctx`). */
export async function describeLlamaCpp(
  models: readonly ListedModel[],
  server: LocalServer,
  ctx: ProviderContext,
): Promise<ListedModel[]> {
  const props = obj(await tryJson(`${serverRoot(server.baseURL)}/props`, server.headers, ctx))
  const running = num(obj(props?.default_generation_settings)?.n_ctx) ?? num(props?.n_ctx)
  const picked =
    running === undefined ? undefined : pickContext(running, undefined, server, undefined)
  return models.map((m) =>
    withInfo(
      m,
      { pricing: FREE, ...(picked === undefined ? {} : { contextWindow: picked.window }) },
      picked === undefined
        ? {}
        : { description: `Runs a ${tokensLabel(picked.window)} context per slot (n_ctx).` },
    ),
  )
}
