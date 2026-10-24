/**
 * The outgoing webhook of a trigger: one signed JSON POST.
 *
 * Signature: `X-Team-Signature: sha256=<hex>` is the HMAC-SHA256 of `<timestamp>.<body>` (the exact
 * request body) with the trigger's secret; `X-Team-Timestamp` is the Unix time in seconds the
 * request was signed, so the receiver can refuse old replays. Also sent: `X-Team-Event` (the event
 * type), `X-Team-Delivery` (the firing id, the same for every retry of one firing).
 *
 * Safety: the URL must be https (plain http only in development), never carry credentials, and its
 * host must not be a private, loopback or link-local address, literal or resolved (checked again
 * right before every attempt). Redirects are not followed. One attempt gets `timeoutMs`; a network
 * error, a timeout, a 5xx or a 429 is retried with a growing pause, at most twice, then the firing
 * is an error; any other status ends it at once. At most `maxInFlight` deliveries run at a time
 * (the others wait), so a burst of events cannot open hundreds of connections.
 *
 * Residual risk, as for custom connectors: the host is checked and then connected (a DNS answer that
 * changes between the two can still win); close it at the network with an egress policy.
 */
import { isPrivateHost } from 'eharness'
import { webhookUrlProblem } from '../../domain/triggers.ts'

export interface WebhookOptions {
  fetch?: typeof fetch
  /** Resolve a host name to its addresses; default the system resolver unless `fetch` is injected. */
  resolveHost?: (host: string) => Promise<string[]>
  /** Allow plain http and private hosts (development and tests). */
  allowPrivate?: boolean
  timeoutMs?: number
  /** Pauses before the second and the third attempt (ms). */
  backoffMs?: readonly number[]
  maxInFlight?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface WebhookResult {
  ok: boolean
  status?: number
  attempts: number
  /** `blocked` (the host is not allowed), `timeout`, `network`, `status` (an error answer). */
  code?: 'blocked' | 'timeout' | 'network' | 'status'
  error?: string
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The signature header value for a body. */
export async function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  )
  return `sha256=${toHex(mac)}`
}

async function lookupAll(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises')
  return (await lookup(host, { all: true })).map((r) => r.address)
}

export interface WebhookSender {
  /** Why a URL may not be called (a sentence), or undefined. Checks the host, resolving it. */
  blocked(url: string): Promise<string | undefined>
  send(input: {
    url: string
    secret: string
    body: unknown
    deliveryId: string
    eventType: string
  }): Promise<WebhookResult>
  readonly allowPrivate: boolean
}

export function createWebhookSender(options: WebhookOptions = {}): WebhookSender {
  const doFetch = options.fetch ?? fetch
  const allowPrivate = options.allowPrivate === true
  const timeoutMs = options.timeoutMs ?? 10_000
  const backoff = options.backoffMs ?? [1_000, 3_000]
  const maxInFlight = options.maxInFlight ?? 4
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const resolve = options.resolveHost ?? (options.fetch === undefined ? lookupAll : undefined)

  const blocked = async (url: string): Promise<string | undefined> => {
    const bad = webhookUrlProblem(url, allowPrivate)
    if (bad !== undefined) return bad
    if (allowPrivate) return undefined
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    const refuse =
      'the host is a private, local or internal address: webhooks may only call public hosts'
    if (isPrivateHost(host)) return refuse
    if (resolve === undefined) return undefined
    try {
      const addresses = await resolve(host)
      if (addresses.some((a) => isPrivateHost(a))) return refuse
    } catch {
      // unresolvable: the attempt reports it
    }
    return undefined
  }

  let running = 0
  const waiting: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (running < maxInFlight) {
      running++
      return
    }
    await new Promise<void>((r) => waiting.push(r))
    running++
  }
  const release = (): void => {
    running--
    waiting.shift()?.()
  }

  async function attempt(
    url: string,
    secret: string,
    text: string,
    deliveryId: string,
    eventType: string,
  ): Promise<{ done: boolean; result: Omit<WebhookResult, 'attempts'> }> {
    const refused = await blocked(url)
    if (refused !== undefined)
      return { done: true, result: { ok: false, code: 'blocked', error: refused } }
    const timestamp = Math.floor(now() / 1000)
    const signature = await signWebhook(secret, timestamp, text)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'eharness-team-trigger/1',
          'x-team-signature': signature,
          'x-team-timestamp': String(timestamp),
          'x-team-event': eventType,
          'x-team-delivery': deliveryId,
        },
        body: text,
      })
      // the answer body is not needed: drop it
      await res.body?.cancel().catch(() => undefined)
      if (res.status >= 200 && res.status < 300)
        return { done: true, result: { ok: true, status: res.status } }
      const retry = res.status >= 500 || res.status === 429
      return {
        done: !retry,
        result: {
          ok: false,
          status: res.status,
          code: 'status',
          error: `the receiver answered HTTP ${res.status}`,
        },
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      return {
        done: false,
        result: {
          ok: false,
          code: aborted ? 'timeout' : 'network',
          error: aborted
            ? `no answer within ${Math.round(timeoutMs / 1000)} s`
            : `the request failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                200,
              ),
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    allowPrivate,
    blocked,
    async send({ url, secret, body, deliveryId, eventType }) {
      const text = JSON.stringify(body)
      await acquire()
      try {
        let last: Omit<WebhookResult, 'attempts'> = { ok: false, code: 'network' }
        for (let n = 0; n <= backoff.length; n++) {
          if (n > 0) await sleep(backoff[n - 1] as number)
          const { done, result } = await attempt(url, secret, text, deliveryId, eventType)
          last = result
          if (result.ok || done) return { ...result, attempts: n + 1 }
        }
        return { ...last, attempts: backoff.length + 1 }
      } finally {
        release()
      }
    },
  }
}
