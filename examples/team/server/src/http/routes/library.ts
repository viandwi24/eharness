import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  deleteLibraryFile,
  libraryVersions,
  listLibrary,
  moveLibraryFile,
  readLibraryFile,
  writeLibraryFile,
} from '../../app/library.ts'
import { deleteMemoryFile, listMemory, readMemoryFile, writeMemoryFile } from '../../app/memory.ts'
import { applyReorg, previewReorg, proposeReorg } from '../../app/memory-reorg.ts'
import type { Deps } from '../../app/ports.ts'
import { MAX_REQUEST_BYTES, requestLimit } from '../body-limit.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  LibraryDeletedSchema,
  LibraryListSchema,
  LibraryMoveBodySchema,
  LibraryMovedSchema,
  LibraryTextFileSchema,
  LibraryVersionsSchema,
  LibraryWriteBodySchema,
  LibraryWrittenSchema,
  MemoryDeletedSchema,
  MemoryFileSchema,
  MemoryListSchema,
  MemoryScopeSchema,
  MemoryWriteBodySchema,
  MemoryWrittenSchema,
  ReorgPlanSchema,
  ReorgProposalSchema,
  ReorgProposeBodySchema,
  ReorgResultSchema,
  ReorgRowsBodySchema,
} from '../schemas/library.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const raw = (response: Response): never => response as never

const pathQuery = z.string().min(1).max(512).openapi({
  description: 'Absolute path of the file.',
  example: '/library/research/notes.md',
})
const conflictResponse = jsonError(
  '`FILE_EXISTS` or `VERSION_CONFLICT` (`error.details.currentVersion`)',
)

const listRoute = createRoute({
  method: 'get',
  path: '/library',
  tags: ['library'],
  summary: 'List library files with their creator agent',
  description:
    'Every file outside `/memories` (agent artifacts under `/library`, uploads under `/uploads`), by path. Newest changes also arrive as `file-changed` events.',
  security,
  request: {
    query: z.object({
      prefix: z
        .string()
        .max(512)
        .optional()
        .openapi({ description: 'Directory prefix, e.g. `/library/research`. Default `/`.' }),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }),
  },
  responses: {
    200: { description: 'Files', content: json(LibraryListSchema) },
    ...errorResponses,
  },
})

const fileRoute = createRoute({
  method: 'get',
  path: '/library/file',
  tags: ['library'],
  summary: 'Read a file: text inline, binary as a download',
  description:
    'A text file answers JSON `{ file, content }`; a binary file (or `raw=true`) answers the bytes with its media type and `Content-Disposition: attachment` (`inline=true` only for images and PDF).',
  security,
  request: {
    query: z.object({
      path: pathQuery,
      raw: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'Bytes instead of JSON for a text file.' }),
      inline: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'Show images and PDF in the browser.' }),
    }),
  },
  responses: {
    200: {
      description: 'The file',
      content: {
        'application/json': { schema: LibraryTextFileSchema },
        'application/octet-stream': {
          schema: z.string().openapi({ type: 'string', format: 'binary' }),
        },
      },
    },
    404: jsonError('No such file'),
    ...errorResponses,
  },
})

const versionsRoute = createRoute({
  method: 'get',
  path: '/library/versions',
  tags: ['library'],
  summary: 'Change history of a file (metadata only)',
  description:
    'Writes, moves and deletes of the path, newest first, with the version hash, size and who changed it. The content of older versions is not kept.',
  security,
  request: {
    query: z.object({
      path: pathQuery,
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: {
    200: { description: 'History', content: json(LibraryVersionsSchema) },
    ...errorResponses,
  },
})

const putRoute = createRoute({
  method: 'put',
  path: '/library/file',
  tags: ['library'],
  summary: 'Write a text file as the user',
  description:
    'Text up to 1 MB. With `ifVersion` a stale edit loses to an agent write (409 `VERSION_CONFLICT`, `error.details.currentVersion`). Emits `file-changed`.',
  security,
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  request: { body: { required: true, content: json(LibraryWriteBodySchema) } },
  responses: {
    200: { description: 'Written', content: json(LibraryWrittenSchema) },
    409: conflictResponse,
    ...errorResponses,
  },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/library/file',
  tags: ['library'],
  summary: 'Delete a file',
  security,
  request: {
    query: z.object({
      path: pathQuery,
      ifVersion: z.string().optional().openapi({ description: 'Delete only this version.' }),
    }),
  },
  responses: {
    200: { description: 'Deleted', content: json(LibraryDeletedSchema) },
    404: jsonError('No such file'),
    409: conflictResponse,
    ...errorResponses,
  },
})

const moveRoute = createRoute({
  method: 'post',
  path: '/library/move',
  tags: ['library'],
  summary: 'Move or rename a file',
  security,
  request: { body: { required: true, content: json(LibraryMoveBodySchema) } },
  responses: {
    200: { description: 'Moved', content: json(LibraryMovedSchema) },
    404: jsonError('No such file'),
    409: jsonError('`FILE_EXISTS` at the destination or `VERSION_CONFLICT`'),
    ...errorResponses,
  },
})

// --- memory

const scopeQuery = {
  scope: MemoryScopeSchema,
  agentId: z
    .string()
    .optional()
    .openapi({ description: 'Agent id or slug; required for `scope=agent`.' }),
}
const memPath = z.string().min(1).max(300).openapi({
  description: 'Path relative to the scope root.',
  example: 'profile.md',
})

const memListRoute = createRoute({
  method: 'get',
  path: '/memory',
  tags: ['memory'],
  summary: 'Memory files of the workspace or of one agent',
  description:
    'The files the agents read and write with their memory tools: workspace memory (`/memories/workspace`, shared) and per-agent memory (`/memories/agents/<id>`).',
  security,
  request: { query: z.object(scopeQuery) },
  responses: {
    200: { description: 'Files', content: json(MemoryListSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const memGet = createRoute({
  method: 'get',
  path: '/memory/file',
  tags: ['memory'],
  summary: 'Read a memory file',
  security,
  request: { query: z.object({ ...scopeQuery, path: memPath }) },
  responses: {
    200: { description: 'The file', content: json(MemoryFileSchema) },
    404: jsonError('No such file or agent'),
    ...errorResponses,
  },
})

const memPut = createRoute({
  method: 'put',
  path: '/memory/file',
  tags: ['memory'],
  summary: 'Write a memory file as the user',
  description:
    'Same `ifVersion` rules as `PUT /library/file`: a stale edit loses to an agent write.',
  security,
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  request: {
    query: z.object({ ...scopeQuery, path: memPath }),
    body: { required: true, content: json(MemoryWriteBodySchema) },
  },
  responses: {
    200: { description: 'Written', content: json(MemoryWrittenSchema) },
    404: jsonError('Unknown agent'),
    409: conflictResponse,
    ...errorResponses,
  },
})

const memDelete = createRoute({
  method: 'delete',
  path: '/memory/file',
  tags: ['memory'],
  summary: 'Delete a memory file',
  security,
  request: {
    query: z.object({ ...scopeQuery, path: memPath, ifVersion: z.string().optional() }),
  },
  responses: {
    200: { description: 'Deleted', content: json(MemoryDeletedSchema) },
    404: jsonError('No such file or agent'),
    409: conflictResponse,
    ...errorResponses,
  },
})

const reorgProposeRoute = createRoute({
  method: 'post',
  path: '/memory/reorganize/propose',
  tags: ['memory'],
  summary: 'Propose a reorganization of an agent memory',
  description:
    'The agent (its own model, one call per small batch of files) proposes one action per memory file: `keep-as-rule` (merged into rules.md), `move` (a library path), `merge-into` (another file) or `archive`. The answer is already the checked plan (nothing is changed). `HEARTBEAT.md` is never touched. 409 `COMPLETION_UNAVAILABLE` without a model.',
  security,
  request: { body: { required: true, content: json(ReorgProposeBodySchema) } },
  responses: {
    200: { description: 'The proposal', content: json(ReorgProposalSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('`COMPLETION_UNAVAILABLE`'),
    ...errorResponses,
  },
})

const reorgPreviewRoute = createRoute({
  method: 'post',
  path: '/memory/reorganize/preview',
  tags: ['memory'],
  summary: 'Check a reorganization plan',
  description:
    'Runs the deterministic checks on the rows (as proposed or as the owner edited them) and answers the plan: no target outside `/library`, no overwrite of an existing library file (a numeric suffix is added), dated reports to `/library/reports/`, the final target of every row and the diff of `rules.md` and `index.md`. Nothing is changed.',
  security,
  request: { body: { required: true, content: json(ReorgRowsBodySchema) } },
  responses: {
    200: { description: 'The plan', content: json(ReorgPlanSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const reorgApplyRoute = createRoute({
  method: 'post',
  path: '/memory/reorganize/apply',
  tags: ['memory'],
  summary: 'Apply a reorganization of an agent memory',
  description:
    'A verified backup (`before: memory reorganization`) is taken first: when it fails nothing is changed (`BACKUP_FAILED`). Then the new library files are created and read back, `rules.md` and `index.md` are rewritten, and the original memory files are moved (never deleted) to `/library/archive/memory/<agent>/original/`. A restore point is recorded: undo it with `POST /backups/restore-points/{id}/undo` flow. A plan with errors answers 400 `REORG_PLAN_INVALID`.',
  security,
  request: { body: { required: true, content: json(ReorgRowsBodySchema) } },
  responses: {
    200: { description: 'What was done', content: json(ReorgResultSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('`BACKUP_FAILED`'),
    ...errorResponses,
  },
})

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/

export function libraryRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(reorgProposeRoute, async (c) =>
      c.json((await proposeReorg(deps, c.req.valid('json').agentId)) as never, 200),
    )
    .openapi(reorgPreviewRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json((await previewReorg(deps, body.agentId, body.rows)) as never, 200)
    })
    .openapi(reorgApplyRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json((await applyReorg(deps, body.agentId, body.rows)) as never, 200)
    })
    .openapi(listRoute, (c) => {
      const { prefix, limit } = c.req.valid('query')
      return c.json(
        { files: listLibrary(deps, { ...(prefix === undefined ? {} : { prefix }), limit }) },
        200,
      )
    })
    .openapi(fileRoute, async (c) => {
      const q = c.req.valid('query')
      const { entry, text, bytes } = await readLibraryFile(deps, q.path)
      if (text !== null && q.raw !== 'true') return c.json({ file: entry, content: text }, 200)
      const body = bytes ?? new TextEncoder().encode(text ?? '')
      const mediaType = entry.mediaType ?? 'application/octet-stream'
      const name = entry.path.split('/').pop() ?? 'file'
      const inline = q.inline === 'true' && SAFE_INLINE.test(mediaType)
      return raw(
        new Response(body as unknown as BodyInit, {
          headers: {
            'content-type': mediaType,
            'content-length': String(body.byteLength),
            'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
            'x-content-type-options': 'nosniff',
            etag: `"${entry.version}"`,
          },
        }),
      )
    })
    .openapi(versionsRoute, (c) => {
      const { path, limit } = c.req.valid('query')
      return c.json(libraryVersions(deps, path, limit) as never, 200)
    })
    .openapi(putRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json(await writeLibraryFile(deps, body.path, body.content, body.ifVersion), 200)
    })
    .openapi(deleteRoute, async (c) => {
      const { path, ifVersion } = c.req.valid('query')
      return c.json(await deleteLibraryFile(deps, path, ifVersion), 200)
    })
    .openapi(moveRoute, async (c) => {
      const body = c.req.valid('json')
      return c.json(await moveLibraryFile(deps, body.from, body.to, body.ifVersion), 200)
    })
    .openapi(memListRoute, (c) => {
      const { scope, agentId } = c.req.valid('query')
      return c.json(listMemory(deps, scope, agentId), 200)
    })
    .openapi(memGet, async (c) => {
      const { scope, agentId, path } = c.req.valid('query')
      return c.json(await readMemoryFile(deps, scope, agentId, path), 200)
    })
    .openapi(memPut, async (c) => {
      const { scope, agentId, path } = c.req.valid('query')
      const body = c.req.valid('json')
      return c.json(
        await writeMemoryFile(deps, scope, agentId, path, body.content, body.ifVersion),
        200,
      )
    })
    .openapi(memDelete, async (c) => {
      const { scope, agentId, path, ifVersion } = c.req.valid('query')
      return c.json(await deleteMemoryFile(deps, scope, agentId, path, ifVersion), 200)
    })
}
