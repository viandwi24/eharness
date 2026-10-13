import { z } from '@hono/zod-openapi'

export const ArtifactFileSchema = z
  .object({ path: z.string(), size: z.number().int(), mediaType: z.string() })
  .openapi('ArtifactFile')

export const ArtifactSummarySchema = z
  .object({
    id: z.string(),
    kind: z.string().openapi({
      description:
        'html, document, image, mermaid, code, data or file (an unknown kind renders as file).',
    }),
    title: z.string(),
    description: z.string(),
    dir: z.string().openapi({
      description: 'The library folder with the files. Empty on the public share page.',
    }),
    entry: z.string().openapi({ description: 'The main file inside `dir`.' }),
    agentId: z.string().nullable(),
    sessionId: z.string().nullable(),
    version: z.number().int().openapi({ description: 'The current (latest) version number.' }),
    visibility: z.enum(['private', 'public']),
    shareUrl: z
      .string()
      .nullable()
      .openapi({ description: 'The public page `<web>/s/<token>`; null while private.' }),
    shareVersion: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'null = the public link follows the latest version.' }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('ArtifactSummary')

export const ArtifactSchema = ArtifactSummarySchema.extend({
  files: z.array(ArtifactFileSchema).openapi({ description: 'The files of the current version.' }),
}).openapi('Artifact')

export const ArtifactListSchema = z
  .object({ items: z.array(ArtifactSummarySchema), nextCursor: z.string().nullable() })
  .openapi('ArtifactList')

export const ArtifactVersionSchema = z
  .object({
    n: z.number().int(),
    note: z.string(),
    by: z.string().openapi({ description: '`agent:<id>` or `web`.' }),
    at: z.number().int(),
    entry: z.string(),
    files: z.array(ArtifactFileSchema),
  })
  .openapi('ArtifactVersion')

export const ArtifactVersionsSchema = z.array(ArtifactVersionSchema).openapi('ArtifactVersions')

export const ArtifactViewUrlBodySchema = z
  .object({
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .openapi({ description: 'Default: the current version.' }),
    path: z
      .string()
      .max(200)
      .optional()
      .openapi({ description: 'A file inside the folder; default: the entry.' }),
  })
  .openapi('ArtifactViewUrlBody')

export const SignedUrlSchema = z
  .object({
    url: z.string().openapi({
      description:
        'Absolute content URL (`/art/v/<id>/<version>/~<token>/<path>`; relative links inside a page keep working). No cookie needed.',
    }),
    expiresAt: z
      .number()
      .int()
      .openapi({ description: 'Epoch ms; ask again after it (a 403 means expired).' }),
  })
  .openapi('SignedUrl')

export const ArtifactCreateBodySchema = z
  .object({
    kind: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(200),
          content: z.string().optional(),
          base64: z.string().optional(),
        }),
      )
      .max(60)
      .default([]),
    entry: z.string().max(200).optional(),
    origin: z
      .object({
        sessionId: z.string().optional(),
        messageId: z.string().optional(),
        block: z.number().int().min(0).optional(),
      })
      .optional()
      .openapi({ description: 'Where it came from ("Save as artifact" of a fence in a message).' }),
  })
  .openapi('ArtifactCreateBody')

export const ArtifactPatchBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    visibility: z.enum(['private', 'public']).optional().openapi({
      description: 'private -> public issues a NEW link; public -> private kills it.',
    }),
    shareVersion: z.number().int().min(1).nullable().optional().openapi({
      description:
        'Pin the public link to a version; null = follow the latest. Public artifacts only.',
    }),
  })
  .openapi('ArtifactPatchBody')

export const ArtifactEntryBodySchema = z
  .object({
    content: z.string(),
    ifVersion: z.string().nullable().optional().openapi({
      description:
        'The library version of the entry file you edited (`GET /library/file`). A stale edit gets 409 `VERSION_CONFLICT` (`error.details.currentVersion`).',
    }),
  })
  .openapi('ArtifactEntryBody')

export const ArtifactDeletedSchema = z.object({ id: z.string() }).openapi('ArtifactDeleted')

export const ArtifactShareSchema = z
  .object({
    artifact: ArtifactSummarySchema,
    entryUrl: z
      .string()
      .openapi({ description: 'Public content URL of the entry file (CORS open, no login).' }),
    baseUrl: z.string().openapi({
      description: 'Public content URL prefix of the folder; append a relative file path.',
    }),
    files: z.array(ArtifactFileSchema),
  })
  .openapi('ArtifactShare')

export const LibraryViewUrlBodySchema = z
  .object({ path: z.string().min(1).max(512) })
  .openapi('LibraryViewUrlBody')
