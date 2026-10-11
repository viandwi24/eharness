# HTTP server

`eharness/http` gives an agent the routes a chat product needs: a `useChat` endpoint with resume,
steering and interrupt, session reads, the attention queue (approvals and questions across
sessions) and the activity feed (SSE). It is a plain `fetch(Request): Promise<Response>` handler.
Contract: [spec 26](../specs/26-http.md).

```ts
import { createHarnessHttp } from 'eharness/http'
import { activity, memoryActivityStore } from 'eharness/activity'

const store = memoryActivityStore() // use your own ActivityStore in production
const http = createHarnessHttp(agent, {
  // required: runs before the body is read and before a session is opened
  authorize: async ({ request, action, sessionId }) => {
    const user = await userOf(request)
    if (!user) return { deny: 401 }
    if (sessionId && !(await mayUse(user, sessionId))) return { deny: 403 }
    return user // the principal, handed to every other hook
  },
  chat: { ifBusy: ['reject', 'steer'], actorOf: (user) => ({ id: user.id, name: user.name }) },
  activity: {
    store,
    bootId: crypto.randomUUID(),
    filter: (user) => (r) => r.sessionId?.startsWith(`${user.id}:`) ?? false,
  },
  attention: {
    roots: ({ principal }) => [`${principal.id}:main`],
    peek: (id) => agent.peek(id),
    open: (id) => agent.session(id),
    store,
  },
})
```

`openAccess` allows everything and exists for local development only.

## Mounting

Hono:

```ts
app.all('/api/*', (c) => http.fetch(c.req.raw)) // createHarnessHttp(agent, { basePath: '/api', ... })
```

Bun:

```ts
Bun.serve({ port: 3000, fetch: http.fetch })
```

Node (Express, `http`, Fastify): convert the incoming request to a `Request` with a **streamed**
body (do not buffer it; the module enforces `maxBodyBytes` itself), call `http.fetch`, and pipe the
`Response` body to the socket as it arrives. Requirements:

- forward `res.on('close')` as an abort of the `Request` signal (a closed tab must stop the
  reader; the turn itself keeps running and can be resumed);
- do not buffer or compress `text/event-stream` responses (disable compression middleware for
  these routes; reverse proxies need `proxy_buffering off`, the module sends `x-accel-buffering: no`);
- flush headers immediately.

## Behavior worth knowing

- **Whitelist.** Only the last message, `text` and `file` parts, and decisions of an assistant
  message are read. `actor`, `runtime`, `ifBusy` and the rest come from the server (`chat.actorOf`,
  `chat.sendOptions`, the allow-listed `?ifBusy=`).
- **Idempotent sends.** A retried message id is a `409 EH_HTTP_DUPLICATE_REQUEST` with the turn and
  whether it is still active; a retried approval is `409 EH_HTTP_ALREADY_ANSWERED`.
- **Steer.** With `chat.ifBusy` including `'steer'`, `POST /sessions/:id/chat?ifBusy=steer` delivers
  the message into the running turn (`200` stream when it runs here, `202` when it runs in another
  instance).
- **Missing sessions** read as empty; deny in `authorize` if existence must stay hidden.
- **Errors** are always `{ error: { code, message, details? } }`; 5xx messages are generic and the
  real error goes to `onFailure`. Map your own errors with `onError`.
- **Attention** answers are allowed only for sessions under the principal's `roots` (children
  included) unless you pass `canAnswer`.

## CORS

The library does no CORS. For a browser on another origin, answer the preflight yourself (the module
has no `OPTIONS` route; it answers 405) and pass `headers: { 'access-control-allow-origin': ... }` to
add the response headers.

Request headers to allow: `content-type`, `idempotency-key`, `last-event-id`, plus your
authorization header. Methods: `GET, POST, OPTIONS`. Response headers to expose (cross-origin
scripts read them): `x-eharness-turn-id`, `x-eharness-session-id`, `allow`.

## Client

The browser side (typed client, chat transport, activity feed, attention list, Svelte and React
recipes) is `eharness/client`: see the [web client guide](web-client.md).

## Testing

```ts
import { httpConformance } from 'eharness/testing'
for (const c of httpConformance(() => ({ fetch: http.fetch }))) test(c.name, c.run)
```

Your agent must answer with a streamed reply of at least 250 ms (a scripted model with `delayMs`).
