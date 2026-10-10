/** Library and upload path conventions. Pure. */
export const LIBRARY_ROOT = '/library'
export const UPLOADS_ROOT = '/uploads'

export interface LibraryFileMeta {
  path: string
  version: string
  size: number
  mediaType: string | null
  createdByAgentId: string | null
  updatedAt: number
}
