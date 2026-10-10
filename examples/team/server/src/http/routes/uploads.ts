import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { uploadFile } from '../../app/chat.ts'
import type { Deps } from '../../app/ports.ts'
import { MAX_REQUEST_BYTES, requestLimit } from '../body-limit.ts'
import { UploadFormSchema, UploadResultSchema } from '../schemas/chat.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'

const upload = createRoute({
  method: 'post',
  path: '/library/files',
  tags: ['library'],
  summary: 'Upload a file into the library (/uploads)',
  description:
    'Multipart form with one `file` field (max 10 MB; images, PDF, text, Markdown, CSV, JSON). The file is stored under `/uploads/<day>/…` in the shared library, so agents can read it. Attach it to a message with a `file` part whose `url` is the returned `url`.',
  security: [{ Bearer: [] }],
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  request: {
    body: { required: true, content: { 'multipart/form-data': { schema: UploadFormSchema } } },
  },
  responses: {
    201: {
      description: 'The stored file',
      content: { 'application/json': { schema: UploadResultSchema } },
    },
    413: jsonError('File too large'),
    ...errorResponses,
  },
})

export function uploadRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono().openapi(upload, async (c) => {
    const { file } = c.req.valid('form')
    const stored = await uploadFile(deps, {
      name: file.name,
      mediaType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })
    return c.json(stored, 201)
  })
}
