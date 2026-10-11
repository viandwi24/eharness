/**
 * Chat routes (plan §5.2, M3) through `app.request()` with scripted models. Two `compose()` calls on
 * one database file stand for two server instances: the second one resumes, aborts and steers a
 * turn that the first one runs.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 40 }, abortPollMs: 40 }

type Instance = ReturnType<typeof instances>[number]

/** `count` instances over one database file, each with its own scripted model. */
function instances(...scripts: ScriptedStepInput[][]) {
  const dir = mkdtempSync(join(tmpdir(), 'team-chat-'))
  dirs.push(dir)
  return scripts.map((steps) => {
    const model = scriptedModel(steps)
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(model as never),
      tuning: TUNING,
    })
    servers.push(server)
    return { server, app: server.app, model }
  })
}

const single = (steps: ScriptedStepInput[]) => instances(steps)[0] as Instance
const pair = (one: ScriptedStepInput[], two: ScriptedStepInput[]) =>
  instances(one, two) as [Instance, Instance]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Chunk = { type: string; [key: string]: unknown }
function sseChunks(text: string): { chunks: Chunk[]; done: boolean } {
  const chunks: Chunk[] = []
  let done = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (data === '[DONE]') done = true
    else chunks.push(JSON.parse(data) as Chunk)
  }
  return { chunks, done }
}

interface StoredMessage {
  id: string
  role: string
  parts: Array<Record<string, unknown>>
  metadata?: { eharness?: { stop?: string; pending?: unknown } }
}
async function stored(
  app: Server['app'],
  agent = 'researcher',
  query = '',
): Promise<StoredMessage[]> {
  const res = await app.request(`/sessions/dm:${agent}/messages${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: StoredMessage[] }).messages
}

describe('chat: text and tool turns', () => {
  test('a text turn streams, is stored, and shows in stats', async () => {
    const a = single([{ text: 'Hello there' }])
    const sent = userMessage('hi')
    const res = await a.app.request('/sessions/dm:researcher/chat', postAs(`dm:researcher`, sent))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    const { chunks, done } = sseChunks(await res.text())
    expect(done).toBe(true)
    expect(chunks[0]?.type).toBe('start')
    expect(chunks.some((c) => c.type === 'text-delta' && c.delta === 'Hello there')).toBe(true)
    expect(chunks.at(-1)?.type).toBe('finish')

    const messages = await stored(a.app)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // the client id is never trusted: ids are server generated
    expect(messages[0]?.id).not.toBe(sent.messages[0]?.id)
    expect(messages[1]?.parts.some((p) => p.type === 'text' && p.text === 'Hello there')).toBe(true)
    expect(messages[1]?.metadata?.eharness?.stop).toBe('complete')

    const stats = (await (await a.app.request('/agents/researcher/stats')).json()) as {
      running: boolean
      activeTurn: unknown
      pending: unknown
      usage: { turns: number; totalTokens: number }
      context: { window: number }
    }
    expect(stats.running).toBe(false)
    expect(stats.activeTurn).toBeNull()
    expect(stats.pending).toBeNull()
    expect(stats.usage.turns).toBe(1)
    expect(stats.context.window).toBeGreaterThan(0)
  })

  test('a tool turn writes a library file and stores the tool part', async () => {
    const a = single([
      {
        toolCalls: [{ toolName: 'write_file', input: { path: '/library/a.md', content: '# A\n' } }],
      },
      { text: 'Saved.' },
    ])
    const app = a.app
    const res = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('save a note')),
    )
    const { chunks } = sseChunks(await res.text())
    expect(
      chunks.some((c) => c.type === 'tool-input-available' || c.type === 'tool-output-available'),
    ).toBe(true)
    const file = await libraryFs(a.server.conn.sqlite).read('/library/a.md')
    expect(file?.content).toBe('# A\n')
    const assistant = (await stored(app))[1]
    expect(
      assistant?.parts.some((p) => p.type === 'tool-write_file' && p.state === 'output-available'),
    ).toBe(true)
  })

  test('messages are paginated, newest page first', async () => {
    const a = single([{ text: 'one' }, { text: 'two' }])
    const app = a.app
    await (
      await app.request('/sessions/dm:researcher/chat', postAs(`dm:researcher`, userMessage('1')))
    ).text()
    await (
      await app.request('/sessions/dm:researcher/chat', postAs(`dm:researcher`, userMessage('2')))
    ).text()
    const first = (await (
      await app.request('/sessions/dm:researcher/messages?limit=3')
    ).json()) as {
      messages: StoredMessage[]
      nextBefore?: string
    }
    expect(first.messages).toHaveLength(3)
    expect(first.nextBefore).toBe(first.messages[0]?.id as string)
    const older = (await (
      await app.request(`/sessions/dm:researcher/messages?limit=3&before=${first.nextBefore}`)
    ).json()) as { messages: StoredMessage[]; nextBefore?: string }
    expect(older.messages).toHaveLength(1)
    expect(older.nextBefore).toBeUndefined()
    expect((await app.request('/sessions/dm:researcher/messages?limit=0')).status).toBe(400)
  })
})

describe('chat: approvals', () => {
  async function pendingTurn(approved: boolean) {
    const a = single([
      { toolCalls: [{ toolName: 'read_file', input: { path: '/library/old.txt' } }] },
      { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old.txt' } }] },
      { text: 'All done.' },
    ])
    const { server, app } = a
    const fs = libraryFs(server.conn.sqlite)
    await fs.write('/library/old.txt', 'old')

    const first = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('delete the old file')),
    )
    const firstChunks = sseChunks(await first.text()).chunks
    const request = firstChunks.find((c) => c.type === 'tool-approval-request')
    expect(request).toBeDefined()
    expect(await fs.read('/library/old.txt')).not.toBeNull() // nothing ran yet

    // stats name the pending approval; the stored assistant message waits at approval-requested
    const stats = (await (await app.request('/agents/researcher/stats')).json()) as {
      pending: { approvals: Array<{ toolName: string; risk?: string }> } | null
      activeTurn: unknown
    }
    expect(stats.pending?.approvals[0]?.toolName).toBe('delete_file')
    expect(stats.activeTurn).toBeNull()
    const waiting = (await stored(app)).at(-1) as StoredMessage
    const part = waiting.parts.find((p) => p.state === 'approval-requested') as Record<
      string,
      unknown
    >
    expect(part).toBeDefined()

    // what useChat posts after addToolApprovalResponse: the assistant message with the decision
    const answer = {
      messages: [
        {
          ...waiting,
          parts: waiting.parts.map((p) =>
            p === part
              ? {
                  ...p,
                  state: 'approval-responded',
                  approval: {
                    ...(p.approval as object),
                    approved,
                    reason: approved ? undefined : 'no',
                  },
                }
              : p,
          ),
        },
      ],
    }
    const second = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, answer),
    )
    expect(second.status).toBe(200)
    const secondChunks = sseChunks(await second.text()).chunks
    // the continuation streams into the same message
    expect(secondChunks[0]).toMatchObject({ type: 'start', messageId: waiting.id })
    return { app, fs, waiting, secondChunks }
  }

  test('approve: the tool runs and the same assistant message continues', async () => {
    const { app, fs, waiting, secondChunks } = await pendingTurn(true)
    expect(await fs.read('/library/old.txt')).toBeNull()
    expect(secondChunks.some((c) => c.type === 'text-delta' && c.delta === 'All done.')).toBe(true)
    const messages = await stored(app)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.id).toBe(waiting.id)
    expect(messages[1]?.metadata?.eharness?.pending ?? null).toBeNull()
    expect(
      messages[1]?.parts.some(
        (p) => p.type === 'tool-delete_file' && p.state === 'output-available',
      ),
    ).toBe(true)
  })

  test('deny: the file stays and the message continues', async () => {
    const { app, fs, waiting } = await pendingTurn(false)
    expect(await fs.read('/library/old.txt')).not.toBeNull()
    const messages = await stored(app)
    expect(messages[1]?.id).toBe(waiting.id)
    expect(messages[1]?.parts.some((p) => p.state === 'output-denied')).toBe(true)
  })

  test('answering twice is not applied twice (consume-once)', async () => {
    const { app, waiting } = await pendingTurn(true)
    const replay = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, { messages: [{ ...waiting, parts: waiting.parts }] }),
    )
    // the stale answer never authorizes anything: nothing waits any more, so the route answers
    // 409 EH_HTTP_ALREADY_ANSWERED before a turn starts (the web refreshes quietly)
    expect(replay.status).toBe(409)
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
      'EH_HTTP_ALREADY_ANSWERED',
    )
    expect((await stored(app)).filter((m) => m.role === 'assistant')).toHaveLength(1)
  })
})

describe('chat: two instances', () => {
  const slow: ScriptedStepInput = { text: 'a slow answer', delayMs: 120 }

  test('resume from the second instance replays and follows to the end', async () => {
    const [a, b] = pair([slow], [])
    const A = a.app
    const B = b.app
    const idle = await B.request('/sessions/dm:researcher/chat/stream')
    expect(idle.status).toBe(204)

    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('go')),
    )
    const local = first.text()
    await sleep(350) // mid-turn: the drainer has flushed the head to the log
    const res = await B.request('/sessions/dm:researcher/chat/stream')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const remote = sseChunks(await res.text())
    const localChunks = sseChunks(await local)
    expect(remote.done).toBe(true)
    expect(remote.chunks).toEqual(localChunks.chunks)
    expect(remote.chunks.at(-1)?.type).toBe('finish')

    // from a cursor: the head is skipped
    expect((await B.request('/sessions/dm:researcher/chat/stream?from=2')).status).toBe(204) // turn is over
    expect((await B.request('/sessions/dm:researcher/chat/stream?from=abc')).status).toBe(400)
  })

  test('resume from a cursor mid-turn', async () => {
    const [a, b] = pair([slow], [])
    const A = a.app
    const B = b.app
    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('go')),
    )
    const local = first.text()
    await sleep(350)
    const res = await B.request('/sessions/dm:researcher/chat/stream?from=2')
    expect(res.status).toBe(200)
    const remote = sseChunks(await res.text())
    const all = sseChunks(await local).chunks
    expect(remote.chunks).toEqual(all.slice(2))
  })

  test('abort from the second instance stops the turn of the first', async () => {
    const [a, b] = pair([{ text: 'a very slow answer', delayMs: 400 }], [])
    const A = a.app
    const B = b.app
    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('go')),
    )
    const local = first.text()
    await sleep(300)
    const stats = (await (await B.request('/agents/researcher/stats')).json()) as {
      activeTurn: { owner: string } | null
      running: boolean
    }
    expect(stats.activeTurn).not.toBeNull()
    expect(stats.running).toBe(false) // B does not run it
    const abort = await B.request(
      '/sessions/dm:researcher/interrupt',
      postAs(`dm:researcher`, { reason: 'stop it' }),
    )
    expect(abort.status).toBe(200)
    expect(((await abort.json()) as { target: string }).target).toBe('remote')
    await local // A's stream ends once the turn aborted
    const last = (await stored(B)).at(-1)
    expect(last?.metadata?.eharness?.stop).toBe('aborted')
    const idle = await B.request('/sessions/dm:researcher/interrupt', postAs(`dm:researcher`, {}))
    expect(((await idle.json()) as { target: string }).target).toBe('idle')
  })

  const twoSteps = (): ScriptedStepInput[] => [
    {
      toolCalls: [{ toolName: 'write_file', input: { path: '/library/x.md', content: 'x' } }],
      delayMs: 150,
    },
    { text: 'done', delayMs: 20 },
  ]

  test('a message while a turn runs here is steered into it', async () => {
    const a = single(twoSteps())
    const A = a.app
    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('start')),
    )
    const firstText = first.text()
    await sleep(100)
    const steer = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('also do this')),
    )
    expect(steer.status).toBe(200)
    await steer.text()
    await firstText
    const assistant = (await stored(A)).find((m) => m.role === 'assistant')
    expect(assistant?.parts.some((p) => p.type === 'data-eh.input')).toBe(true)
  })

  test('a message to a turn on another instance goes through the inbox (202)', async () => {
    const [a, b] = pair(twoSteps(), [])
    const A = a.app
    const B = b.app
    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('start')),
    )
    const firstText = first.text()
    await sleep(100)
    const steer = await B.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('also do this')),
    )
    expect(steer.status).toBe(202)
    const queued = (await steer.json()) as { inboxId: string; delivered: string; target: string }
    expect(queued.delivered).toBe('steer')
    expect(queued.inboxId.length).toBeGreaterThan(0)
    await firstText
    await sleep(200)
    const messages = await stored(A)
    const text = JSON.stringify(messages)
    expect(text).toContain('also do this')
  })

  test('ifBusy=reject answers 409 EH_SESSION_BUSY, here and on another instance', async () => {
    const [a, b] = pair(twoSteps(), [])
    const A = a.app
    const B = b.app
    const first = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('start')),
    )
    const firstText = first.text()
    await sleep(100)
    for (const app of [A, B]) {
      const busy = await app.request(
        '/sessions/dm:researcher/chat?ifBusy=reject',
        postAs(`dm:researcher`, userMessage('again')),
      )
      expect(busy.status).toBe(409)
      expect(((await busy.json()) as { error: { code: string } }).error.code).toBe(
        'EH_SESSION_BUSY',
      )
    }
    // an approval answer, regenerate or compact never steer: busy is 409
    const compact = await A.request('/agents/researcher/compact', { method: 'POST' })
    expect(compact.status).toBe(409)
    const regen = await B.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, { trigger: 'regenerate-message', messages: [] }),
    )
    expect(regen.status).toBe(409)
    await firstText
  })
})

describe('chat: requests and uploads', () => {
  test('invalid requests are 400, unknown agents 404, archived agents 409', async () => {
    const a = single([{ text: 'x' }])
    const A = a.app
    const empty = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, { messages: [] }),
    )
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe(
      'EH_HTTP_INVALID_BODY',
    )
    const shape = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, { messages: [{ role: 'user' }] }),
    )
    expect(shape.status).toBe(400)
    expect(
      (await A.request('/sessions/dm:nope/chat', postAs(`dm:nope`, userMessage('x')))).status,
    ).toBe(404)
    const bad = await A.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, {
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'application/x-msdownload',
                url: 'data:application/x-msdownload;base64,AAAA',
              },
            ],
          },
        ],
      }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    )

    const agents = (await (await A.request('/agents')).json()) as {
      agents: Array<{ id: string; slug: string }>
    }
    const analyst = agents.agents.find((x) => x.slug === 'analyst') as { id: string }
    await A.request(`/agents/${analyst.id}`, { method: 'DELETE' })
    const archived = await A.request(
      `/sessions/dm:${analyst.id}/chat`,
      postAs(`dm:${analyst.id}`, userMessage('x')),
    )
    expect(archived.status).toBe(409)
    expect(((await archived.json()) as { error: { code: string } }).error.code).toBe(
      'AGENT_ARCHIVED',
    )
    expect((await A.request(`/sessions/dm:${analyst.id}/messages`)).status).toBe(200) // history stays readable
  })

  async function upload(app: Server['app'], name: string, type: string, content: BlobPart) {
    const form = new FormData()
    form.set('file', new File([content], name, { type }))
    return app.request('/library/files', { method: 'POST', body: form })
  }

  test('an upload becomes a file part the model receives', async () => {
    const a = single([{ text: 'I read it' }])
    const { app, model } = a
    const res = await upload(app, '../../notes ü.csv', 'text/csv', 'a,b\n1,2\n')
    expect(res.status).toBe(201)
    const file = (await res.json()) as {
      path: string
      name: string
      url: string
      size: number
      mediaType: string
    }
    expect(file.path).toMatch(
      /^\/uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+-notes _\.csv$|^\/uploads\//,
    )
    expect(file.path).not.toContain('..')
    expect(file.url.startsWith('library:///uploads/')).toBe(true)
    expect(file.size).toBe(8)

    const chat = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'read this' },
              { type: 'file', mediaType: 'text/csv', filename: 'notes.csv', url: file.url },
            ],
          },
        ],
      }),
    )
    expect(chat.status).toBe(200)
    await chat.text()
    expect(JSON.stringify(model.prompts[0])).toContain('read this')
    // the reference was resolved to bytes for the model (inputFiles.resolve)
    expect(JSON.stringify(model.prompts[0])).toContain('text/csv')
    const user = (await stored(app)).find((m) => m.role === 'user')
    const filePart = user?.parts.find((p) => p.type === 'file') as { url: string; filename: string }
    // stored messages keep the reference, not base64
    expect(filePart.url.startsWith('library:///uploads/')).toBe(true)
    expect(filePart.filename).toBe('notes.csv')
    // agents see the same file in the library
    expect((await libraryFs(a.server.conn.sqlite).read(file.path))?.content).toBe('a,b\n1,2\n')
  })

  test('image, pdf and csv uploads reach the model as bytes, persist as references and survive a reload', async () => {
    const a = single([{ text: 'seen' }])
    const { app, model } = a
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF')
    const files = [
      { name: 'circle.png', type: 'image/png', content: png as BlobPart },
      { name: 'doc.pdf', type: 'application/pdf', content: pdf as BlobPart },
      { name: 'sales.csv', type: 'text/csv', content: 'a,b\n1,2\n' },
    ]
    const parts: unknown[] = [{ type: 'text', text: 'look at these' }]
    for (const f of files) {
      const res = await upload(app, f.name, f.type, f.content)
      expect(res.status).toBe(201)
      const body = (await res.json()) as { url: string; mediaType: string }
      expect(body.mediaType).toBe(f.type)
      parts.push({ type: 'file', mediaType: f.type, filename: f.name, url: body.url })
    }
    const chat = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, { messages: [{ role: 'user', parts }] }),
    )
    expect(chat.status).toBe(200)
    await chat.text()

    // the model wire: one file part per attachment, with the media type and the resolved bytes
    const wire = model.prompts[0] as Array<{ role: string; content: unknown }>
    const filesOnWire = wire
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content as Array<Record<string, unknown>>)
      .filter((c) => c.type === 'file') as Array<{
      mediaType: string
      filename: string
      data: { type: string; data: string }
    }>
    expect(filesOnWire.map((c) => [c.filename, c.mediaType])).toEqual([
      ['circle.png', 'image/png'],
      ['doc.pdf', 'application/pdf'],
      ['sales.csv', 'text/csv'],
    ])
    const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
    expect(filesOnWire.map((c) => c.data)).toEqual([
      { type: 'data', data: b64(png) },
      { type: 'data', data: b64(pdf) },
      { type: 'data', data: b64(new TextEncoder().encode('a,b\n1,2\n')) },
    ])

    // a reload reads the same file parts back, still as references (no base64 in storage)
    const user = (await stored(app)).find((m) => m.role === 'user')
    const kept = user?.parts.filter((p) => p.type === 'file') as Array<{
      url: string
      mediaType: string
      filename: string
    }>
    expect(kept.map((f) => [f.filename, f.mediaType])).toEqual([
      ['circle.png', 'image/png'],
      ['doc.pdf', 'application/pdf'],
      ['sales.csv', 'text/csv'],
    ])
    for (const f of kept) expect(f.url.startsWith('library:///uploads/')).toBe(true)

    // the web shows the stored reference by fetching the bytes with the token
    const raw = await app.request(
      `/library/file?path=${encodeURIComponent(new URL(kept[0]?.url ?? '').pathname)}&inline=true`,
    )
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toContain('image/png')
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png)
  })

  test('an oversize data: attachment and a remote url are rejected with a readable error', async () => {
    const a = single([])
    const app = a.app
    const big = `data:image/png;base64,${'A'.repeat(15_000_000)}`
    const res = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, {
        messages: [{ role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: big }] }],
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('EH_INVALID_INPUT')
    expect(body.error.message).toContain('limit')

    const remote = await app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, {
        messages: [
          {
            role: 'user',
            parts: [{ type: 'file', mediaType: 'image/png', url: 'https://example.test/a.png' }],
          },
        ],
      }),
    )
    expect(remote.status).toBe(400)
    // nothing was stored by the failed sends
    expect((await stored(app)).filter((m) => m.role === 'user')).toHaveLength(0)
  })

  test('upload and file-reference limits', async () => {
    const a = single([])
    const app = a.app
    expect((await upload(app, 'x.exe', 'application/x-msdownload', 'MZ')).status).toBe(400)
    expect((await upload(app, 'empty.txt', 'text/plain', '')).status).toBe(400)
    const big = await upload(
      app,
      'big.txt',
      'text/plain',
      new Uint8Array(10 * 1024 * 1024 + 1).fill(97),
    )
    expect(big.status).toBe(400)
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe('FILE_TOO_LARGE')
    const noFile = await app.request('/library/files', { method: 'POST', body: new FormData() })
    expect(noFile.status).toBe(400)

    for (const url of [
      'library:///library/secret.md',
      'library:///uploads/../library/a.md',
      'library:///uploads/missing.txt',
    ]) {
      const res = await app.request(
        '/sessions/dm:researcher/chat',
        postAs(`dm:researcher`, {
          messages: [{ role: 'user', parts: [{ type: 'file', mediaType: 'text/plain', url }] }],
        }),
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'INVALID_FILE_REF',
      )
    }
  })

  test('compact answers when idle', async () => {
    const a = single([{ text: 'hello' }])
    const app = a.app
    await (
      await app.request('/sessions/dm:researcher/chat', postAs(`dm:researcher`, userMessage('hi')))
    ).text()
    const res = await app.request('/agents/researcher/compact', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { compacted: boolean; message: unknown }
    expect(typeof body.compacted).toBe('boolean')
  })

  test('the chat routes are in the OpenAPI document', async () => {
    const a = single([])
    const doc = (await (await a.app.request('/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
      >
    }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/sessions/{id}',
        '/sessions/{id}/chat',
        '/sessions/{id}/chat/stream',
        '/sessions/{id}/interrupt',
        '/sessions/{id}/messages',
        '/attention/{id}/answer',
        '/activity',
        '/activity/stream',
        '/agents/{id}/compact',
        '/agents/{id}/stats',
        '/library/files',
      ]),
    )
    expect(
      Object.keys(doc.paths['/sessions/{id}/chat']?.post?.responses['200']?.content ?? {}),
    ).toEqual(['text/event-stream'])
    expect(doc.paths['/sessions/{id}/chat/stream']?.get?.responses['204']).toBeDefined()
    expect(doc.paths['/sessions/{id}/chat']?.post?.responses['409']).toBeDefined()
  })
})
