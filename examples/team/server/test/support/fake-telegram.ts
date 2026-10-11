/**
 * A fake Telegram Bot API on a local port: `getUpdates` long polling, the send methods, file
 * download, scripted failures. Tests only; nothing here talks to the real network.
 */
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>

export interface FakeCall {
  method: string
  params: Json
  /** Names of uploaded files (multipart) in this call. */
  files: string[]
  at: number
}

export interface FakeFailure {
  error_code: number
  description: string
  parameters?: { retry_after?: number }
}

export interface FakeTelegram {
  url: string
  token: string
  calls: FakeCall[]
  callsOf(method: string): FakeCall[]
  /** Queue an update for the next `getUpdates`. */
  push(update: Json): number
  /** The next `times` calls of `method` fail with this error. */
  fail(method: string, failure: FakeFailure, times?: number): void
  /** The token stops working (every method answers 401). */
  revoke(): void
  setWebhook(url: string | undefined): void
  /** Files served by `getFile` / the file endpoint: file id to bytes. */
  addFile(fileId: string, bytes: Uint8Array, path?: string): void
  /** Override what `getFile` reports as the size of a file (to test the cap). */
  setFileSize(fileId: string, size: number): void
  setBot(patch: Partial<Json>): void
  stop(): void
}

export function fakeTelegram(
  port: number,
  token = '123456:FAKE_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
): FakeTelegram {
  const calls: FakeCall[] = []
  const queue: Json[] = []
  const waiters: Array<() => void> = []
  const failures = new Map<string, FakeFailure[]>()
  const files = new Map<string, { bytes: Uint8Array; path: string; size?: number }>()
  let revoked = false
  let webhook: string | undefined
  let updateId = 1000
  let messageId = 500
  let bot: Json = {
    id: 777,
    is_bot: true,
    first_name: 'Team Bot',
    username: 'team_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  }

  const ok = (result: unknown): Response => Response.json({ ok: true, result })
  const err = (f: FakeFailure): Response =>
    Response.json(
      {
        ok: false,
        error_code: f.error_code,
        description: f.description,
        ...(f.parameters ? { parameters: f.parameters } : {}),
      },
      { status: f.error_code },
    )

  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname)
      if (fileMatch) {
        if (fileMatch[1] !== token || revoked) return new Response('unauthorized', { status: 401 })
        const found = [...files.values()].find((f) => f.path === fileMatch[2])
        return found === undefined
          ? new Response('no', { status: 404 })
          : new Response(found.bytes as BodyInit)
      }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname)
      if (m === null) return new Response('not found', { status: 404 })
      const [, tok, method] = m as unknown as [string, string, string]
      let params: Json = {}
      const uploaded: string[] = []
      const type = req.headers.get('content-type') ?? ''
      if (type.includes('application/json')) params = (await req.json()) as Json
      else if (type.includes('multipart/form-data')) {
        const form = await req.formData()
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') params[k] = v
          else uploaded.push(`${k}:${(v as File).name}`)
        }
      } else if (type.includes('x-www-form-urlencoded')) {
        params = Object.fromEntries(new URLSearchParams(await req.text()))
      }
      calls.push({ method, params, files: uploaded, at: Date.now() })
      if (tok !== token || revoked) return err({ error_code: 401, description: 'Unauthorized' })
      const queued = failures.get(method)
      if (queued !== undefined && queued.length > 0) return err(queued.shift() as FakeFailure)
      switch (method) {
        case 'getMe':
          return ok(bot)
        case 'getWebhookInfo':
          return ok({ url: webhook ?? '', has_custom_certificate: false, pending_update_count: 0 })
        case 'deleteWebhook':
          webhook = undefined
          return ok(true)
        case 'getUpdates': {
          const offset = Number(params.offset ?? 0)
          if (offset > 0) {
            while (queue.length > 0 && (queue[0] as Json).update_id < offset) queue.shift()
          }
          if (queue.length === 0) {
            const wait = Math.min(Number(params.timeout ?? 0), 30) * 1000
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, wait)
              waiters.push(() => {
                clearTimeout(t)
                resolve()
              })
            })
          }
          const limit = Number(params.limit ?? 100)
          return ok(queue.filter((u) => u.update_id >= offset).slice(0, limit))
        }
        case 'sendMessage':
        case 'sendPhoto':
        case 'sendDocument':
        case 'sendAudio':
        case 'sendVideo':
          return ok({
            message_id: ++messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(params.chat_id), type: 'supergroup', title: 'x' },
            from: bot,
            text: params.text,
          })
        case 'sendMediaGroup':
          return ok([
            {
              message_id: ++messageId,
              date: 1,
              chat: { id: Number(params.chat_id), type: 'supergroup' },
            },
          ])
        case 'editMessageText':
          return ok({
            message_id: Number(params.message_id),
            date: 1,
            chat: { id: Number(params.chat_id), type: 'supergroup' },
            text: params.text,
          })
        case 'getFile': {
          const f = files.get(String(params.file_id))
          if (f === undefined)
            return err({ error_code: 400, description: 'Bad Request: invalid file_id' })
          return ok({
            file_id: params.file_id,
            file_unique_id: 'u',
            file_size: f.size ?? f.bytes.byteLength,
            file_path: f.path,
          })
        }
        case 'getChatAdministrators':
          return ok([{ status: 'creator', user: { id: 1, is_bot: false, first_name: 'Ana' } }])
        default:
          return ok(true)
      }
    },
  })

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method),
    push(update) {
      const withId = { update_id: ++updateId, ...update }
      queue.push(withId)
      wake()
      return withId.update_id
    },
    fail(method, failure, times = 1) {
      const list = failures.get(method) ?? []
      for (let i = 0; i < times; i++) list.push(failure)
      failures.set(method, list)
    },
    revoke() {
      revoked = true
      wake()
    },
    setWebhook(url) {
      webhook = url
    },
    addFile(fileId, bytes, path = `docs/${fileId}.bin`) {
      files.set(fileId, { bytes, path })
    },
    setFileSize(fileId, size) {
      const f = files.get(fileId)
      if (f !== undefined) f.size = size
    },
    setBot(patch) {
      bot = { ...bot, ...patch }
    },
    stop() {
      wake()
      server.stop(true)
    },
  }
}

/** Builders of Telegram updates (the subset the adapter reads). */
export const tg = {
  group: (id = -1001, title = 'Ops', extra: Json = {}) => ({
    id,
    type: 'supergroup',
    title,
    ...extra,
  }),
  dm: (id = 42, first = 'Ana') => ({ id, type: 'private', first_name: first }),
  user: (id = 42, first = 'Ana', extra: Json = {}) => ({
    id,
    is_bot: false,
    first_name: first,
    username: first.toLowerCase(),
    ...extra,
  }),
  message(input: {
    chat: Json
    from?: Json
    text?: string
    id?: number
    entities?: Json[]
    extra?: Json
  }): Json {
    return {
      message: {
        message_id: input.id ?? 1,
        date: Math.floor(Date.now() / 1000),
        chat: input.chat,
        from: input.from ?? tg.user(),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.entities === undefined ? {} : { entities: input.entities }),
        ...(input.extra ?? {}),
      },
    }
  },
}
