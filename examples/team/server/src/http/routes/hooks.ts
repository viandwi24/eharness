import { Hono } from 'hono'
import type { Deps } from '../../app/ports.ts'
import { webhookEvent } from '../../app/scripts.ts'

/** Most bytes a webhook request body may have. */
const MAX_BODY = 256 * 1024

/**
 * Script webhooks (P59): `POST /hooks/scripts/{id}/{token}` runs a script whose active version has a
 * webhook trigger, with the request as its event, and answers with the run's result. The token in
 * the path is the credential (open route: no bearer, no cookie, no origin check).
 */
export function hookRoutes(deps: Deps): Hono {
  return new Hono().post('/hooks/scripts/:id/:token', async (c) => {
    const runner = deps.scriptRunner?.()
    if (runner === undefined) return c.json({ error: 'scripts are not running' }, 503)
    const length = Number(c.req.header('content-length') ?? '0')
    if (length > MAX_BODY)
      return c.json({ error: `the body is larger than ${MAX_BODY} bytes` }, 413)
    const body = await c.req.text()
    if (body.length > MAX_BODY)
      return c.json({ error: `the body is larger than ${MAX_BODY} bytes` }, 413)
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v
    })
    const event = webhookEvent({
      method: 'POST',
      query: c.req.query(),
      headers,
      body,
      at: Date.now(),
    })
    const r = await runner.webhook(c.req.param('id'), c.req.param('token'), event)
    return c.json(r.body as never, r.status as never)
  })
}
