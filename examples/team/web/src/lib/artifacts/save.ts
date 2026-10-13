// "Save as artifact": a fence or a library text file becomes a stored, versioned artifact.
import { artifactsApi, type Artifact, type ArtifactOrigin } from './api.js';
import { fenceArtifact, type FenceKind } from './fences.js';
import { fenceTitle, kindOfPath, loadText, type ViewerInput } from './input.js';
import { basename } from '#lib/files/helpers.js';

export function saveFence(kind: FenceKind, code: string, origin?: ArtifactOrigin): Promise<Artifact> {
	const a = fenceArtifact(kind);
	return artifactsApi.create({ kind: a.kind, title: fenceTitle(kind, code), files: [{ path: a.file, content: code }], ...(origin ? { origin } : {}) });
}

/** A text file of the library; binary files go through the agent (`artifact_create` adopts them, plan P45 R5). */
export async function saveLibraryText(path: string, input: ViewerInput): Promise<Artifact> {
	const content = await loadText(input);
	return artifactsApi.create({ kind: kindOfPath(path), title: basename(path), files: [{ path: basename(path), content }] });
}
