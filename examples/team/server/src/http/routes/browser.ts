import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'
import { originAllowed } from '../../app/auth.ts'
import {
  browserShots,
  browserUsage,
  createBrowserProfile,
  deleteBrowserProfile,
  describeBrowser,
  getBrowserProfile,
  getBrowserRuntime,
  installBrowserRuntime,
  listBrowserProfiles,
  startBrowserProfile,
  stopBrowserProfile,
  testBrowserDraft,
  testBrowserProfile,
  uninstallBrowserRuntime,
  updateBrowserProfile,
  viewerName,
} from '../../app/browser.ts'
import type {
  Deps,
  BrowserLiveChannel as LiveChannel,
  BrowserLiveFrame as LiveFrame,
  BrowserLiveInput as LiveInput,
} from '../../app/ports.ts'
import { issueLiveTicket } from '../live-tickets.ts'
import {
  BrowserAdapterParam,
  BrowserDraftSchema,
  BrowserOverviewSchema,
  BrowserProfileCreateSchema,
  BrowserProfileIdParam,
  BrowserProfilePatchSchema,
  BrowserProfileSchema,
  BrowserRuntimeSchema,
  BrowserShotSchema,
  BrowserShotsQuery,
  BrowserTestResultSchema,
  BrowserUsageSchema,
} from '../schemas/browser.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const content = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const tags = ['browser']

const adapters = createRoute({
  method: 'get',
  path: '/browser/adapters',
  tags,
  summary: 'Browser adapters, their forms and runtimes',
  description:
    'Chrome and Lightpanda (and any adapter the app adds): the modes offered on this server, the capabilities of each mode, the settings form of each mode (`forms`, secrets marked) and the managed runtime (state, download progress, version, disk size). Poll this while a download runs.',
  security,
  responses: {
    200: { description: 'Adapters', content: content(BrowserOverviewSchema) },
    ...errorResponses,
  },
})

const usage = createRoute({
  method: 'get',
  path: '/browser/usage',
  tags,
  summary: 'Memory and CPU of the running browsers',
  description:
    'One row per running profile (memory of the engine process tree, CPU), the totals and the memory of the server. Resources are shown, not capped: `TEAM_BROWSER_MAX` limits the profiles running at once.',
  security,
  responses: {
    200: { description: 'Usage', content: content(BrowserUsageSchema) },
    ...errorResponses,
  },
})

const draftTest = createRoute({
  method: 'post',
  path: '/browser/test',
  tags,
  summary: 'Test settings that are not saved yet',
  description:
    'The wizard\'s "Test connection": connects to the endpoint of a manual draft and answers its version. Never an error status for an unreachable browser (`ok: false`).',
  security,
  request: { body: { required: true, content: content(BrowserDraftSchema) } },
  responses: {
    200: { description: 'Result', content: content(BrowserTestResultSchema) },
    ...errorResponses,
  },
})

const list = createRoute({
  method: 'get',
  path: '/browser/profiles',
  tags,
  summary: 'Browser profiles',
  description:
    'Secrets are redacted (`{ set, hint }`). `state` and `lease` say who holds the browser now.',
  security,
  responses: {
    200: { description: 'Profiles', content: content(BrowserProfileSchema.array()) },
    ...errorResponses,
  },
})

const create = createRoute({
  method: 'post',
  path: '/browser/profiles',
  tags,
  summary: 'Create a browser profile',
  description:
    'A name, an adapter, a mode and the adapter form of that mode. Secrets are sealed at rest and never returned. A profile keeps its logins (a Chrome user-data directory) when managed.',
  security,
  request: { body: { required: true, content: content(BrowserProfileCreateSchema) } },
  responses: {
    201: { description: 'The profile', content: content(BrowserProfileSchema) },
    ...errorResponses,
  },
})

const get = createRoute({
  method: 'get',
  path: '/browser/profiles/{id}',
  tags,
  summary: 'One browser profile',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    200: { description: 'The profile', content: content(BrowserProfileSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const patch = createRoute({
  method: 'patch',
  path: '/browser/profiles/{id}',
  tags,
  summary: 'Edit a browser profile',
  description:
    'Rename, change settings (keep-secret semantics), the allowed domains, or mark it trusted: the agents on a trusted profile click and type without asking.',
  security,
  request: {
    params: BrowserProfileIdParam,
    body: { required: true, content: content(BrowserProfilePatchSchema) },
  },
  responses: {
    200: { description: 'The profile', content: content(BrowserProfileSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/browser/profiles/{id}',
  tags,
  summary: 'Delete a browser profile',
  description:
    'Stops its engine and deletes its saved logins. Refused (409) while a Browser connection still names it.',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    204: { description: 'Deleted' },
    404: jsonError('Unknown profile'),
    409: jsonError('Still used by a connection'),
    ...errorResponses,
  },
})

const test = createRoute({
  method: 'post',
  path: '/browser/profiles/{id}/test',
  tags,
  summary: 'Test the connection of a profile',
  description:
    'Connects (starting a managed engine for the test) and answers the browser version. Never an error status for an unreachable browser.',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    200: { description: 'Result', content: content(BrowserTestResultSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const start = createRoute({
  method: 'post',
  path: '/browser/profiles/{id}/start',
  tags,
  summary: 'Start the engine of a managed profile',
  description:
    'Starts it without an agent (it keeps running until stopped). 409 when it cannot start (not downloaded, too many running: `TEAM_BROWSER_MAX`).',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    200: { description: 'The profile', content: content(BrowserProfileSchema) },
    404: jsonError('Unknown profile'),
    409: jsonError('Could not start'),
    ...errorResponses,
  },
})

const stop = createRoute({
  method: 'post',
  path: '/browser/profiles/{id}/stop',
  tags,
  summary: 'Stop a profile',
  description: 'Releases its lease and stops its managed engine (logins stay on disk).',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    200: { description: 'The profile', content: content(BrowserProfileSchema) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const shots = createRoute({
  method: 'get',
  path: '/browser/profiles/{id}/shots',
  tags,
  summary: 'Recent screenshots of a profile',
  description:
    'The newest screenshots the agents using this profile took (the library folder `/.browser/shots/`), with signed image URLs.',
  security,
  request: { params: BrowserProfileIdParam, query: BrowserShotsQuery },
  responses: {
    200: { description: 'Screenshots, newest first', content: content(BrowserShotSchema.array()) },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

const runtime = createRoute({
  method: 'get',
  path: '/browser/runtimes/{adapter}',
  tags,
  summary: 'Status of a managed runtime',
  description:
    'State, download progress, version, disk size and the last error. Poll it during a download.',
  security,
  request: { params: BrowserAdapterParam },
  responses: {
    200: { description: 'Status', content: content(BrowserRuntimeSchema) },
    404: jsonError('Unknown adapter'),
    ...errorResponses,
  },
})

const install = createRoute({
  method: 'post',
  path: '/browser/runtimes/{adapter}/install',
  tags,
  summary: 'Download (or update) the engine',
  description:
    'Starts the download in the background and answers at once with `state: "installing"`; poll `GET /browser/runtimes/{adapter}` (or `GET /browser/adapters`) for the progress. A failure stays in `error`; call again to retry.',
  security,
  request: { params: BrowserAdapterParam },
  responses: {
    202: { description: 'Download started', content: content(BrowserRuntimeSchema) },
    404: jsonError('Unknown adapter'),
    ...errorResponses,
  },
})

const uninstall = createRoute({
  method: 'post',
  path: '/browser/runtimes/{adapter}/uninstall',
  tags,
  summary: 'Remove the downloaded engine',
  description: 'Profiles and their logins stay. 409 while it downloads or a profile runs.',
  security,
  request: { params: BrowserAdapterParam },
  responses: {
    200: { description: 'Status', content: content(BrowserRuntimeSchema) },
    404: jsonError('Unknown adapter'),
    409: jsonError('Busy'),
    ...errorResponses,
  },
})

// --- live view ---------------------------------------------------------------------------------

const liveTicket = createRoute({
  method: 'post',
  path: '/browser/profiles/{id}/live-ticket',
  tags,
  summary: 'A ticket for the live view',
  description:
    'A one-time ticket (valid one minute) for `GET /browser/profiles/{id}/live?ticket=`: a browser cannot send the bearer token on a WebSocket.',
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    200: {
      description: 'The ticket',
      content: {
        'application/json': {
          schema: z
            .object({ ticket: z.string(), expiresAt: z.number().int() })
            .openapi('BrowserLiveTicket'),
        },
      },
    },
    404: jsonError('Unknown profile'),
    ...errorResponses,
  },
})

/** What a client may send on the live socket (text JSON). `id` is echoed in the answer. */
export type LiveClientMessage =
  | { type: 'takeOver'; id?: string }
  | { type: 'handBack'; id?: string }
  | { type: 'input'; event: LiveInput; id?: string }
  | { type: 'ping' }

/**
 * A frame on the wire: a 4-byte big-endian length of the JSON header, the header, then the image
 * bytes. Header: `{ type: 'frame', seq, width, height, mediaType, at }`.
 */
export function packFrame(frame: LiveFrame): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(
    JSON.stringify({
      type: 'frame',
      seq: frame.seq,
      width: frame.width,
      height: frame.height,
      mediaType: frame.mediaType,
      at: frame.at,
    }),
  )
  const out = new Uint8Array(new ArrayBuffer(4 + header.length + frame.data.length))
  new DataView(out.buffer).setUint32(0, header.length)
  out.set(header, 4)
  out.set(frame.data, 4 + header.length)
  return out
}

/** Frames are dropped, not queued, while this many bytes wait to be sent to a slow viewer. */
const MAX_BUFFERED = 1_500_000

const liveDoc = {
  method: 'get' as const,
  path: '/browser/profiles/{id}/live',
  tags,
  summary: 'Live view and takeover (WebSocket)',
  description: [
    'Upgrade to a WebSocket (same session cookie or bearer token as every route; a browser `Origin` must be an allowed origin).',
    '',
    'Server to client:',
    '- text `{ "type": "hello", "profileId", "info": { "width", "height", "liveView", "liveUrl"? }, "controller": { "by": "agent"|"human", "holder"?, "since", "reason"? }, "you": { "id", "canTakeOver": boolean } }` once.',
    '- binary frames: 4-byte big-endian header length, JSON header `{ "type": "frame", "seq", "width", "height", "mediaType": "image/jpeg"|"image/png", "at" }`, then the image bytes. Coordinates of `input` events are in the `width` x `height` of the frame.',
    '- text `{ "type": "controller", "controller": {...} }` whenever who drives the browser changes (a person took over, handed back, or the agent asked for a person).',
    '- text `{ "type": "ack", "id", "ok": boolean, "error"? }` for a command that carried an `id`; `{ "type": "error", "message", "id"? }` for a refused input or command.',
    '- text `{ "type": "closed", "reason" }` before the socket closes because the browser went away (idle release, stop).',
    '- text `{ "type": "pong" }`.',
    '',
    'Client to server (text JSON): `{ "type": "takeOver", "id"? }`, `{ "type": "handBack", "id"? }`, `{ "type": "input", "event": LiveInput, "id"? }` (`mouse` move/down/up/wheel, `key` down/up/char, `text`, `navigate`; refused unless this socket took over), `{ "type": "ping" }`.',
    '',
    'Closing the socket while in control hands the browser back. Every socket is a viewer; the web app has one workspace owner (the client), so any signed-in viewer may take over.',
  ].join('\n'),
  security,
  request: { params: BrowserProfileIdParam },
  responses: {
    101: { description: 'Switching protocols' },
    403: jsonError('Cross-origin upgrade refused'),
    404: jsonError('Unknown profile'),
  },
}

export function browserRoutes(
  deps: Deps,
  options: { allowedOrigins?: readonly string[] | undefined } = {},
): OpenAPIHono {
  const app = new OpenAPIHono()
    .openapi(adapters, async (c) => c.json(await describeBrowser(deps), 200))
    .openapi(usage, async (c) => c.json(await browserUsage(deps), 200))
    .openapi(draftTest, async (c) => c.json(await testBrowserDraft(deps, c.req.valid('json')), 200))
    .openapi(list, async (c) => c.json(await listBrowserProfiles(deps), 200))
    .openapi(liveTicket, async (c) => {
      const id = c.req.valid('param').id
      if ((await deps.browser?.profiles.get(id)) == null) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'browser profile not found' } }, 404)
      }
      return c.json(issueLiveTicket(id), 200)
    })
    .openapi(create, async (c) =>
      c.json(await createBrowserProfile(deps, c.req.valid('json')), 201),
    )
    .openapi(get, async (c) => c.json(await getBrowserProfile(deps, c.req.valid('param').id), 200))
    .openapi(patch, async (c) =>
      c.json(await updateBrowserProfile(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(remove, async (c) => {
      await deleteBrowserProfile(deps, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(test, async (c) =>
      c.json(await testBrowserProfile(deps, c.req.valid('param').id), 200),
    )
    .openapi(start, async (c) =>
      c.json(await startBrowserProfile(deps, c.req.valid('param').id), 200),
    )
    .openapi(stop, async (c) =>
      c.json(await stopBrowserProfile(deps, c.req.valid('param').id), 200),
    )
    .openapi(shots, async (c) =>
      c.json(
        await browserShots(deps, c.req.valid('param').id, c.req.valid('query').limit ?? 12),
        200,
      ),
    )
    .openapi(runtime, async (c) =>
      c.json(await getBrowserRuntime(deps, c.req.valid('param').adapter), 200),
    )
    .openapi(install, async (c) =>
      c.json(await installBrowserRuntime(deps, c.req.valid('param').adapter), 202),
    )
    .openapi(uninstall, async (c) =>
      c.json(await uninstallBrowserRuntime(deps, c.req.valid('param').adapter), 200),
    )

  app.openAPIRegistry.registerPath(liveDoc as never)
  app.get(
    '/browser/profiles/:id/live',
    // before the upgrade: a plain error answer is still possible
    async (c, next) => {
      const origin = c.req.header('origin')
      if (
        options.allowedOrigins !== undefined &&
        origin !== undefined &&
        !originAllowed('POST', origin, options.allowedOrigins)
      ) {
        return c.json(
          { error: { code: 'FORBIDDEN_ORIGIN', message: 'cross-origin request refused' } },
          403,
        )
      }
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return c.json(
          { error: { code: 'UPGRADE_REQUIRED', message: 'this route is a WebSocket' } },
          426,
        )
      }
      if ((await deps.browser?.profiles.get(c.req.param('id'))) == null) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'browser profile not found' } }, 404)
      }
      return next()
    },
    upgradeWebSocket((c) => liveSocket(deps, c.req.param('id') as string)),
  )
  return app
}

type SocketContext = WSContext

/** One live viewer: frames out, commands in. */
function liveSocket(deps: Deps, profileId: string) {
  const browser = deps.browser
  const viewerId = `client:${crypto.randomUUID().slice(0, 8)}`
  let channel: LiveChannel | undefined
  let stopped = false
  let off: (() => void) | undefined
  const json = (ws: SocketContext, value: unknown): void => {
    if (!stopped) ws.send(JSON.stringify(value))
  }
  const controller = (ws: SocketContext): void => {
    if (channel !== undefined) json(ws, { type: 'controller', controller: channel.controller() })
  }
  const shut = (): void => {
    stopped = true
    off?.()
    channel?.close()
  }
  return {
    async onOpen(_event: Event, ws: SocketContext) {
      if (browser === undefined) {
        json(ws, { type: 'error', message: 'the browser is not set up', fatal: true })
        ws.close(1011, 'browser off')
        return
      }
      const opened = await browser.live(profileId, { id: viewerId })
      if ('refused' in opened) {
        json(ws, { type: 'error', message: opened.text, kind: opened.kind, fatal: true })
        ws.close(opened.kind === 'busy' ? 4409 : 1011, opened.kind)
        return
      }
      channel = opened
      if (stopped) {
        opened.close()
        return
      }
      off = browser.onChange((e) => {
        if (e.profileId === profileId && e.type !== 'lease') controller(ws)
      })
      json(ws, {
        type: 'hello',
        profileId,
        info: opened.info,
        controller: opened.controller(),
        you: { id: viewerId, name: viewerName(viewerId), canTakeOver: true },
      })
      const reader = opened.frames.getReader()
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done || stopped) break
            const buffered = (
              ws.raw as { getBufferedAmount?: () => number } | undefined
            )?.getBufferedAmount?.()
            if (buffered !== undefined && buffered > MAX_BUFFERED) continue
            ws.send(packFrame(value))
          }
        } catch {
          // the feed ended with its browser
        }
        if (!stopped) {
          json(ws, { type: 'closed', reason: 'The browser was released or stopped.' })
          ws.close(1000, 'closed')
        }
      })()
    },
    async onMessage(event: MessageEvent, ws: SocketContext) {
      if (channel === undefined || typeof event.data !== 'string') return
      let msg: LiveClientMessage
      try {
        msg = JSON.parse(event.data) as LiveClientMessage
      } catch {
        json(ws, { type: 'error', message: 'messages are JSON text' })
        return
      }
      const reply = (id: string | undefined, error: string | undefined, always: boolean): void => {
        if (error !== undefined) json(ws, { type: 'error', message: error, ...(id ? { id } : {}) })
        else if (always && id !== undefined) json(ws, { type: 'ack', id, ok: true })
      }
      switch (msg?.type) {
        case 'ping':
          json(ws, { type: 'pong' })
          return
        case 'takeOver': {
          const error = await channel.takeOver()
          reply(msg.id, error, true)
          controller(ws)
          return
        }
        case 'handBack': {
          const error = await channel.handBack()
          reply(msg.id, error, true)
          controller(ws)
          return
        }
        case 'input': {
          reply(msg.id, await channel.input(msg.event), msg.id !== undefined)
          return
        }
        default:
          json(ws, { type: 'error', message: 'unknown message type' })
      }
    },
    onClose() {
      shut()
    },
    onError() {
      shut()
    },
  }
}
