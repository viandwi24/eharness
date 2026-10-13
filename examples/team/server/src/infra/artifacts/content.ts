/**
 * The content routes of artifacts (`/art/*`, docs/plans/P45-team-artifacts.md "Content origin"),
 * served outside `/api`, on the main server or alone on `TEAM_ARTIFACT_PORT`.
 *
 *   /art/v/<artifactId>/<version>/~<token>/<path>   signed view of a version (10 minutes); the token
 *                                                  is a path segment so relative links inside the
 *                                                  page keep working; `?t=<token>` also works
 *   /art/s/<shareToken>/<path>                      public content (the shared version)
 *   /art/l/<token>/<library path>                   signed raw view of one library file
 *
 * Access never depends on cookies. Every response carries a `Content-Security-Policy: sandbox ...`
 * so even a direct top-level open is an opaque origin with no network, plus `nosniff`, no referrer
 * and no indexing. HTML gets a small postMessage bridge (resize, error, ready) for the web app.
 */
import { Hono } from 'hono'
import { baseMediaType } from '../../../../shared/artifacts/kinds.ts'
import type { ArtifactService } from './service.ts'

const CDN = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com']
const cdnSources = CDN.map((h) => `https://${h}`).join(' ')

/** The CSP of every content response. */
export const CONTENT_CSP = [
  'sandbox allow-scripts allow-popups allow-forms allow-modals',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'self' ${cdnSources}`,
  `style-src 'unsafe-inline' 'self' ${cdnSources} https://fonts.googleapis.com`,
  `img-src data: blob: 'self' ${cdnSources}`,
  `font-src data: 'self' ${cdnSources} https://fonts.gstatic.com`,
  `media-src data: blob: 'self'`,
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

export const CONTENT_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_CSP,
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  // fonts and module scripts are CORS fetches from an opaque origin; the token is the credential
  'access-control-allow-origin': '*',
  'cache-control': 'private, max-age=60',
}

/** The bridge the web app listens to; `event.source` is checked on the parent side (origin is null). */
export const BRIDGE_SCRIPT = `<script>(function(){var P=window.parent;if(!P||P===window)return;function s(m){try{P.postMessage(Object.assign({source:'eh-artifact'},m),'*')}catch(e){}}
function h(){var d=document.documentElement,b=document.body;return Math.ceil(Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0))}
var last=0;function r(){var n=h();if(n!==last){last=n;s({type:'resize',height:n})}}
window.addEventListener('error',function(e){s({type:'error',message:String(e&&e.message||'error'),source:String(e&&e.filename||''),line:e&&e.lineno||0})});
window.addEventListener('unhandledrejection',function(e){var x=e&&e.reason;s({type:'error',message:String(x&&x.message||x||'unhandled rejection')})});
window.addEventListener('load',function(){s({type:'ready',height:h()});r();if(window.ResizeObserver&&document.body)new ResizeObserver(r).observe(document.body);else setInterval(r,500)});
})()</script>`

/** Put the bridge first in the document so it sees errors of every later script. */
export function injectBridge(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head !== null) {
    const at = (head.index ?? 0) + head[0].length
    return `${html.slice(0, at)}${BRIDGE_SCRIPT}${html.slice(at)}`
  }
  const root = /<html[^>]*>/i.exec(html)
  if (root !== null) {
    const at = (root.index ?? 0) + root[0].length
    return `${html.slice(0, at)}<head>${BRIDGE_SCRIPT}</head>${html.slice(at)}`
  }
  return `${BRIDGE_SCRIPT}${html}`
}

const plain = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: {
      ...CONTENT_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })

function respond(
  c: { bytes: Uint8Array; mediaType: string; path: string },
  download: boolean,
): Response {
  const type = baseMediaType(c.mediaType)
  let body: Uint8Array | string = c.bytes
  if (type === 'text/html') body = injectBridge(new TextDecoder().decode(c.bytes))
  const name = c.path.slice(c.path.lastIndexOf('/') + 1)
  const headers: Record<string, string> = {
    ...CONTENT_HEADERS,
    'content-type': c.mediaType,
  }
  if (download) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
  }
  return new Response(body as BodyInit, { headers })
}

const decodePath = (raw: string): string | undefined => {
  try {
    const path = raw
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/')
    if (path.split('/').some((s) => s === '..' || s === '.' || s.includes('\\'))) return undefined
    return path
  } catch {
    return undefined
  }
}

/** The request path after `/art/<kind>/` and `skip` further segments (index 2 + skip of the split). */
function rest(pathname: string, skip: number): string {
  return pathname
    .split('/')
    .slice(2 + skip)
    .join('/')
}

export function artifactContentRoutes(service: ArtifactService): Hono {
  const app = new Hono()

  app.options(
    '/art/*',
    () =>
      new Response(null, {
        status: 204,
        headers: {
          ...CONTENT_HEADERS,
          'access-control-allow-methods': 'GET, HEAD',
          'access-control-max-age': '600',
        },
      }),
  )

  app.on(['GET', 'HEAD'], '/art/v/:id/:version/*', async (c) => {
    const id = c.req.param('id')
    const version = Number(c.req.param('version'))
    if (!Number.isInteger(version) || version < 1) return plain(404, 'not found')
    const url = new URL(c.req.url)
    let segments = rest(url.pathname, 3)
    let token = url.searchParams.get('t') ?? ''
    if (segments.startsWith('~')) {
      const slash = segments.indexOf('/')
      token = decodeURIComponent(slash < 0 ? segments.slice(1) : segments.slice(1, slash))
      segments = slash < 0 ? '' : segments.slice(slash + 1)
    }
    if (token === '' || !(await service.verifyView(id, version, token))) {
      return plain(403, 'this link has expired or is not valid')
    }
    const path = decodePath(segments)
    if (path === undefined) return plain(404, 'not found')
    const found = service.contentOfVersion(id, version, path)
    if (found === undefined) return plain(404, 'not found')
    return respond(found, url.searchParams.get('download') === '1')
  })

  app.on(['GET', 'HEAD'], '/art/s/:token/*', (c) => {
    const url = new URL(c.req.url)
    const path = decodePath(rest(url.pathname, 2))
    if (path === undefined) return plain(404, 'not found')
    const found = service.contentOfShare(c.req.param('token'), path)
    if (found === undefined) return plain(404, 'not found')
    return respond(found, url.searchParams.get('download') === '1')
  })

  app.on(['GET', 'HEAD'], '/art/l/:token/*', async (c) => {
    const url = new URL(c.req.url)
    const raw = decodePath(rest(url.pathname, 2))
    if (raw === undefined) return plain(404, 'not found')
    const path = `/${raw}`
    if (!(await service.verifyLibrary(path, decodeURIComponent(c.req.param('token'))))) {
      return plain(403, 'this link has expired or is not valid')
    }
    const found = await service.contentOfLibrary(path)
    if (found === undefined) return plain(404, 'not found')
    return respond({ ...found, path }, url.searchParams.get('download') === '1')
  })

  return app
}
