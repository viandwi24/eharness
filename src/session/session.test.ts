import { describe, expect, test } from 'bun:test'
import { APICallError, RetryError } from 'ai'
import { HarnessError, isHarnessError } from '../errors.ts'
import { uuidv7 } from '../messages/ids.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { describeError, UNEXPECTED_ERROR_TEXT } from '../stream/describe-error.ts'
import { createTurnBuffer } from '../stream/run.ts'
import { normalizeInput } from './input.ts'
import { collect, spyMessages } from './int-kit.ts'
import { loadContext, PAGE_SIZE } from './load-context.ts'
import { defaultMemoryState } from './memory-storage.ts'
import { createStateStore } from './state.ts'

describe('describeError (spec 10 §3)', () => {
  const api = (statusCode: number) =>
    new APICallError({
      message: `status ${statusCode}`,
      url: 'https://x.test',
      requestBodyValues: { apiKey: 'sk-secret' },
      statusCode,
      responseHeaders: { authorization: 'secret' },
    })
  test('provider errors get prefixes and never leak request data', () => {
    expect(describeError(api(400))).toBe('Provider rejected the request: status 400')
    expect(describeError(api(429))).toBe('Rate limited: status 429')
    expect(describeError(api(503))).toBe('Provider unavailable: status 503')
    expect(describeError(new Error('wrapped', { cause: api(401) }))).toBe(
      'Provider rejected the request: status 401',
    )
    const retry = new RetryError({
      message: 'retries',
      reason: 'maxRetriesExceeded',
      errors: [api(429)],
    })
    expect(describeError(retry)).toBe('Rate limited: status 429')
    expect(describeError(api(429))).not.toContain('sk-secret')
  })
  test('HarnessErrors keep their message; others fall back and are logged', () => {
    expect(describeError(new HarnessError('EH_STORAGE', 'Storage failed.'))).toBe('Storage failed.')
    const logged: unknown[] = []
    expect(describeError(new Error('internal detail'), (m) => logged.push(m))).toBe(
      UNEXPECTED_ERROR_TEXT,
    )
    expect(logged).toHaveLength(1)
  })
})

describe('normalizeInput', () => {
  const invalid = (input: unknown) => {
    try {
      normalizeInput(input as never)
    } catch (error) {
      return isHarnessError(error, 'EH_INVALID_INPUT')
    }
    return false
  }
  test('accepts strings, { text, files } and user messages with text/file parts', () => {
    expect(normalizeInput('hi')).toEqual({ parts: [{ type: 'text', text: 'hi' }] })
    expect(
      normalizeInput({
        id: 'c',
        role: 'user',
        parts: [
          { type: 'text', text: 'a', state: 'done', providerMetadata: { x: {} } },
          { type: 'file', mediaType: 'image/png', url: 'data:,', filename: 'f.png' },
        ],
      } as never),
    ).toEqual({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'file', mediaType: 'image/png', url: 'data:,', filename: 'f.png' },
      ],
      clientId: 'c',
    })
  })
  test('rejects empty input, other roles and other part types', () => {
    expect(invalid('')).toBe(true)
    expect(invalid({})).toBe(true)
    expect(invalid({ role: 'system', parts: [{ type: 'text', text: 'x' }] })).toBe(true)
    expect(invalid({ role: 'user', parts: [{ type: 'data-x', data: {} }] })).toBe(true)
    expect(invalid({ role: 'user', parts: [{ type: 'step-start' }] })).toBe(true)
    expect(invalid({ role: 'user', parts: [] })).toBe(true)
    expect(invalid({ files: [{ type: 'file' }] })).toBe(true)
  })
})

describe('state store (spec 05 §7)', () => {
  test('namespaced plugin state with dirty tracking, rev and CAS', async () => {
    const adapter = defaultMemoryState()
    const store = createStateStore(adapter, 's')
    await store.load()
    expect(store.dirty).toBe(false)
    const fs = store.plugin('filesystem')
    fs.set('lastRead', { '/a': 'v1' })
    expect(store.dirty).toBe(true)
    const value = fs.get<Record<string, string>>('lastRead')
    if (value !== undefined) value['/a'] = 'mutated'
    expect(fs.get('lastRead')).toEqual({ '/a': 'v1' })
    expect(await store.write({ cas: true })).toBe(true)
    expect(store.dirty).toBe(false)
    expect((await adapter.get('s'))?.rev).toBe(1)
    expect((await adapter.get('s'))?.plugins).toEqual({ filesystem: { lastRead: { '/a': 'v1' } } })
    fs.set('lastRead', undefined)
    expect((store.snapshot().plugins as Record<string, unknown>).filesystem).toBeUndefined()

    // another writer bumps the rev → CAS conflict
    const other = createStateStore(adapter, 's')
    await other.load()
    await other.write()
    expect(await store.write({ cas: true })).toBe(false)
  })

  test('adapter failures become EH_STORAGE', async () => {
    const store = createStateStore(
      {
        get: async () => {
          throw new Error('down')
        },
        set: async () => {},
      },
      's',
    )
    await expect(store.load()).rejects.toMatchObject({ code: 'EH_STORAGE' })
  })
})

describe('loadContext paging fallback (spec 05 §5)', () => {
  const registry = createCoreMessageRegistry()
  const text = (id: string, role: 'user' | 'assistant' = 'user'): HarnessUIMessage => ({
    id,
    role,
    metadata: { eharness: { v: 1, createdAt: 1 } },
    parts: [{ type: 'text', text: id }],
  })

  test('pages back until the boundary and what it keeps are loaded', async () => {
    const messages = spyMessages()
    const ids = Array.from({ length: 250 }, () => uuidv7())
    const all = ids.map((id) => text(id))
    const resumeFromId = ids[120] as string
    const marker = createKindMessage(
      'eh.compaction',
      { summary: 'S', resumeFromId, tokens: { before: 1, after: 1 }, trigger: 'turn' },
      { id: uuidv7() },
    )
    const later = Array.from({ length: 10 }, () => text(uuidv7()))
    await messages.save('s', [...all, marker, ...later])
    const core: Record<string, unknown> = {}
    const loaded = await loadContext({
      adapter: messages,
      sessionId: 's',
      registry,
      policy: 'drop',
      core,
      markDirty: () => {},
    })
    expect(messages.loads).toHaveLength(2)
    expect(messages.loads[0]).toEqual({ sessionId: 's', limit: PAGE_SIZE })
    expect(loaded.view[0]?.id).toBe(marker.id)
    expect(loaded.view[1]?.id).toBe(resumeFromId)
    expect(loaded.view).toHaveLength(1 + (250 - 120) + 10)
    expect(core.compaction).toEqual({ markerId: marker.id, resumeFromId })
    expect(loaded.newestId).toBe(later.at(-1)?.id as string)
  })

  test('rewinds hide messages; invalid messages are dropped with a warning', async () => {
    const messages = spyMessages()
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()]
    const rewind = createKindMessage(
      'eh.rewind',
      { afterId: a, reason: 'regenerate' },
      { id: uuidv7() },
    )
    await messages.save('s', [
      text(a),
      text(b, 'assistant'),
      { id: c, role: 'user', parts: 'broken' } as never,
      rewind,
    ])
    const loaded = await loadContext({
      adapter: messages,
      sessionId: 's',
      registry,
      policy: 'drop',
      core: {},
      markDirty: () => {},
    })
    expect(loaded.view.map((m) => m.id)).toEqual([a, rewind.id])
    expect(loaded.warnings.map((w) => w.code)).toContain('W_INVALID_MESSAGE')
  })
})

describe('turn buffer', () => {
  test('readers replay from the start, follow live chunks and get their own copies', async () => {
    const buffer = createTurnBuffer()
    const chunk = { type: 'data-x', id: 'p', data: { n: 1 } } as const
    buffer.push(chunk as never)
    const reader = buffer.reader()
    ;(chunk.data as { n: number }).n = 99 // mutation after push must not leak
    buffer.push({ type: 'finish' })
    buffer.close()
    expect(await collect(reader)).toEqual([
      { type: 'data-x', id: 'p', data: { n: 1 } },
      { type: 'finish' },
    ])
    expect(await collect(buffer.reader())).toHaveLength(2)
  })
})
