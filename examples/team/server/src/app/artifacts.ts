/** Artifact use cases (docs/plans/P45-team-artifacts.md): thin over the `ArtifactsPort`. */
import type {
  Artifact,
  ArtifactExport,
  ArtifactPatch,
  ArtifactShare,
  ArtifactSummary,
  ArtifactVersionView,
  NewArtifact,
  SignedUrl,
} from '../domain/artifacts.ts'
import { invalid, notFound } from '../domain/errors.ts'
import { assertLibraryPath, normalizeFilePath } from '../domain/library.ts'
import type { Deps } from './ports.ts'

export function listArtifacts(
  deps: Deps,
  query: Parameters<Deps['artifacts']['list']>[0],
): { items: ArtifactSummary[]; nextCursor: string | null } {
  return deps.artifacts.list(query)
}

export function getArtifact(deps: Deps, id: string): Artifact {
  const found = deps.artifacts.get(id)
  if (found === undefined) throw notFound('artifact', id)
  return found
}

export function artifactVersions(deps: Deps, id: string): ArtifactVersionView[] {
  const found = deps.artifacts.versions(id)
  if (found === undefined) throw notFound('artifact', id)
  return found
}

export function artifactViewUrl(
  deps: Deps,
  id: string,
  opts: { version?: number | undefined; path?: string | undefined },
): Promise<SignedUrl> {
  return deps.artifacts.viewUrl(id, opts)
}

export function createArtifact(deps: Deps, input: NewArtifact): Promise<Artifact> {
  if ((input.files ?? []).length === 0 && input.dir === undefined) {
    throw invalid('an artifact needs files (or an existing library folder as `dir`)', 'NO_FILES')
  }
  return deps.artifacts.create(input)
}

export function patchArtifact(deps: Deps, id: string, patch: ArtifactPatch): Promise<Artifact> {
  return deps.artifacts.patch(id, patch)
}

export function saveArtifactEntry(
  deps: Deps,
  id: string,
  content: string,
  ifVersion: string | null | undefined,
): Promise<Artifact> {
  return deps.artifacts.saveEntry(id, content, ifVersion)
}

export function exportArtifact(
  deps: Deps,
  id: string,
  format: string,
  version?: number,
): Promise<ArtifactExport> {
  return deps.artifacts.exportOf(id, format, version)
}

export function deleteArtifact(deps: Deps, id: string): { id: string } {
  deps.artifacts.remove(id)
  return { id }
}

export function getShare(deps: Deps, token: string): ArtifactShare {
  const found = deps.artifacts.share(token)
  if (found === undefined) throw notFound('shared artifact', 'link')
  return found
}

/** A signed raw view of a library file (never memory files). */
export function libraryViewUrl(deps: Deps, rawPath: string): Promise<SignedUrl> {
  const path = normalizeFilePath(rawPath)
  assertLibraryPath(path)
  return deps.artifacts.libraryViewUrl(path)
}
