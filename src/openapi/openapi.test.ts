import { describe, expect, test } from 'bun:test'
import {
  defineHarnessAgent,
  type HarnessContext,
  isHarnessError,
  type ToolSource,
} from '../index.ts'
import { scriptedModel } from '../testing/index.ts'
import { bigSpec, PETSTORE_SPEC } from './fixture.ts'
import { type OpenApiToolsOptions, openApiTools, riskFromMethod } from './index.ts'

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access in assertions
type Loose = any

type Call = { url: string; init: RequestInit }

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return respond(call)
  }
  return { fetch: impl as typeof fetch, calls }
}

const json = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })

function ctx(extra: Partial<HarnessContext> = {}): HarnessContext {
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  return { signal: new AbortController().signal, log, runtime: {}, ...extra } as HarnessContext
}

async function tools(source: ToolSource, c: HarnessContext = ctx()) {
  return (await source.list(c)) as Record<
    string,
    {
      description: string
      inputSchema: { jsonSchema: Record<string, Loose> }
      metadata?: Record<string, Loose>
      deferLoading?: boolean
      execute: (input: unknown, o?: object) => Promise<unknown>
    }
  >
}

const BASE = 'https://api.example.com/v1'
const make = (over: Partial<OpenApiToolsOptions> = {}, spec: object | string = PETSTORE_SPEC) =>
  openApiTools(spec, { name: 'pets', baseUrl: BASE, ...over })

function configError(fn: () => unknown, text: string): void {
  try {
    fn()
  } catch (error) {
    expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
    expect((error as Error).message).toContain(text)
    return
  }
  throw new Error('expected EH_CONFIG_INVALID')
}

describe('loading', () => {
  test('accepts a JSON string and an object', async () => {
    const a = await tools(make({}, JSON.stringify(PETSTORE_SPEC)))
    const b = await tools(make())
    expect(Object.keys(a)).toEqual(Object.keys(b))
    expect(make().id).toBe('openapi:pets')
  })

  test('YAML string, Swagger 2.0 and bad version are config errors', () => {
    configError(() => make({}, 'openapi: 3.0.0\npaths: {}'), 'YAML is not supported')
    configError(() => make({}, { swagger: '2.0', paths: {} }), 'Swagger 2.0')
    configError(() => make({}, { openapi: '4.0.0', paths: {} }), 'must be 3.0.x or 3.1.x')
  })

  test('remote $ref is a config error', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/a': { get: { operationId: 'a', parameters: [{ $ref: 'https://evil.test/p.json' }] } },
      },
    }
    configError(() => make({}, spec), 'remote $ref')
  })

  test('baseUrl is required unless useSpecServers', () => {
    configError(() => openApiTools(PETSTORE_SPEC, { name: 'pets' }), '`baseUrl` is required')
    configError(() => make({ baseUrl: 'ftp://x' }), 'http(s)')
    expect(() =>
      openApiTools(
        { ...PETSTORE_SPEC, servers: [{ url: 'https://s.example.com' }] },
        { name: 'p', useSpecServers: true },
      ),
    ).not.toThrow()
  })
})

describe('tools', () => {
  test('names, prefix, descriptions and grouped input schema', async () => {
    const t = await tools(make())
    expect(Object.keys(t).sort()).toEqual(
      ['pets_createPet', 'pets_deletePet', 'pets_getPet', 'pets_listPets', 'pets_listUsers'].sort(),
    )
    const list = t.pets_listPets
    expect(list?.description).toContain('GET /pets')
    const schema = list?.inputSchema.jsonSchema
    expect(Object.keys(schema?.properties.query.properties)).toEqual(['limit', 'tags'])
    // API-key header and cookie parameters are not model inputs
    expect(Object.keys(schema?.properties.headers.properties)).toEqual(['X-Request-Id'])
    expect(t.pets_getPet?.inputSchema.jsonSchema.required).toEqual(['path'])
    expect(t.pets_createPet?.inputSchema.jsonSchema.required).toEqual(['body'])
  })

  test('the non-JSON body operation is skipped; prefix and names options', async () => {
    const t = await tools(make({ prefix: '', names: { listPets: 'pets' } }))
    expect(t.uploadPhoto).toBeUndefined()
    expect(Object.keys(t)).toContain('pets')
    expect(Object.keys(t)).toContain('getPet')
    const byFn = await tools(make({ names: (op) => `${op.method}-${op.operationId}` }))
    expect(Object.keys(byFn)).toContain('pets_get-listPets')
  })

  test('names without operationId use method and path', async () => {
    const spec = { openapi: '3.1.0', paths: { '/a/{id}/b': { get: {} } } }
    expect(Object.keys(await tools(make({}, spec)))).toEqual(['pets_get_a_id_b'])
  })

  test('duplicate names are a config error', () => {
    configError(() => make({ names: () => 'same' }), "duplicate tool name 'pets_same'")
  })

  test('$ref schemas: recursion becomes {}, readOnly dropped, nullable converted', async () => {
    const spec = {
      ...PETSTORE_SPEC,
      paths: {
        '/p': {
          post: {
            operationId: 'p',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    }
    const t = await tools(make({}, spec))
    const body = t.pets_p?.inputSchema.jsonSchema.properties.body
    expect(body.properties.id).toBeUndefined() // readOnly
    expect(body.properties.tag.type).toEqual(['string', 'null'])
    expect(body.properties.friend.description).toBe('(recursive: #/components/schemas/Pet)')
    expect(body.required).toEqual(['name'])
  })

  test('a fan-out schema is cut at maxSchemaBytes, quickly, with a warning', async () => {
    const schemas: Record<string, unknown> = {}
    for (let i = 0; i < 6; i++) {
      schemas[`S${i}`] = {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 14 }, (_, k) => [
            `f${k}`,
            { $ref: `#/components/schemas/S${i + 1}` },
          ]),
        ),
      }
    }
    schemas.S6 = { type: 'string' }
    const spec = {
      openapi: '3.1.0',
      components: { schemas },
      paths: {
        '/x': {
          post: {
            operationId: 'x',
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
            },
          },
        },
      },
    }
    const warnings: string[] = []
    const log = { debug() {}, info() {}, warn: (m: string) => void warnings.push(m), error() {} }
    const started = Date.now()
    const t = await tools(make({ schema: { maxSchemaBytes: 8_000 } }, spec), ctx({ log } as never))
    expect(Date.now() - started).toBeLessThan(2_000)
    const size = JSON.stringify(t.pets_x?.inputSchema.jsonSchema).length
    expect(size).toBeLessThan(20_000)
    expect(JSON.stringify(t.pets_x?.inputSchema.jsonSchema)).toContain('too large')
    expect(warnings.join('\n')).toContain('maxSchemaBytes')
  })

  test('maxDepth truncates deep schemas', async () => {
    const deep = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: { b: { type: 'object', properties: { c: { type: 'string' } } } },
        },
      },
    }
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/d': {
          post: {
            operationId: 'd',
            requestBody: { content: { 'application/json': { schema: deep } } },
          },
        },
      },
    }
    const t = await tools(make({ schema: { maxDepth: 1 } }, spec))
    const a = t.pets_d?.inputSchema.jsonSchema.properties.body.properties.a
    expect(a.properties.b.description).toContain('too deep')
  })
})

describe('selection', () => {
  const names = async (over: Partial<OpenApiToolsOptions>) =>
    Object.keys(await tools(make(over))).sort()

  test('include / exclude by method, path glob, tag and operationId', async () => {
    expect(await names({ include: { methods: ['get'] } })).toEqual([
      'pets_getPet',
      'pets_listPets',
      'pets_listUsers',
    ])
    expect(await names({ include: { paths: ['/pets/*'] } })).toEqual([
      'pets_deletePet',
      'pets_getPet',
    ])
    expect(await names({ include: { paths: ['/pets/**'] } })).toEqual([
      'pets_deletePet',
      'pets_getPet',
    ])
    expect(await names({ include: { tags: ['admin'] } })).toEqual(['pets_listUsers'])
    expect(await names({ include: { operationIds: ['getPet', 'createPet'] } })).toEqual([
      'pets_createPet',
      'pets_getPet',
    ])
    expect(await names({ include: { tags: ['pets'], methods: ['get'] } })).toEqual([
      'pets_getPet',
      'pets_listPets',
    ])
    expect(await names({ exclude: { methods: ['delete', 'post'] } })).toEqual([
      'pets_getPet',
      'pets_listPets',
      'pets_listUsers',
    ])
    expect(await names({ include: [{ tags: ['admin'] }, (op) => op.method === 'delete'] })).toEqual(
      ['pets_deletePet', 'pets_listUsers'],
    )
    expect(
      await names({ include: { tags: ['pets'] }, exclude: { operationIds: ['deletePet'] } }),
    ).toEqual(['pets_createPet', 'pets_getPet', 'pets_listPets'])
  })

  test('count guard and defer auto', async () => {
    configError(() => make({}, bigSpec(65)), '65 operations selected')
    expect(() => make({ maxTools: 100 }, bigSpec(65))).not.toThrow()
    const small = await tools(make({}, bigSpec(20)))
    expect(Object.values(small).some((t) => t.deferLoading)).toBe(false)
    const large = await tools(make({}, bigSpec(21)))
    expect(Object.values(large).every((t) => t.deferLoading === true)).toBe(true)
    const forced = await tools(make({ defer: true }, bigSpec(2)))
    expect(Object.values(forced).every((t) => t.deferLoading === true)).toBe(true)
    const never = await tools(make({ defer: false }, bigSpec(30)))
    expect(Object.values(never).some((t) => t.deferLoading)).toBe(false)
    // a 200-operation spec is fine once filtered
    const filtered = await tools(make({ include: { operationIds: ['op1', 'op2'] } }, bigSpec(200)))
    expect(Object.keys(filtered)).toEqual(['pets_op1', 'pets_op2'])
  })
})

describe('risk', () => {
  test('riskFromMethod', () => {
    expect(riskFromMethod('GET')).toBe('read')
    expect(riskFromMethod('head')).toBe('read')
    expect(riskFromMethod('DELETE')).toBe('destructive')
    for (const m of ['post', 'put', 'patch']) expect(riskFromMethod(m)).toBe('write')
  })

  test('metadata.risk from the method, overridable', async () => {
    const t = await tools(make())
    expect(t.pets_listPets?.metadata?.risk).toBe('read')
    expect(t.pets_createPet?.metadata?.risk).toBe('write')
    expect(t.pets_deletePet?.metadata?.risk).toBe('destructive')
    const o = await tools(make({ risk: (op) => (op.method === 'get' ? undefined : 'external') }))
    expect(o.pets_listPets?.metadata?.risk).toBe('read')
    expect(o.pets_createPet?.metadata?.risk).toBe('external')
    const bad = await tools(make({ risk: () => 'nope' as never }))
    expect(bad.pets_createPet?.metadata?.risk).toBe('write')
  })
})

describe('requests', () => {
  test('GET: baseUrl, query serialization, headers, JSON result; spec servers ignored', async () => {
    const f = fakeFetch(() => json([{ id: 1, name: 'Rex' }]))
    const t = await tools(make({ fetch: f.fetch, headers: () => ({ authorization: 'Bearer T' }) }))
    const out = await t.pets_listPets?.execute({
      query: { limit: 5, tags: ['a b', 'c'] },
      headers: { 'X-Request-Id': 'r1' },
    })
    expect(out).toEqual([{ id: 1, name: 'Rex' }])
    expect(f.calls[0]?.url).toBe(`${BASE}/pets?limit=5&tags=a%20b&tags=c`)
    expect(f.calls[0]?.url).not.toContain('169.254')
    const headers = f.calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer T')
    expect(headers['X-Request-Id']).toBe('r1')
    expect(f.calls[0]?.init.method).toBe('GET')
    expect(f.calls[0]?.init.redirect).toBe('manual')
  })

  test('useSpecServers uses servers[0] with variable defaults', async () => {
    const f = fakeFetch(() => json({}))
    const spec = {
      ...PETSTORE_SPEC,
      servers: [{ url: 'https://{env}.example.com/v2', variables: { env: { default: 'prod' } } }],
    }
    const t = await tools(openApiTools(spec, { name: 'p', useSpecServers: true, fetch: f.fetch }))
    await t.p_listUsers?.execute({})
    expect(f.calls[0]?.url).toBe('https://prod.example.com/v2/admin/users')
  })

  test('baseUrl function is resolved per call', async () => {
    const f = fakeFetch(() => json({}))
    const t = await tools(
      make({ baseUrl: (c) => `https://${String(c.runtime.tenant)}.example.com`, fetch: f.fetch }),
      ctx({ runtime: { tenant: 'acme' } }),
    )
    await t.pets_listUsers?.execute({})
    expect(f.calls[0]?.url).toBe('https://acme.example.com/admin/users')
  })

  test('POST sends a JSON body; path params are encoded', async () => {
    const f = fakeFetch(() => json({ id: 2 }, { status: 201 }))
    const t = await tools(make({ fetch: f.fetch }))
    await t.pets_createPet?.execute({ body: { name: 'Tom' } })
    expect(f.calls[0]?.init.body).toBe('{"name":"Tom"}')
    const postHeaders = f.calls[0]?.init.headers as Record<string, string>
    expect(postHeaders['content-type']).toBe('application/json')
    await t.pets_getPet?.execute({ path: { petId: 'a b/c' } })
    expect(f.calls[1]?.url).toBe(`${BASE}/pets/a%20b%2Fc`)
  })

  test('path params cannot escape: .. and empty are rejected', async () => {
    const f = fakeFetch(() => json({}))
    const t = await tools(make({ fetch: f.fetch }))
    for (const petId of ['..', '.', '']) {
      const out = await t.pets_getPet?.execute({ path: { petId } })
      expect(String(out)).toContain('REJECTED')
    }
    for (const petId of [
      '../../admin',
      '..%2Fadmin',
      '%2e%2e',
      'a/../b',
      'a\\..\\b',
      'x%2Fy',
      'x%5Cy',
    ]) {
      const out = await t.pets_getPet?.execute({ path: { petId } })
      expect(String(out)).toContain('REJECTED')
    }
    expect(f.calls).toEqual([])
    // a harmless value with a slash stays one encoded segment
    expect(await t.pets_getPet?.execute({ path: { petId: 'a b/c.d' } })).toEqual({})
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/pets/a%20b%2Fc.d`])
  })

  test('invalid input is rejected as a string, nothing is sent', async () => {
    const f = fakeFetch(() => json({}))
    const t = await tools(make({ fetch: f.fetch }))
    expect(await t.pets_getPet?.execute({})).toContain("missing required path parameter 'petId'")
    expect(await t.pets_createPet?.execute({})).toContain("missing required 'body'")
    expect(await t.pets_listPets?.execute({ query: { evil: 1 } })).toContain(
      "unknown query parameter 'evil'",
    )
    expect(await t.pets_listUsers?.execute({ body: {} })).toContain('takes no')
    expect(f.calls).toHaveLength(0)
  })

  test('auth comes from headers(); the model cannot set credentials', async () => {
    const f = fakeFetch(() => json({}))
    const seen: string[] = []
    const t = await tools(
      make({
        fetch: f.fetch,
        headers: (_c, op) => {
          seen.push(`${op.method} ${op.path}`)
          return { 'X-Api-Key': 'secret' }
        },
      }),
    )
    for (const name of ['Authorization', 'cookie', 'X-Api-Key']) {
      const out = await t.pets_listPets?.execute({ headers: { [name]: 'mine' } })
      expect(String(out)).toContain('REJECTED')
    }
    expect(f.calls).toHaveLength(0)
    await t.pets_listPets?.execute({})
    const sent = f.calls[0]?.init.headers as Record<string, string>
    expect(sent['X-Api-Key'] ?? sent['x-api-key']).toBe('secret')
    expect(seen).toEqual(['get /pets'])
    // a failing headers() is a string, not a throw
    const broken = await tools(
      make({
        fetch: f.fetch,
        headers: () => {
          throw new Error('no token')
        },
      }),
    )
    expect(String(await broken.pets_listUsers?.execute({}))).toContain('no token')
  })

  test('cross-origin redirects are not followed; same-origin ones are', async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith('/admin/users')
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } })
        : call.url.endsWith('/pets')
          ? new Response(null, { status: 307, headers: { location: `${BASE}/pets?limit=1` } })
          : json({ ok: true }),
    )
    const t = await tools(make({ fetch: f.fetch }))
    const blocked = await t.pets_listUsers?.execute({})
    expect(String(blocked)).toContain('REDIRECT BLOCKED')
    expect(f.calls).toHaveLength(1)
    expect(await t.pets_listPets?.execute({})).toEqual({ ok: true })
    expect(f.calls.at(-1)?.url).toBe(`${BASE}/pets?limit=1`)
  })

  test('errors are strings: HTTP status, network error, timeout, abort', async () => {
    const notFound = fakeFetch(
      () => new Response('no such pet', { status: 404, statusText: 'Not Found' }),
    )
    const t = await tools(make({ fetch: notFound.fetch }))
    expect(await t.pets_getPet?.execute({ path: { petId: '9' } })).toBe(
      'HTTP 404 Not Found: no such pet',
    )

    const down = fakeFetch(() => {
      throw new TypeError('connect ECONNREFUSED')
    })
    const t2 = await tools(make({ fetch: down.fetch }))
    expect(await t2.pets_listUsers?.execute({})).toBe('Request failed: connect ECONNREFUSED')

    const slow = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          ;(call.init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    )
    const t3 = await tools(make({ fetch: slow.fetch, timeoutMs: 20 }))
    expect(await t3.pets_listUsers?.execute({})).toBe('Request timed out after 20 ms.')
    const controller = new AbortController()
    const pending = t3.pets_listUsers?.execute({}, { abortSignal: controller.signal })
    controller.abort()
    expect(await pending).toBe('Request aborted.')
  })

  test('response mapping: text, empty, binary, size limit', async () => {
    let next: Response = new Response('plain')
    const f = fakeFetch(() => next)
    const t = await tools(make({ fetch: f.fetch, maxResponseChars: 10 }))
    const run = () => t.pets_listUsers?.execute({})
    next = new Response('hello', { headers: { 'content-type': 'text/plain' } })
    expect(await run()).toBe('hello')
    next = new Response(null, { status: 204, statusText: 'No Content' })
    expect(await run()).toBe('OK: HTTP 204 No Content')
    next = new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
    expect(String(await run())).toContain("content type 'image/png'")
    next = json({ long: 'x'.repeat(100) })
    const cut = String(await run())
    expect(cut).toContain('[truncated: the response is longer than 10 characters]')
    expect(cut.length).toBeLessThan(100)
  })
})

describe('agent integration', () => {
  test('a model calls a generated tool; the result reaches the turn', async () => {
    const f = fakeFetch(() => json({ id: 7, name: 'Rex' }))
    const agent = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'pets_getPet', input: { path: { petId: '7' } } }] },
        { text: 'Rex.' },
      ]),
      contextWindow: 100_000,
      tools: [make({ fetch: f.fetch, include: { operationIds: ['getPet'] } })],
    })
    const result = await agent.session('s').send('Who is pet 7?').result
    expect(result.stop).toBe('complete')
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/pets/7`])
    const part = result.messages
      .find((m) => m.id === result.messageId)
      ?.parts.find((p) => p.type === 'tool-pets_getPet') as { output?: unknown } | undefined
    expect(part?.output).toEqual({ id: 7, name: 'Rex' })
    await agent.close()
  })
})
