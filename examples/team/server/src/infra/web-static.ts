/**
 * Single-port deployment (Dockerfile): with TEAM_WEB_DIR set, the server also serves the built web
 * app (a SvelteKit SPA, `web/build`) and moves the API under `/api`, the same base path the web
 * uses in dev through the Vite proxy. Unknown paths fall back to `index.html` (client routing).
 */
import { join, normalize, sep } from 'node:path'

export const API_PREFIX = '/api'

/** What a link preview of a public share page shows (`og:*`); undefined = unknown or revoked token. */
export type ShareMeta = { title: string; description: string; kind: string }

export interface WebStaticOptions {
  /** Looks up a public share token for the link preview of `/s/<token>`. */
  shareMeta?: (token: string) => ShareMeta | undefined
  /** Site name of the preview (`og:site_name`). */
  siteName?: string
}

const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]{8,64})\/?$/

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * The app shell with link-preview tags for a public share page: chat apps (Telegram) read `og:*`
 * from the HTML and run no JavaScript, and the web is a SPA. A share page is never indexed.
 */
export function withShareMeta(html: string, meta: ShareMeta | undefined, siteName: string): string {
  const tags = [
    '<meta name="robots" content="noindex" />',
    ...(meta
      ? [
          `<title>${escapeHtml(meta.title)}</title>`,
          `<meta name="description" content="${escapeHtml(meta.description)}" />`,
          '<meta property="og:type" content="website" />',
          `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
          `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
          `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
          '<meta name="twitter:card" content="summary" />',
        ]
      : []),
  ].join('\n\t\t')
  return html.includes('</head>') ? html.replace('</head>', `\t${tags}\n\t</head>`) : html
}

export type WebStatic = {
  /** The API request with `/api` stripped, or undefined when the request is for the web app. */
  apiRequest(request: Request): Request | undefined
  /** A file of the web build, or `index.html` for client-side routes. */
  serve(request: Request): Promise<Response>
}

export function webStatic(dir: string, options: WebStaticOptions = {}): WebStatic {
  const root = normalize(dir)
  const index = join(root, 'index.html')
  return {
    apiRequest(request) {
      const url = new URL(request.url)
      if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`))
        return undefined
      url.pathname = url.pathname.slice(API_PREFIX.length) || '/'
      return new Request(url, request)
    },
    async serve(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json(
          { error: { code: 'NOT_FOUND', message: 'not found' } },
          { status: 404 },
        )
      }
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const target = normalize(join(root, pathname))
      // never leave the build folder (`..` segments, encoded or not)
      if (target === root || target.startsWith(root + sep)) {
        const file = Bun.file(target)
        if (target !== root && (await file.exists())) {
          // hashed assets are immutable; everything else is revalidated
          const immutable = pathname.startsWith('/_app/immutable/')
          return new Response(file, {
            headers: {
              'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
            },
          })
        }
      }
      // a missing asset (`/_app/...`, `/favicon.ico`) is a 404, never the app shell: a stale tab asking
      // for a chunk of an older build must not receive HTML where it expects JavaScript
      if (pathname.startsWith('/_app/') || /\.[a-z0-9]{2,5}$/i.test(pathname)) {
        return Response.json(
          { error: { code: 'NOT_FOUND', message: 'not found' } },
          { status: 404 },
        )
      }
      const share = options.shareMeta ? SHARE_PATH.exec(pathname) : null
      if (share !== null && options.shareMeta) {
        const html = withShareMeta(
          await Bun.file(index).text(),
          options.shareMeta(share[1] ?? ''),
          options.siteName ?? 'Team',
        )
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'x-robots-tag': 'noindex',
            'referrer-policy': 'no-referrer',
          },
        })
      }
      return new Response(Bun.file(index), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      })
    },
  }
}

/**
 * Where the web app lives, for links in channel messages and OAuth redirects: an explicit setting,
 * else `TEAM_WEB_URL`, else (with `TEAM_WEB_DIR` the server serves the web itself) the server's own
 * public URL, else the Vite dev server.
 */
export function resolveWebUrl(input: {
  configured?: string
  env: Record<string, string | undefined>
  publicUrl: string
}): string {
  const explicit = input.configured ?? (input.env.TEAM_WEB_URL?.trim() || undefined)
  // one-port image: the web is the server itself; TEAM_PUBLIC_URL names the API (`…/api`), so the
  // web is that URL without the `/api` suffix (links in agent replies follow the public domain)
  const url =
    explicit ??
    (input.env.TEAM_WEB_DIR ? input.publicUrl.replace(/\/api\/?$/, '') : 'http://localhost:5173')
  return url.replace(/\/$/, '')
}

/**
 * The `env` argument of `app.fetch` for a request that was copied (the `/api` prefix stripped):
 * Bun upgrades a WebSocket only for the request it handed the server, not for a copy, so the
 * upgrade of the live browser view is done on the original request.
 */
export function upgradeEnv<S extends { upgrade: (...args: never[]) => boolean }>(
  original: Request,
  server: S,
): S {
  if (original.headers.get('upgrade')?.toLowerCase() !== 'websocket') return server
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'upgrade') {
        return (_copy: Request, options: unknown): boolean =>
          (target.upgrade as (r: Request, o: unknown) => boolean)(original, options)
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
