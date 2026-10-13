import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  artifactVersions,
  artifactViewUrl,
  createArtifact,
  deleteArtifact,
  exportArtifact,
  getArtifact,
  getShare,
  libraryViewUrl,
  listArtifacts,
  patchArtifact,
  saveArtifactEntry,
} from '../../app/artifacts.ts'
import type { Deps } from '../../app/ports.ts'
import { MAX_REQUEST_BYTES, requestLimit } from '../body-limit.ts'
import {
  ArtifactCreateBodySchema,
  ArtifactDeletedSchema,
  ArtifactEntryBodySchema,
  ArtifactListSchema,
  ArtifactPatchBodySchema,
  ArtifactSchema,
  ArtifactShareSchema,
  ArtifactVersionsSchema,
  ArtifactViewUrlBodySchema,
  LibraryViewUrlBodySchema,
  SignedUrlSchema,
} from '../schemas/artifacts.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const raw = (response: Response): never => response as never

const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Artifact id.' }),
})

const listRoute = createRoute({
  method: 'get',
  path: '/artifacts',
  tags: ['artifacts'],
  summary: 'List artifacts (newest change first)',
  security,
  request: {
    query: z.object({
      query: z
        .string()
        .max(200)
        .optional()
        .openapi({ description: 'Words from the title or description.' }),
      kind: z.string().max(40).optional(),
      agentId: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: { description: 'Artifacts', content: json(ArtifactListSchema) },
    ...errorResponses,
  },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/artifacts',
  tags: ['artifacts'],
  summary: 'Create an artifact from text files (the web "Save as artifact")',
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  security,
  request: { body: { required: true, content: json(ArtifactCreateBodySchema) } },
  responses: {
    200: { description: 'Created (private, version 1)', content: json(ArtifactSchema) },
    ...errorResponses,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}',
  tags: ['artifacts'],
  summary: 'One artifact with its files',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The artifact', content: json(ArtifactSchema) },
    404: jsonError('No such artifact'),
    ...errorResponses,
  },
})

const versionsRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/versions',
  tags: ['artifacts'],
  summary: 'Versions, newest first',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Versions', content: json(ArtifactVersionsSchema) },
    404: jsonError('No such artifact'),
    ...errorResponses,
  },
})

const viewUrlRoute = createRoute({
  method: 'post',
  path: '/artifacts/{id}/view-url',
  tags: ['artifacts'],
  summary: 'A short-lived signed content URL (10 minutes) of a version of the entry or of one file',
  description:
    'Content is served outside `/api` by the content routes with a sandbox CSP; the URL needs no cookie. Bound to the artifact and the version. Embed it in an iframe with `sandbox="allow-scripts allow-popups allow-forms allow-modals"` (never `allow-same-origin`). An HTML page posts `{ source: "eh-artifact", type: "resize" | "error" | "ready", ... }` to the parent.',
  security,
  request: { params: IdParam, body: { required: false, content: json(ArtifactViewUrlBodySchema) } },
  responses: {
    200: { description: 'Signed URL', content: json(SignedUrlSchema) },
    404: jsonError('No such artifact, version or file'),
    ...errorResponses,
  },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/artifacts/{id}',
  tags: ['artifacts'],
  summary: 'Rename, change visibility or pin the public version',
  description:
    'private -> public issues a new share token; public -> private clears it (the old link answers 404). The signed-in app may always publish.',
  security,
  request: { params: IdParam, body: { required: true, content: json(ArtifactPatchBodySchema) } },
  responses: {
    200: { description: 'The artifact', content: json(ArtifactSchema) },
    404: jsonError('No such artifact'),
    ...errorResponses,
  },
})

const entryRoute = createRoute({
  method: 'put',
  path: '/artifacts/{id}/entry',
  tags: ['artifacts'],
  summary: 'Editor save: write the entry file (compare-and-set) and make a version by the web',
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  security,
  request: { params: IdParam, body: { required: true, content: json(ArtifactEntryBodySchema) } },
  responses: {
    200: { description: 'The artifact with the new version', content: json(ArtifactSchema) },
    404: jsonError('No such artifact'),
    409: jsonError('`VERSION_CONFLICT` (`error.details.currentVersion`)'),
    ...errorResponses,
  },
})

const exportRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/export/{format}',
  tags: ['artifacts'],
  summary: 'Download an export (html, zip, md, csv, json, mmd, original ...)',
  description:
    'Formats are the `exports` of the kind (`shared/artifacts/kinds.ts`) plus `zip` for any artifact. Formats marked client-side (PDF, PNG of SVG, SVG of a diagram) are produced in the browser and answer 400 here.',
  security,
  request: {
    params: IdParam.extend({
      format: z
        .string()
        .min(1)
        .max(20)
        .openapi({ param: { name: 'format', in: 'path' } }),
    }),
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
  },
  responses: {
    200: {
      description: 'The file',
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
    },
    404: jsonError('No such artifact'),
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/artifacts/{id}',
  tags: ['artifacts'],
  summary: 'Delete an artifact (soft; its public link stops working, the library files stay)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Deleted', content: json(ArtifactDeletedSchema) },
    404: jsonError('No such artifact'),
    ...errorResponses,
  },
})

const shareRoute = createRoute({
  method: 'get',
  path: '/share/{token}',
  tags: ['artifacts'],
  summary: 'Public: metadata of a shared artifact (no login)',
  description:
    'An unknown or revoked token answers 404 with no detail. The shared version is the pinned one, else the latest.',
  request: {
    params: z.object({
      token: z
        .string()
        .min(8)
        .max(100)
        .openapi({ param: { name: 'token', in: 'path' } }),
    }),
  },
  responses: {
    200: { description: 'The shared artifact', content: json(ArtifactShareSchema) },
    404: jsonError('Unknown or revoked link'),
  },
})

const libraryViewRoute = createRoute({
  method: 'post',
  path: '/library/view-url',
  tags: ['library'],
  summary: 'A short-lived signed raw view URL of a library file (thumbnails of run_python outputs)',
  security,
  request: { body: { required: true, content: json(LibraryViewUrlBodySchema) } },
  responses: {
    200: { description: 'Signed URL', content: json(SignedUrlSchema) },
    ...errorResponses,
  },
})

export function artifactRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(listRoute, (c) => c.json(listArtifacts(deps, c.req.valid('query')), 200))
    .openapi(createRouteDef, async (c) => {
      const body = c.req.valid('json')
      return c.json(await createArtifact(deps, body), 200)
    })
    .openapi(getRoute, (c) => c.json(getArtifact(deps, c.req.valid('param').id), 200))
    .openapi(versionsRoute, (c) => c.json(artifactVersions(deps, c.req.valid('param').id), 200))
    .openapi(viewUrlRoute, async (c) => {
      const body = c.req.valid('json') ?? {}
      return c.json(await artifactViewUrl(deps, c.req.valid('param').id, body), 200)
    })
    .openapi(patchRoute, async (c) =>
      c.json(await patchArtifact(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(entryRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json(
        await saveArtifactEntry(deps, c.req.valid('param').id, body.content, body.ifVersion),
        200,
      )
    })
    .openapi(exportRoute, async (c) => {
      const { id, format } = c.req.valid('param')
      const out = await exportArtifact(deps, id, format, c.req.valid('query').version)
      return raw(
        new Response(out.bytes as unknown as BodyInit, {
          headers: {
            'content-type': out.mediaType,
            'content-length': String(out.bytes.byteLength),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
            'x-content-type-options': 'nosniff',
          },
        }),
      )
    })
    .openapi(deleteRoute, (c) => c.json(deleteArtifact(deps, c.req.valid('param').id), 200))
    .openapi(shareRoute, (c) => c.json(getShare(deps, c.req.valid('param').token), 200))
    .openapi(libraryViewRoute, async (c) =>
      c.json(await libraryViewUrl(deps, c.req.valid('json').path), 200),
    )
}
