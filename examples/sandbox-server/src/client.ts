/**
 * Client of the sandbox server: `remoteSandbox()` is a `CodeSandbox` (AI SDK sandbox session) over
 * the `/v1` HTTP API (README.md). Runtime-neutral: `fetch` only.
 */
import type { CodeSandbox } from 'eharness/code'

export interface RemoteSandboxOptions {
  /** Base URL of the sandbox server, e.g. `http://sandbox:4100`. */
  url: string
  token: string
  fetch?: typeof fetch
}

export interface RemoteSandboxInfo {
  version: number
  python: string
  pythonCommand?: string
  packages: Array<[string, string]>
  isolation: { isolated: boolean; label: string }
  limits: Record<string, number>
}

type Fetch = typeof fetch

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // not JSON
  }
  return res.statusText || 'request failed'
}

const trim = (url: string): string => url.replace(/\/+$/, '')

async function getInfo(
  url: string,
  token: string,
  f: Fetch,
  signal?: AbortSignal,
): Promise<RemoteSandboxInfo> {
  const res = await f(`${trim(url)}/v1/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  if (res.status === 401) throw new Error('sandbox server rejected the token (401)')
  if (!res.ok) throw new Error(`sandbox server answered ${res.status}: ${await errorText(res)}`)
  const info = (await res.json()) as RemoteSandboxInfo
  if (info.version !== 1) throw new Error(`unsupported sandbox protocol version ${info.version}`)
  return info
}

/** Connection test: the server's info, or an Error with a readable message. */
export async function probeRemoteSandbox(options: {
  url: string
  token: string
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<RemoteSandboxInfo> {
  const f = options.fetch ?? fetch
  try {
    return await getInfo(
      options.url,
      options.token,
      f,
      AbortSignal.timeout(options.timeoutMs ?? 10_000),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('sandbox server') || message.startsWith('unsupported'))
      throw error instanceof Error ? error : new Error(message)
    throw new Error(`cannot reach the sandbox server at ${options.url}: ${message}`)
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Create a session on the server and return it as a `CodeSandbox`. `dispose()` deletes it. */
export async function remoteSandbox(options: RemoteSandboxOptions): Promise<CodeSandbox> {
  const f: Fetch = options.fetch ?? fetch
  const base = trim(options.url)
  const auth = { authorization: `Bearer ${options.token}` }
  const info = await getInfo(base, options.token, f)
  const created = await f(`${base}/v1/sessions`, { method: 'POST', headers: auth })
  if (!created.ok) throw new Error(`cannot create a session: ${await errorText(created)}`)
  const { id } = (await created.json()) as { id: string }
  const session = `${base}/v1/sessions/${id}`
  let disposed = false

  const readBinary = async (path: string, signal?: AbortSignal): Promise<Response | null> => {
    const res = await f(`${session}/files?path=${encodeURIComponent(path)}`, {
      headers: auth,
      signal,
    })
    if (res.status === 404) {
      const reason = await errorText(res)
      if (reason === 'file not found') return null
      throw new Error(`read ${path}: ${reason}`)
    }
    if (!res.ok) throw new Error(`read ${path}: ${await errorText(res)}`)
    return res
  }

  const put = async (path: string, body: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const res = await f(`${session}/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: body as BodyInit,
      signal,
    })
    if (!res.ok) throw new Error(`write ${path}: ${await errorText(res)}`)
  }

  const spawn: CodeSandbox['spawn'] = async (opts) => {
    const ac = new AbortController()
    let killed = false
    let abortReason: unknown
    const onAbort = (): void => {
      abortReason = opts.abortSignal?.reason
      ac.abort()
    }
    if (opts.abortSignal?.aborted) onAbort()
    else opts.abortSignal?.addEventListener('abort', onAbort, { once: true })
    const res = await f(`${session}/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        command: opts.command,
        workingDirectory: opts.workingDirectory,
        env: opts.env,
      }),
      signal: ac.signal,
    })
    if (!res.ok || !res.body) throw new Error(`run: ${await errorText(res)}`)
    const enc = new TextEncoder()
    let outC!: ReadableStreamDefaultController<Uint8Array>
    let errC!: ReadableStreamDefaultController<Uint8Array>
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        outC = c
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        errC = c
      },
    })
    const waited = (async (): Promise<{ exitCode: number }> => {
      let exitCode: number | undefined
      try {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader()
        const dec = new TextDecoder()
        let buf = ''
        const handle = (line: string): void => {
          if (!line) return
          const msg = JSON.parse(line) as { stdout?: string; stderr?: string; exit?: number }
          if (msg.stdout !== undefined) outC.enqueue(enc.encode(msg.stdout))
          if (msg.stderr !== undefined) errC.enqueue(enc.encode(msg.stderr))
          if (msg.exit !== undefined) exitCode = msg.exit
        }
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl = buf.indexOf('\n')
          while (nl >= 0) {
            handle(buf.slice(0, nl))
            buf = buf.slice(nl + 1)
            nl = buf.indexOf('\n')
          }
        }
        handle(buf)
      } catch (error) {
        if (killed) exitCode = 137
        else if (opts.abortSignal?.aborted) throw abortReason ?? error
        else throw error
      } finally {
        opts.abortSignal?.removeEventListener('abort', onAbort)
        try {
          outC.close()
          errC.close()
        } catch {
          // already closed
        }
      }
      if (exitCode === undefined)
        throw new Error('sandbox server closed the stream without an exit code')
      return { exitCode }
    })()
    waited.catch(() => {})
    return {
      stdout,
      stderr,
      wait: () => waited,
      kill: async () => {
        killed = true
        ac.abort()
        await waited.catch(() => {})
      },
    }
  }

  const sandbox: CodeSandbox = {
    description: `Python and shell run in a remote sandbox server (${info.isolation.label}), Python ${info.python}, no network. Relative file paths resolve against the session's work directory.`,
    isolation: info.isolation,
    readFile: async ({ path, abortSignal }) => (await readBinary(path, abortSignal))?.body ?? null,
    readBinaryFile: async ({ path, abortSignal }) => {
      const res = await readBinary(path, abortSignal)
      return res ? new Uint8Array(await res.arrayBuffer()) : null
    },
    readTextFile: async ({ path, abortSignal, encoding, startLine, endLine }) => {
      const res = await readBinary(path, abortSignal)
      if (!res) return null
      let text = new TextDecoder(encoding ?? 'utf-8').decode(await res.arrayBuffer())
      if (startLine !== undefined || endLine !== undefined) {
        const lines = text.split('\n')
        const from = Math.max(1, startLine ?? 1)
        const to = endLine ?? lines.length
        text = lines.slice(from - 1, to).join('\n')
      }
      return text
    },
    writeFile: async ({ path, content, abortSignal }) =>
      put(path, await collect(content), abortSignal),
    writeBinaryFile: ({ path, content, abortSignal }) => put(path, content, abortSignal),
    writeTextFile: ({ path, content, encoding, abortSignal }) => {
      if (encoding && !/^utf-?8$/i.test(encoding))
        throw new Error(`remote sandbox writes UTF-8 only, not ${encoding}`)
      return put(path, new TextEncoder().encode(content), abortSignal)
    },
    spawn,
    run: async (opts) => {
      const proc = await spawn(opts)
      const dec = new TextDecoder()
      const [out, err, { exitCode }] = await Promise.all([
        collect(proc.stdout),
        collect(proc.stderr),
        proc.wait(),
      ])
      return { exitCode, stdout: dec.decode(out), stderr: dec.decode(err) }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      const res = await f(session, { method: 'DELETE', headers: auth })
      await res.body?.cancel()
    },
  }
  return sandbox
}
