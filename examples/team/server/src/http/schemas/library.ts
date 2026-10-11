import { z } from '@hono/zod-openapi'

const CreatedBy = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .nullable()
  .openapi({
    description: 'The agent that wrote the file last; null = a person (an upload or the editor).',
  })

export const LibraryEntrySchema = z
  .object({
    path: z.string().openapi({ example: '/library/research/notes.md' }),
    version: z.string().openapi({ description: 'Content hash; pass it as `ifVersion`.' }),
    size: z.number().int(),
    mediaType: z.string().nullable(),
    binary: z.boolean(),
    createdByAgentId: z.string().nullable(),
    createdBy: CreatedBy,
    updatedAt: z.number().int(),
  })
  .openapi('LibraryEntry')

export const LibraryListSchema = z
  .object({ files: z.array(LibraryEntrySchema) })
  .openapi('LibraryList')

export const LibraryTextFileSchema = z
  .object({ file: LibraryEntrySchema, content: z.string() })
  .openapi('LibraryTextFile')

export const LibraryVersionSchema = z
  .object({
    seq: z.number().int(),
    action: z.enum(['write', 'delete', 'move']),
    version: z.string().nullable(),
    size: z.number().int().nullable(),
    fromPath: z.string().nullable(),
    agentId: z.string().nullable(),
    by: CreatedBy.openapi({ description: 'Who made the change; null = a person.' }),
    at: z.number().int(),
  })
  .openapi('LibraryVersion')

export const LibraryVersionsSchema = z
  .object({ path: z.string(), versions: z.array(LibraryVersionSchema) })
  .openapi('LibraryVersions')

export const LibraryWriteBodySchema = z
  .object({
    path: z.string().min(1).max(512),
    content: z.string(),
    ifVersion: z.string().nullable().optional().openapi({
      description:
        'Omitted: overwrite. `null`: create only (409 `FILE_EXISTS`). A version: write only when the file still has it (409 `VERSION_CONFLICT`, `details.currentVersion`).',
    }),
  })
  .openapi('LibraryWriteBody')

export const LibraryWrittenSchema = z
  .object({ path: z.string(), version: z.string() })
  .openapi('LibraryWritten')

export const LibraryMoveBodySchema = z
  .object({
    from: z.string().min(1).max(512),
    to: z.string().min(1).max(512),
    ifVersion: z.string().optional(),
  })
  .openapi('LibraryMoveBody')

export const LibraryMovedSchema = z
  .object({ from: z.string(), to: z.string() })
  .openapi('LibraryMoved')

export const LibraryDeletedSchema = z.object({ path: z.string() }).openapi('LibraryDeleted')

// --- memory

export const MemoryScopeSchema = z.enum(['workspace', 'agent']).openapi('MemoryScope')

export const MemoryFileInfoSchema = z
  .object({
    path: z.string().openapi({ description: 'Relative to the scope root.', example: 'profile.md' }),
    version: z.string(),
    size: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('MemoryFileInfo')

export const MemoryListSchema = z
  .object({
    scope: MemoryScopeSchema,
    agentId: z.string().nullable(),
    root: z.string(),
    files: z.array(MemoryFileInfoSchema),
  })
  .openapi('MemoryList')

export const MemoryFileSchema = z
  .object({
    scope: MemoryScopeSchema,
    agentId: z.string().nullable(),
    path: z.string(),
    version: z.string(),
    size: z.number().int(),
    updatedAt: z.number().int(),
    content: z.string(),
  })
  .openapi('MemoryFile')

export const MemoryWriteBodySchema = z
  .object({
    content: z.string(),
    ifVersion: z.string().nullable().optional(),
  })
  .openapi('MemoryWriteBody')

export const MemoryWrittenSchema = z
  .object({
    scope: MemoryScopeSchema,
    agentId: z.string().nullable(),
    path: z.string(),
    version: z.string(),
  })
  .openapi('MemoryWritten')

export const MemoryDeletedSchema = z
  .object({ scope: MemoryScopeSchema, agentId: z.string().nullable(), path: z.string() })
  .openapi('MemoryDeleted')
