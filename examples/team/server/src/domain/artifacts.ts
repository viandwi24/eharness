/** Artifacts (docs/plans/P45-team-artifacts.md): the shapes the API and the app layer share. Pure. */

export const ARTIFACT_VISIBILITIES = ['private', 'public'] as const
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number]

export const ARTIFACT_LIMITS = {
  /** Per file, bytes. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Per artifact (all files of one version), bytes. */
  maxArtifactBytes: 20 * 1024 * 1024,
  maxFiles: 200,
  /** Versions kept per artifact; older ones are pruned. */
  maxVersions: 100,
  /** How long a signed view URL works (ms). */
  viewUrlTtlMs: 10 * 60 * 1000,
} as const

export interface ArtifactFileView {
  path: string
  size: number
  mediaType: string
}

export interface ArtifactSummary {
  id: string
  kind: string
  title: string
  description: string
  /** The library folder that holds the files. */
  dir: string
  /** The entry file inside `dir`. */
  entry: string
  agentId: string | null
  sessionId: string | null
  version: number
  visibility: ArtifactVisibility
  /** The public link (`<web>/s/<token>`); null while private. */
  shareUrl: string | null
  /** Null: the public link follows the latest version. */
  shareVersion: number | null
  createdAt: number
  updatedAt: number
}

export interface Artifact extends ArtifactSummary {
  files: ArtifactFileView[]
}

export interface ArtifactVersionView {
  n: number
  note: string
  /** `agent:<id>` | `web` */
  by: string
  at: number
  entry: string
  files: ArtifactFileView[]
}

/** A file of a new artifact: text, base64 bytes, or a copy of a library file. */
export interface NewArtifactFile {
  path?: string | undefined
  content?: string | undefined
  base64?: string | undefined
  from?: string | undefined
}

export interface NewArtifact {
  kind: string
  title: string
  description?: string | undefined
  files?: NewArtifactFile[] | undefined
  /** Adopt this library folder as the artifact folder (in place). */
  dir?: string | undefined
  entry?: string | undefined
  origin?:
    | { sessionId?: string | undefined; messageId?: string | undefined; block?: number | undefined }
    | undefined
}

export interface ArtifactPatch {
  title?: string | undefined
  description?: string | undefined
  visibility?: ArtifactVisibility | undefined
  /** `null` = follow the latest version. */
  shareVersion?: number | null | undefined
}

export interface ArtifactExport {
  bytes: Uint8Array
  mediaType: string
  filename: string
}

export interface SignedUrl {
  url: string
  /** Epoch ms. */
  expiresAt: number
}

export interface ArtifactShare {
  artifact: ArtifactSummary
  /** Content URL of the entry file (no login needed). */
  entryUrl: string
  /** Content URL prefix of the artifact folder (append a relative path). */
  baseUrl: string
  files: ArtifactFileView[]
}
