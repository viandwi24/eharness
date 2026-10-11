/**
 * Single-port deployment (Dockerfile): with TEAM_WEB_DIR set, the server also serves the built web
 * app (a SvelteKit SPA, `web/build`) and moves the API under `/api`, the same base path the web
 * uses in dev through the Vite proxy. Unknown paths fall back to `index.html` (client routing).
 */
import { join, normalize, sep } from 'node:path'

export const API_PREFIX = '/api'

export type WebStatic = {
  /** The API request with `/api` stripped, or undefined when the request is for the web app. */
  apiRequest(request: Request): Request | undefined
  /** A file of the web build, or `index.html` for client-side routes. */
  serve(request: Request): Promise<Response>
}

export function webStatic(dir: string): WebStatic {
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
      return new Response(Bun.file(index), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      })
    },
  }
}
